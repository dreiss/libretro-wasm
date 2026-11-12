// Smoke test for a built core: node test/smoke.mjs dist/snes9x
//
// Assembles test/rom/test.s (with ca65 and ld65, from cc65)
// into a 32 KiB SNES test program (no game data)
// whose memory, picture, and sound react to the joypad
// in simple, predictable ways (see test.s).
// Then checks the API, that the program's memory, video, and audio
// respond to input exactly as expected,
// that two fresh instances agree byte for byte,
// and that a save state restores exactly.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LibretroCore, Memory, RetroPad } from "../frontend/libretro-core.js";

const dist = process.argv[2] || "dist/snes9x";
const { default: createCore } = await import(pathToFileURL(path.resolve(dist, "snes9x_core.mjs")).href);

function assembleTestRom() {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "rom");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libretro-wasm-test-"));
  try {
    execFileSync("ca65", ["-o", path.join(tmp, "test.o"), path.join(src, "test.s")], { stdio: "inherit" });
    execFileSync("ld65", ["-C", path.join(src, "lorom.cfg"), "-o", path.join(tmp, "test.sfc"), path.join(tmp, "test.o")],
                 { stdio: "inherit" });
    const rom = new Uint8Array(fs.readFileSync(path.join(tmp, "test.sfc")));
    // Header checksum. The assembled header holds $FFFF and $0000,
    // which add up the same as any checksum and its complement.
    const sum = rom.reduce((s, b) => (s + b) & 0xffff, 0);
    rom.set([~sum & 0xff, (~sum >> 8) & 0xff, sum & 0xff, sum >> 8], 0x7fdc);
    return rom;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const check = (ok, what) => { if (!ok) { console.error(`FAIL: ${what}`); process.exit(1); } console.log(`ok: ${what}`); };

const rom = assembleTestRom();
check(rom.length === 0x8000, "test ROM assembled (32 KiB)");

async function boot() {
  const core = await LibretroCore.create(createCore);
  core.load(rom);
  core.memory(Memory.SYSTEM_RAM).fill(0);
  return core;
}

// What the test program shows for given RetroPad buttons.
const { A, B, X, Y, UP } = RetroPad;
function expected(buttons) {
  // The joypad word the SNES reads ($4218): B Y Sel Start Up Down Left Right A X L R 0 0 0 0
  const order = ["B", "Y", "SELECT", "START", "UP", "DOWN", "LEFT", "RIGHT", "A", "X", "L", "R"];
  let joy = 0;
  order.forEach((name, i) => { if (buttons & RetroPad[name]) joy |= 0x8000 >> i; });
  const color = [buttons & A ? 255 : 0, buttons & X ? 255 : 0, buttons & Y ? 255 : 0];
  const tone = buttons & B ? (buttons & UP ? 4000 : 2000) : 0;
  return { joy, color, tone };
}

// Whether every line is black at x < 64 and x > 191 and `color` in between.
function frameIs(f, color) {
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const c = x >= 64 && x <= 191 ? color : [0, 0, 0], i = (y * f.width + x) * 4;
      if (f.data[i] !== c[0] || f.data[i + 1] !== c[1] || f.data[i + 2] !== c[2]) {
        return `(${f.data.subarray(i, i + 3).join(",")}) at ${x},${y}`;
      }
    }
  }
  return "";
}

// The frequency of a tone, from the first and last rising zero crossings
// of the left channel, and whether both channels are identical.
function measure(audio, sampleRate) {
  const rising = [];
  for (let i = 2; i < audio.length; i += 2) if (audio[i - 2] < 0 && audio[i] >= 0) rising.push(i / 2);
  let same = true;
  for (let i = 0; i < audio.length; i += 2) if (audio[i] !== audio[i + 1]) same = false;
  const hz = rising.length > 2 ? (rising.length - 1) * sampleRate / (rising.at(-1) - rising[0]) : 0;
  return { hz, same, peak: audio.reduce((m, s) => Math.max(m, Math.abs(s)), 0) };
}

// --- The API, with no input ---
const a = await boot();
for (let i = 0; i < 120; i++) a.run(0);
const ram = a.memory(Memory.SYSTEM_RAM);
const word = (addr) => ram[addr] | (ram[addr + 1] << 8);
check(ram && ram.length === 0x20000, `work RAM is 128 KiB (${ram && ram.length})`);
check(a.framesRun === 120, "120 frames run");
check(Math.abs(a.fps - 60.0988) < 0.01, `NTSC frame rate (${a.fps.toFixed(4)})`);
const f0 = a.frameRGBA();
check(f0 && f0.width === 256 && f0.height === 224, `frame size ${f0 && f0.width}x${f0 && f0.height}`);
check(a.audio().length > 0 && a.sampleRate > 0, `audio: ${a.audio().length / 2} frames at ${a.sampleRate} Hz`);
// The first frame is spent starting up, before frame interrupts are on.
check(word(0x12) === 119, `the test program counted 119 frames (RAM $12 = ${word(0x12)})`);

// --- Input: memory, video, and audio ---
// Each step holds `buttons` for `frames` frames.
// Memory and video follow the input in the same frame.
// The tone starts in the frame B is pressed,
// but is only measured from the second frame (the first is partial),
// and it fades out over the frame after B is released.
const steps = [
  { buttons: 0, frames: 2 },
  { buttons: A, frames: 2 },
  { buttons: X, frames: 2 },
  { buttons: Y, frames: 2 },
  { buttons: A | X | Y, frames: 2 },
  { buttons: B, frames: 3 },
  { buttons: B | UP, frames: 3 },
  { buttons: B | A, frames: 2 },
  { buttons: 0, frames: 3 },
  { buttons: B, frames: 3 },
  { buttons: UP, frames: 3 },
];
let frames = word(0x12), presses = word(0x14), prev = 0, sinceRelease = 99;
for (const { buttons, frames: n } of steps) {
  const want = expected(buttons), name = `buttons ${buttons.toString(16).padStart(3, "0")}`;
  const problems = new Set();
  let tones = [];
  for (let i = 0; i < n; i++) {
    a.run(buttons);
    frames++;
    if (buttons & B && !(prev & B)) presses++;
    sinceRelease = buttons & B ? 0 : prev & B ? 1 : sinceRelease + 1;
    prev = buttons;
    if (word(0x10) !== want.joy) problems.add(`joypad word $${word(0x10).toString(16)}, not $${want.joy.toString(16)}`);
    if (word(0x12) !== frames) problems.add(`frame counter ${word(0x12)}, not ${frames}`);
    if (word(0x14) !== presses) problems.add(`B presses ${word(0x14)}, not ${presses}`);
    const bad = frameIs(a.frameRGBA(), want.color);
    if (bad) problems.add(`pixel ${bad}, expected (${want.color.join(",")})`);
    const m = measure(a.audio(), a.sampleRate);
    if (want.tone && i > 0) {
      tones.push(m.hz);
      if (Math.abs(m.hz - want.tone) > want.tone * 0.03) problems.add(`tone ${m.hz.toFixed(0)} Hz, not ${want.tone}`);
      if (m.peak < 4000) problems.add(`tone peak ${m.peak}`);
      if (!m.same) problems.add("left and right channels differ");
    } else if (!want.tone && sinceRelease >= 2 && m.peak !== 0) {
      problems.add(`sound (peak ${m.peak}) with B up`);
    }
  }
  const sound = tones.length ? `${(tones.reduce((s, t) => s + t, 0) / tones.length).toFixed(0)} Hz tone` : "silent";
  check(problems.size === 0,
        `${name}: joypad $${want.joy.toString(16).padStart(4, "0")}, color (${want.color.join(",")}), ${sound}` +
        (problems.size ? `: ${[...problems].join("; ")}` : ""));
}

// --- Determinism and save states ---
async function scripted() {
  const core = await boot();
  const pad = [0, A, B, B | UP, X | Y, 0, B];
  const h = createHash("sha256");
  for (let i = 0; i < 180; i++) {
    core.run(pad[Math.floor(i / 10) % pad.length]);
    h.update(core.frameRGBA().data).update(new Uint8Array(core.audio().buffer));
  }
  return { core, avHash: h.digest("hex") };
}
const s1 = await scripted(), s2 = await scripted();
check(sha(s1.core.memory(Memory.SYSTEM_RAM)) === sha(s2.core.memory(Memory.SYSTEM_RAM)) && s1.avHash === s2.avHash,
      "two fresh instances agree after 180 frames of input (memory, video, and audio)");

// snes9x's save states leave out the fraction of a sample
// carried from frame to frame when it resamples audio to 32040 Hz,
// so the first frame after loading one can have one sample more or less.
// Audio is compared from the second frame on.
function play(core) {
  const h = createHash("sha256");
  for (let i = 0; i < 60; i++) {
    core.run(i % 20 < 10 ? B | A : Y);
    h.update(core.frameRGBA().data);
    if (i > 0) h.update(new Uint8Array(core.audio().buffer));
  }
  return sha(core.memory(Memory.SYSTEM_RAM)) + h.digest("hex");
}
const state = s1.core.serialize();
const after = play(s1.core);
s1.core.unserialize(state);
check(play(s1.core) === after, "save state restores exactly (memory and video; audio after the first frame)");
console.log("work RAM SHA-256 after the scripted input:", sha(s2.core.memory(Memory.SYSTEM_RAM)));

// Smoke test for a built core: node test/smoke.mjs dist/snes9x
//
// Uses a 32 KiB SNES test ROM generated here (no game data): a valid LoROM
// header and a program that increments RAM byte $10 forever. Checks the API,
// that the program runs, that two fresh instances agree byte for byte, and
// that a save state restores exactly.
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LibretroCore, Memory } from "../frontend/libretro-core.js";

const dist = process.argv[2] || "dist/snes9x";
const { default: createCore } = await import(pathToFileURL(path.resolve(dist, "snes9x_core.mjs")).href);

function testRom() {
  const rom = new Uint8Array(0x8000);
  // $8000: sei; clc; xce; loop: inc $10; bra loop
  rom.set([0x78, 0x18, 0xfb, 0xe6, 0x10, 0x80, 0xfc], 0);
  const title = "LIBRETRO-WASM TEST".padEnd(21, " ");
  for (let i = 0; i < 21; i++) rom[0x7fc0 + i] = title.charCodeAt(i);
  rom[0x7fd5] = 0x20; // LoROM
  rom[0x7fd6] = 0x00; // ROM only
  rom[0x7fd7] = 0x05; // 32 KiB
  rom[0x7fd9] = 0x01; // North America (NTSC)
  for (let v = 0x7fe4; v < 0x8000; v += 2) { rom[v] = 0x00; rom[v + 1] = 0x80; } // all vectors -> $8000
  rom.set([0xff, 0xff, 0x00, 0x00], 0x7fdc);
  const sum = rom.reduce((s, b) => (s + b) & 0xffff, 0);
  rom.set([~sum & 0xff, (~sum >> 8) & 0xff, sum & 0xff, sum >> 8], 0x7fdc);
  return rom;
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const check = (ok, what) => { if (!ok) { console.error(`FAIL: ${what}`); process.exit(1); } console.log(`ok: ${what}`); };

async function run(frames, rom) {
  const core = await LibretroCore.create(createCore);
  core.load(rom);
  core.memory(Memory.SYSTEM_RAM).fill(0);
  for (let i = 0; i < frames; i++) core.run(0);
  return core;
}

const rom = testRom();
const a = await run(120, rom);
const ram = a.memory(Memory.SYSTEM_RAM);
check(ram && ram.length === 0x20000, `work RAM is 128 KiB (${ram && ram.length})`);
check(a.framesRun === 120, "120 frames run");
check(Math.abs(a.fps - 60.0988) < 0.01, `NTSC frame rate (${a.fps.toFixed(4)})`);
const f = a.frameRGBA();
check(f && f.width === 256 && (f.height === 224 || f.height === 239), `frame size ${f && f.width}x${f && f.height}`);
check(a.audio().length > 0 && a.sampleRate > 0, `audio: ${a.audio().length / 2} frames at ${a.sampleRate} Hz`);
check(ram[0x10] !== 0, `the test program ran (RAM $10 = ${ram[0x10]})`);

const b = await run(120, rom);
check(sha(ram) === sha(b.memory(Memory.SYSTEM_RAM)), "two fresh instances agree after 120 frames");

const state = a.serialize();
for (let i = 0; i < 60; i++) a.run(0);
const after = sha(a.memory(Memory.SYSTEM_RAM));
a.unserialize(state);
for (let i = 0; i < 60; i++) a.run(0);
check(sha(a.memory(Memory.SYSTEM_RAM)) === after, "save state restores exactly");
console.log("work RAM SHA-256 after 120 frames:", sha(ram));

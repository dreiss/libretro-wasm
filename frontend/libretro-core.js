// Wrapper around a core built with frontend/frontend.c.
//
//   import createCore from "./snes9x_core.mjs";
//   const core = await LibretroCore.create(createCore, { wasmBinary });
//   core.load(romBytes);
//   core.run(RetroPad.A | RetroPad.RIGHT);   // one frame
//   core.frameRGBA(); core.audio(); core.memory(Memory.SYSTEM_RAM);
//
// Works in browsers and in Node. Nothing here touches the DOM.

/** RetroPad button bits (1 << RETRO_DEVICE_ID_JOYPAD_*). */
export const RetroPad = Object.freeze({
  B: 1 << 0,
  Y: 1 << 1,
  SELECT: 1 << 2,
  START: 1 << 3,
  UP: 1 << 4,
  DOWN: 1 << 5,
  LEFT: 1 << 6,
  RIGHT: 1 << 7,
  A: 1 << 8,
  X: 1 << 9,
  L: 1 << 10,
  R: 1 << 11,
});

/** retro_get_memory_data ids. */
export const Memory = Object.freeze({ SAVE_RAM: 0, RTC: 1, SYSTEM_RAM: 2, VIDEO_RAM: 3 });

const PIXEL_RGB565 = 2, PIXEL_XRGB8888 = 1;

export class LibretroCore {
  /**
   * `factory` is the module's default export;
   * `options` go to Emscripten
   * (e.g. { wasmBinary } to supply the .wasm bytes yourself).
   */
  static async create(factory, options = {}) {
    const M = await factory({ print: () => {}, printErr: () => {}, ...options });
    return new LibretroCore(M);
  }

  constructor(M) {
    this.M = M;
    this.romPtr = 0;
    M._fe_init();
  }

  /** Load a game from bytes. The core keeps its own copy in its memory. */
  load(rom) {
    const M = this.M;
    this.romPtr = M._malloc(rom.length);
    M.HEAPU8.set(rom, this.romPtr);
    if (!M._fe_load(this.romPtr, rom.length)) throw new Error("retro_load_game failed");
  }

  /** Run exactly one frame with the given RetroPad bit mask held. */
  run(buttons = 0) { this.M._fe_run(buttons >>> 0); }

  reset() { this.M._fe_reset(); }

  /** Live view of a core memory region (e.g. Memory.SAVE_RAM), or null. */
  memory(id) {
    const p = this.M._fe_memory(id), n = this.M._fe_memory_size(id);
    return p && n ? this.M.HEAPU8.subarray(p, p + n) : null;
  }

  get fps() { return this.M._fe_fps(); }
  get sampleRate() { return this.M._fe_sample_rate(); }
  get framesRun() { return this.M._fe_frames_run(); }

  /**
   * The last frame as RGBA bytes (written to `out` if given,
   * which must hold width * height * 4 bytes).
   */
  frameRGBA(out) {
    const M = this.M, w = M._fe_frame_width(), h = M._fe_frame_height(), pitch = M._fe_frame_pitch();
    if (!w || !h) return null;
    const data = out || new Uint8Array(w * h * 4);
    const dst = new Uint32Array(data.buffer, data.byteOffset, w * h);
    const base = M._fe_frame();
    if (M._fe_pixel_format() === PIXEL_RGB565) {
      const src = new Uint16Array(M.HEAPU8.buffer, base, (pitch * h) / 2), row = pitch / 2;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const c = src[y * row + x], r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
        dst[y * w + x] = 0xff000000 | (((b << 3) | (b >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((r << 3) | (r >> 2));
      }
    } else if (M._fe_pixel_format() === PIXEL_XRGB8888) {
      const src = new Uint32Array(M.HEAPU8.buffer, base, (pitch * h) / 4), row = pitch / 4;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const c = src[y * row + x];
        dst[y * w + x] = 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);
      }
    } else {
      throw new Error(`unsupported pixel format ${M._fe_pixel_format()}`);
    }
    return { data, width: w, height: h };
  }

  /** The last frame's audio: a copy, interleaved stereo int16 at sampleRate. */
  audio() {
    return new Int16Array(this.M.HEAPU8.buffer, this.M._fe_audio(), this.M._fe_audio_count()).slice();
  }

  /** Save state as bytes. */
  serialize() {
    const M = this.M, n = M._fe_serialize_size(), p = M._malloc(n);
    try {
      if (!M._fe_serialize(p, n)) throw new Error("retro_serialize failed");
      return M.HEAPU8.slice(p, p + n);
    } finally { M._free(p); }
  }

  unserialize(state) {
    const M = this.M, p = M._malloc(state.length);
    try {
      M.HEAPU8.set(state, p);
      if (!M._fe_unserialize(p, state.length)) throw new Error("retro_unserialize failed");
    } finally { M._free(p); }
  }
}

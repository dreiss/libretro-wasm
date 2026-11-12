# libretro-wasm

Run a [libretro](https://www.libretro.com/) emulator core in the browser
(or Node) as a standalone WebAssembly module, without RetroArch.

The intended use case is automated playback from a recorded input sequence,
either providing a "live movie" that can be watched in the browser,
or doing browser-side rendering of a real video file.
In both cases, you get more simplicity and determinism than
a full RetroArch-based solution.

## Architecture

A small C frontend (`frontend/frontend.c`) is linked together with the core
by Emscripten. JavaScript drives it directly:

- `run(buttons)` runs exactly **one** frame with a RetroPad button mask held,
  so input timing is exact (useful for replaying recorded input);
- each frame's picture and audio samples come straight from the core;
- the core's memory (work RAM, save RAM) and save states are available.

Nothing is drawn or played for you:
the caller decides what to do with frames and audio
(show them on a canvas, encode them with WebCodecs, hash them, ...).
Core options are left unset, so each keeps the core's default.

## Cores

This repository contains scripts to build and test some cores.

| Core | Build | Pinned source |
|------|-------|---------------|
| snes9x | `cores/snes9x/build.sh` | [libretro/snes9x](https://github.com/libretro/snes9x) `5a40cd5` |

Toolchain: Emscripten 6.0.11 (installed by the build script via emsdk).

## Building

```
cores/snes9x/build.sh            # writes dist/snes9x/
node test/smoke.mjs dist/snes9x  # smoke test
```

`dist/snes9x/` then holds:

| File | |
|------|-|
| `snes9x_core.mjs` | ES module; its default export creates a module instance |
| `snes9x_core.wasm` | the core and frontend |
| `LICENSE.snes9x` | snes9x's license; it applies to the binaries |
| `SHA256SUMS` | |

The smoke test assembles a small SNES test program
(`test/rom/test.s`, no game data) with `ca65` and `ld65`
from [cc65](https://cc65.github.io/) (`apt install cc65`).
Its memory, picture, and sound react to the joypad
in simple, predictable ways,
so the test checks that input, video, and audio really work,
along with determinism and save states.

The build is reproducible:
rebuilding from a clean state, from a checkout at a different path,
or on a different machine gives byte-identical files.
Separate CI runs on different GitHub runners
and a from-scratch build on an unrelated Linux x86-64 machine
all produced the same `SHA256SUMS`.
Other host platforms (macOS, Windows, ARM) have not been checked.

CI (`.github/workflows/build.yml`) builds and smoke-tests every push.
A `v*` tag also publishes the `dist/snes9x` files as a GitHub release.

To put the releases on GitHub Pages,
run the `pages` workflow by hand after a release
(Actions tab > pages > Run workflow).
It publishes every release's files at
`https://dreiss.github.io/libretro-wasm/snes9x/<tag>/`.
Each release keeps its own path, so a published file never changes.
GitHub Pages sends `Access-Control-Allow-Origin: *`,
so the files can be loaded from any origin.

## Using it

```js
import createCore from "./snes9x_core.mjs";
import { LibretroCore, RetroPad, Memory } from "./frontend/libretro-core.js";

const core = await LibretroCore.create(createCore);
core.load(romBytes);                     // Uint8Array
core.run(RetroPad.START);                // one frame
const { data, width, height } = core.frameRGBA();  // RGBA bytes
const samples = core.audio();            // Int16Array, interleaved stereo at core.sampleRate
const wram = core.memory(Memory.SYSTEM_RAM);
const state = core.serialize();
```

To serve the module from another origin, the host must send CORS headers
(`Access-Control-Allow-Origin`).
To check the files before running them, fetch both, verify their hashes,
and pass the `.wasm` bytes in:
`LibretroCore.create(createCore, { wasmBinary })`.
Emscripten's loader resolves paths against `import.meta.url`,
so if you import the `.mjs` from a `blob:` URL,
replace `import.meta.url` in its text with its real URL first.

The low-level functions
(`fe_*` in `frontend/frontend.c`, listed in `frontend/exports.txt`)
can also be called directly on the module.

## Licenses

This repository's own files are under the MIT license (see `LICENSE`).

The cores keep their own licenses.
snes9x's license permits non-commercial use and distribution,
in source or binary form,
provided its license and copyright notice accompany every copy;
the build copies it to `LICENSE.snes9x` next to the binaries.
Because the built `.wasm` contains snes9x,
snes9x's terms apply to it
even though the frontend code linked into it is MIT-licensed.

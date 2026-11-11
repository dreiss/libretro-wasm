#!/usr/bin/env bash
# Build the snes9x libretro core as a standalone WebAssembly module
# with frontend/frontend.c (no RetroArch).
#
#   cores/snes9x/build.sh [DIST_DIR]      (default: dist/snes9x)
#
# Writes DIST_DIR/snes9x_core.mjs
# (ES module, default export: the module factory),
# snes9x_core.wasm, LICENSE.snes9x (snes9x's license,
# which must accompany any distribution of the binaries),
# and SHA256SUMS. Tools and sources are cached in build/
# (override with LIBRETRO_WASM_CACHE).
set -euo pipefail

EMSDK_VERSION=6.0.11
SNES9X_REPO=https://github.com/libretro/snes9x
SNES9X_COMMIT=5a40cd5514e63e691e39141d64267798357a1424

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
C="${LIBRETRO_WASM_CACHE:-$ROOT/build}"
DIST="$(mkdir -p "${1:-$ROOT/dist/snes9x}" && cd "${1:-$ROOT/dist/snes9x}" && pwd)"
mkdir -p "$C"

if [ ! -d "$C/emsdk/.git" ]; then git clone -q https://github.com/emscripten-core/emsdk.git "$C/emsdk"; fi
"$C/emsdk/emsdk" install "$EMSDK_VERSION" >/dev/null
"$C/emsdk/emsdk" activate "$EMSDK_VERSION" >/dev/null
# shellcheck disable=SC1091
source "$C/emsdk/emsdk_env.sh" >/dev/null 2>&1

if [ ! -d "$C/snes9x/.git" ]; then git clone -q "$SNES9X_REPO" "$C/snes9x"; fi
git -C "$C/snes9x" fetch -q origin "$SNES9X_COMMIT" || true
git -C "$C/snes9x" checkout -q "$SNES9X_COMMIT"
emmake make -C "$C/snes9x/libretro" platform=emscripten -j"$(nproc)" >/dev/null

# The core's "platform=emscripten" target is an ar archive despite its .bc name.
cp "$C/snes9x/libretro/snes9x_libretro_emscripten.bc" "$C/libsnes9x_core.a"
emcc -O3 -c "$ROOT/frontend/frontend.c" -I "$C/snes9x/libretro" -o "$C/frontend.o"
EXPORTS="[$(sed 's/.*/"&"/' "$ROOT/frontend/exports.txt" | paste -sd,)]"
em++ -O3 "$C/frontend.o" "$C/libsnes9x_core.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createCore \
  -sENVIRONMENT=web,node -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS="$EXPORTS" -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -o "$DIST/snes9x_core.mjs"
cp "$C/snes9x/LICENSE" "$DIST/LICENSE.snes9x"
(cd "$DIST" && sha256sum snes9x_core.mjs snes9x_core.wasm > SHA256SUMS && cat SHA256SUMS)

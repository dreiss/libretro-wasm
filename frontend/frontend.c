/* Minimal libretro frontend for running one core
 * as a standalone WebAssembly module (no RetroArch, no DOM).
 * Linked together with a core by cores/<name>/build.sh.
 * JavaScript calls the fe_* functions below;
 * see frontend/libretro-core.js for a wrapper.
 *
 * One fe_run() is exactly one retro_run().
 * Input is a RetroPad joypad on port 0,
 * given as a bit mask of RETRO_DEVICE_ID_JOYPAD_* ids.
 * Core options are left unset, so every option keeps the core's default.
 */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include <emscripten/emscripten.h>
#include "libretro.h"

static uint16_t buttons;              /* RetroPad bits, RETRO_DEVICE_ID_JOYPAD_* */
static const void *frame;             /* last frame passed to video refresh */
static unsigned frame_w, frame_h;
static size_t frame_pitch;
static uint32_t frames_run;
static enum retro_pixel_format pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;
#define AUDIO_MAX (2 * 8192)          /* int16 values (stereo pairs) kept per frame */
static int16_t audio[AUDIO_MAX];
static size_t audio_n;                /* int16 values in audio[] from the last frame */

static bool env_cb(unsigned cmd, void *data) {
  switch (cmd) {
  case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
    enum retro_pixel_format f = *(const enum retro_pixel_format *)data;
    if (f != RETRO_PIXEL_FORMAT_RGB565 && f != RETRO_PIXEL_FORMAT_XRGB8888) return false;
    pixel_format = f;
    return true;
  }
  case RETRO_ENVIRONMENT_GET_CAN_DUPE:
    *(bool *)data = true;
    return true;
  case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
  case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
    *(const char **)data = ".";
    return true;
  case RETRO_ENVIRONMENT_GET_VARIABLE:
    ((struct retro_variable *)data)->value = NULL;  /* core option defaults */
    return false;
  case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
    *(bool *)data = false;
    return true;
  default:
    return false;
  }
}

static void video_cb(const void *data, unsigned w, unsigned h, size_t pitch) {
  if (data) { frame = data; frame_w = w; frame_h = h; frame_pitch = pitch; }  /* NULL = dupe */
}
static void audio_cb(int16_t l, int16_t r) {
  if (audio_n + 2 <= AUDIO_MAX) { audio[audio_n++] = l; audio[audio_n++] = r; }
}
static size_t audio_batch_cb(const int16_t *data, size_t pairs) {
  size_t n = pairs * 2;
  if (audio_n + n > AUDIO_MAX) n = AUDIO_MAX - audio_n;
  memcpy(audio + audio_n, data, n * sizeof(int16_t));
  audio_n += n;
  return pairs;
}
static void input_poll_cb(void) {}
static int16_t input_state_cb(unsigned port, unsigned device, unsigned index, unsigned id) {
  (void)index;
  if (port != 0 || device != RETRO_DEVICE_JOYPAD) return 0;
  if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)buttons;
  return (buttons >> id) & 1;
}

EMSCRIPTEN_KEEPALIVE int fe_init(void) {
  retro_set_environment(env_cb);
  retro_set_video_refresh(video_cb);
  retro_set_audio_sample(audio_cb);
  retro_set_audio_sample_batch(audio_batch_cb);
  retro_set_input_poll(input_poll_cb);
  retro_set_input_state(input_state_cb);
  retro_init();
  return RETRO_API_VERSION;
}

/* `rom` must stay allocated while the game runs (cores may keep pointers). */
EMSCRIPTEN_KEEPALIVE int fe_load(const void *rom, size_t size) {
  struct retro_game_info info = { "game", rom, size, NULL };
  if (!retro_load_game(&info)) return 0;
  retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
  return 1;
}

EMSCRIPTEN_KEEPALIVE void fe_run(unsigned b) {
  buttons = (uint16_t)b;
  audio_n = 0;
  retro_run();
  frames_run++;
}

EMSCRIPTEN_KEEPALIVE void fe_reset(void) { retro_reset(); }
EMSCRIPTEN_KEEPALIVE const void *fe_frame(void) { return frame; }
EMSCRIPTEN_KEEPALIVE unsigned fe_frame_width(void) { return frame_w; }
EMSCRIPTEN_KEEPALIVE unsigned fe_frame_height(void) { return frame_h; }
EMSCRIPTEN_KEEPALIVE size_t fe_frame_pitch(void) { return frame_pitch; }
EMSCRIPTEN_KEEPALIVE unsigned fe_pixel_format(void) { return pixel_format; }
EMSCRIPTEN_KEEPALIVE const int16_t *fe_audio(void) { return audio; }
EMSCRIPTEN_KEEPALIVE size_t fe_audio_count(void) { return audio_n; }
EMSCRIPTEN_KEEPALIVE uint32_t fe_frames_run(void) { return frames_run; }
EMSCRIPTEN_KEEPALIVE void *fe_memory(unsigned id) { return retro_get_memory_data(id); }
EMSCRIPTEN_KEEPALIVE size_t fe_memory_size(unsigned id) { return retro_get_memory_size(id); }
EMSCRIPTEN_KEEPALIVE size_t fe_serialize_size(void) { return retro_serialize_size(); }
EMSCRIPTEN_KEEPALIVE int fe_serialize(void *buf, size_t size) { return retro_serialize(buf, size); }
EMSCRIPTEN_KEEPALIVE int fe_unserialize(const void *buf, size_t size) { return retro_unserialize(buf, size); }
EMSCRIPTEN_KEEPALIVE double fe_fps(void) {
  struct retro_system_av_info av;
  retro_get_system_av_info(&av);
  return av.timing.fps;
}
EMSCRIPTEN_KEEPALIVE double fe_sample_rate(void) {
  struct retro_system_av_info av;
  retro_get_system_av_info(&av);
  return av.timing.sample_rate;
}

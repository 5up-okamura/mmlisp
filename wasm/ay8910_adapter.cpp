// ymfm's SSG engine behind a small C API, for the msx preview: the
// AY-3-8910 as ymfm plays the YM2149 (MAME's levels, the 4-bit volume read
// as the envelope's 32 steps).
//
// The engine clocks at the chip's clock / 8; four of its states are averaged
// into one rendered sample, at clock / 32, which the caller resamples to the
// output rate. A sample is the three channels' own outputs (unipolar, 0 to
// 16382 each), the mix and the oscilloscope's lanes alike: the caller sums
// them.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "ymfm_ssg.h"

#define A8_MAX_RENDER_SAMPLES 4096
#define A8_CLOCKS_PER_SAMPLE 4

namespace {

class host : public ymfm::ymfm_interface {};

host g_host;
ymfm::ssg_engine *g_chip = nullptr;
int16_t g_buffer[A8_MAX_RENDER_SAMPLES * 3];

void ensure_init() {
  if (g_chip) return;
  g_chip = new ymfm::ssg_engine(g_host);
  g_chip->reset();
}

}  // namespace

extern "C" {

int a8_init(void) {
  ensure_init();
  return 1;
}

void a8_reset(void) {
  ensure_init();
  g_chip->reset();
}

void a8_write_reg(int addr, int data) {
  ensure_init();
  if ((addr & 0xff) < 16) g_chip->write(addr & 0x0f, (uint8_t)data);
}

int a8_get_buffer_ptr(void) { return (int)(intptr_t)g_buffer; }

// Render `count` samples at clock / 32 into the buffer; returns the count.
int a8_render(int count) {
  ensure_init();
  if (count > A8_MAX_RENDER_SAMPLES) count = A8_MAX_RENDER_SAMPLES;
  ymfm::ssg_engine::output_data out;
  int16_t *dst = g_buffer;
  for (int i = 0; i < count; i++) {
    int32_t sum[3] = { 0, 0, 0 };
    for (int k = 0; k < A8_CLOCKS_PER_SAMPLE; k++) {
      g_chip->clock();
      g_chip->output(out);
      for (int ch = 0; ch < 3; ch++) sum[ch] += out.data[ch];
    }
    for (int ch = 0; ch < 3; ch++) *dst++ = (int16_t)(sum[ch] / A8_CLOCKS_PER_SAMPLE);
  }
  return count;
}

}  // extern "C"

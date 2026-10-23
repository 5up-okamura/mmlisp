// ymfm's YM2151 (OPM) behind a small C API, for the x68k preview.
//
// One rendered sample is the chip's own, at clock / 64: two int16s, left and
// right, which the caller resamples to the output rate. Beside it, each FM
// channel's own part — eight lanes a sample, for the oscilloscope: the chip's
// sample is recomputed with each channel's output kept (ym2151_taps), which
// sums to what ymfm's own makes before the DAC's truncation.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "ymfm_opm.h"

#define Y5_MAX_RENDER_SAMPLES 4096

namespace {

class host : public ymfm::ymfm_interface {};

class ym2151_taps : public ymfm::ym2151 {
 public:
  static constexpr int LANES = 8;
  int32_t lane[LANES];

  explicit ym2151_taps(ymfm::ymfm_interface &intf) : ym2151(intf) {}

  void generate1(output_data *out) {
    m_fm.clock(fm_engine::ALL_CHANNELS);
    out->clear();
    fm_engine::output_data o;
    for (int ch = 0; ch < LANES; ch++) {
      o.clear();
      m_fm.output(o, 0, 32767, 1u << ch);
      // A channel's lane is its louder side.
      lane[ch] = std::abs(o.data[0]) >= std::abs(o.data[1]) ? o.data[0] : o.data[1];
      out->data[0] += o.data[0];
      out->data[1] += o.data[1];
    }
    // The YM3012 DAC's 10.3 floating point, as ymfm's generate() has it.
    out->roundtrip_fp();
  }
};

host g_host;
ym2151_taps *g_chip = nullptr;
int16_t g_buffer[Y5_MAX_RENDER_SAMPLES * 2];
int16_t g_taps[Y5_MAX_RENDER_SAMPLES * ym2151_taps::LANES];

// ymfm applies a write at once and reads the key state once a sample, so a
// channel keyed off and on again within one sample never sees the off, and
// its note is not re-attacked (wasm/ym2608_adapter.cpp). A second $08 to a
// channel in the same sample waits, with every write after it, for the next.
struct pending { uint8_t addr, data; };
const int Y5_QUEUE = 8192;
pending g_queue[Y5_QUEUE];
int g_qhead = 0, g_qlen = 0;
uint8_t g_keyed = 0; // channels ($08 bits 2-0) keyed in this sample

void ensure_init() {
  if (g_chip) return;
  g_chip = new ym2151_taps(g_host);
  g_chip->reset();
}

bool apply_write(int addr, int data) {
  if (addr == 0x08) {
    const uint8_t bit = 1 << (data & 7);
    if (g_keyed & bit) return false;
    g_keyed |= bit;
  }
  g_chip->write_address((uint8_t)addr);
  g_chip->write_data((uint8_t)data);
  return true;
}

void drain_queue() {
  while (g_qlen > 0) {
    const pending &w = g_queue[g_qhead];
    if (!apply_write(w.addr, w.data)) return;
    g_qhead = (g_qhead + 1) % Y5_QUEUE;
    g_qlen--;
  }
}

}  // namespace

extern "C" {

int y5_init(void) {
  ensure_init();
  return 1;
}

void y5_reset(void) {
  ensure_init();
  g_chip->reset();
  g_qlen = 0;
  g_keyed = 0;
}

void y5_write_reg(int addr, int data) {
  ensure_init();
  addr &= 0xff;
  data &= 0xff;
  if (g_qlen == 0 && apply_write(addr, data)) return;
  if (g_qlen == Y5_QUEUE) return; // a burst no score makes
  g_queue[(g_qhead + g_qlen) % Y5_QUEUE] = { (uint8_t)addr, (uint8_t)data };
  g_qlen++;
}

int y5_get_buffer_ptr(void) { return (int)(intptr_t)g_buffer; }
int y5_get_tap_ptr(void) { return (int)(intptr_t)g_taps; }

// Render `count` samples at clock / 64 into the buffer; returns the count.
int y5_render(int count) {
  ensure_init();
  if (count > Y5_MAX_RENDER_SAMPLES) count = Y5_MAX_RENDER_SAMPLES;
  ymfm::ym2151::output_data out;
  int16_t *dst = g_buffer;
  int16_t *tap = g_taps;
  for (int i = 0; i < count; i++) {
    drain_queue();
    g_chip->generate1(&out);
    g_keyed = 0;
    for (int k = 0; k < 2; k++) {
      const int32_t v = out.data[k];
      *dst++ = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
    for (int k = 0; k < ym2151_taps::LANES; k++) {
      const int32_t v = g_chip->lane[k];
      *tap++ = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
  }
  return count;
}

}  // extern "C"

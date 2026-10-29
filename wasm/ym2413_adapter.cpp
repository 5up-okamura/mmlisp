// ymfm's YM2413 (OPLL) behind a small C API, for the msx preview's FM-PAC.
//
// One rendered sample is the chip's own, at clock / 72: one int16, its
// melody (MO) and rhythm (RO) outputs summed as the FM-PAC sums them, which
// the caller resamples to the output rate. Beside it, each
// channel's own part — nine lanes a sample, for the oscilloscope, the rhythm
// sounds in channels 6-8 as the chip plays them: the chip's sample is
// recomputed with each channel's output kept (ym2413_taps), which sums to
// what ymfm's own generate() makes. The ROM voices are the caller's
// (ol_set_rom: live/src/chips/ym2413.js holds the chip's), so the encoder
// that names a ROM voice and the emulator that plays it read one table.
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "ymfm_opl.h"

#define OL_MAX_RENDER_SAMPLES 4096

namespace {

class host : public ymfm::ymfm_interface {};

class ym2413_taps : public ymfm::ym2413 {
 public:
  static constexpr int LANES = 9;
  int32_t lane[LANES];

  explicit ym2413_taps(ymfm::ymfm_interface &intf) : ym2413(intf) {}

  // opll_base::generate, a channel at a time: its 9-bit DAC's output (the
  // shift and range ymfm's has), the multiplexed sum averaged over the nine.
  // ymfm puts the melody on output 0 and the rhythm on output 1 (the chip's
  // MO and RO pins); a lane, and the sample, is the two.
  int32_t generate1() {
    m_fm.clock(fm_engine::ALL_CHANNELS);
    int32_t sum = 0;
    fm_engine::output_data o;
    for (int ch = 0; ch < LANES; ch++) {
      o.clear();
      m_fm.output(o, 5, 256, 1u << ch);
      const int32_t v = o.data[0] + o.data[1];
      lane[ch] = (v * 128) / 9;
      sum += v;
    }
    return (sum * 128) / 9;
  }
};

host g_host;
ym2413_taps *g_chip = nullptr;
int16_t g_buffer[OL_MAX_RENDER_SAMPLES];
int16_t g_taps[OL_MAX_RENDER_SAMPLES * ym2413_taps::LANES];
uint8_t g_rom[18 * 8]; // fifteen voices and three rhythm patches, $00-$07 each

// ymfm applies a write at once and reads the key state once a sample, so a
// channel keyed off and on again within one sample never sees the off, and
// its note is not re-attacked (wasm/ym2608_adapter.cpp). The OPLL's keys are
// $20-$28 bit 4 (with the block and the F-number's top bit) and the rhythm's
// $0E: a second write to one of them in the same sample waits, with every
// write after it, for the next — unless both key nothing on: a key-off on a
// key-off changes nothing, and a seek's burst (IRPlayer.seek) is every
// key-off the song made until there.
struct pending { uint8_t addr, data; };
const int OL_QUEUE = 8192;
pending g_queue[OL_QUEUE];
int g_qhead = 0, g_qlen = 0;
uint16_t g_keyed = 0; // bits 0-8 the channels' $2x, bit 9 $0E, written in this sample
uint16_t g_on = 0; // of those, the ones whose last write keyed something on

void ensure_init() {
  if (g_chip) return;
  g_chip = new ym2413_taps(g_host);
  g_chip->reset();
}

bool apply_write(int addr, int data) {
  const int key = addr >= 0x20 && addr <= 0x28 ? addr - 0x20 : addr == 0x0e ? 9 : -1;
  if (key >= 0) {
    const uint16_t bit = 1u << key;
    const bool on = (data & (key == 9 ? 0x1f : 0x10)) != 0;
    if ((g_keyed & bit) && (on || (g_on & bit))) return false;
    g_keyed |= bit;
    g_on = on ? g_on | bit : g_on & ~bit;
  }
  g_chip->write_address((uint8_t)addr);
  g_chip->write_data((uint8_t)data);
  return true;
}

void drain_queue() {
  while (g_qlen > 0) {
    const pending &w = g_queue[g_qhead];
    if (!apply_write(w.addr, w.data)) return;
    g_qhead = (g_qhead + 1) % OL_QUEUE;
    g_qlen--;
  }
}

int16_t clamp16(int32_t v) { return (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v); }

}  // namespace

extern "C" {

int ol_init(void) {
  ensure_init();
  return 1;
}

void ol_reset(void) {
  ensure_init();
  g_chip->reset();
  g_qlen = 0;
  g_keyed = g_on = 0;
}

void ol_write_reg(int addr, int data) {
  ensure_init();
  addr &= 0xff;
  data &= 0xff;
  if (g_qlen == 0 && apply_write(addr, data)) return;
  if (g_qlen == OL_QUEUE) return; // a burst no score makes
  g_queue[(g_qhead + g_qlen) % OL_QUEUE] = { (uint8_t)addr, (uint8_t)data };
  g_qlen++;
}

int ol_get_buffer_ptr(void) { return (int)(intptr_t)g_buffer; }
int ol_get_rom_ptr(void) { return (int)(intptr_t)g_rom; }

// The ROM the caller wrote at ol_get_rom_ptr(), in place of ymfm's own.
void ol_set_rom(void) {
  ensure_init();
  g_chip->set_instrument_data(g_rom);
  g_chip->invalidate_caches();
}
int ol_get_tap_ptr(void) { return (int)(intptr_t)g_taps; }

// Render `count` samples at clock / 72 into the buffer; returns the count.
int ol_render(int count) {
  ensure_init();
  if (count > OL_MAX_RENDER_SAMPLES) count = OL_MAX_RENDER_SAMPLES;
  int16_t *dst = g_buffer;
  int16_t *tap = g_taps;
  for (int i = 0; i < count; i++) {
    drain_queue();
    *dst++ = clamp16(g_chip->generate1());
    g_keyed = g_on = 0;
    for (int k = 0; k < ym2413_taps::LANES; k++) *tap++ = clamp16(g_chip->lane[k]);
  }
  return count;
}

}  // extern "C"

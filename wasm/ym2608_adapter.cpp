// ymfm's YM2608 (OPNA) behind a small C API, for the pc88 preview.
//
// The chip runs at ymfm's lowest fidelity (output = clock / 48, the FM
// repeated 3:1, the SSG resampled 2:3), and every three of its samples are
// averaged into one at the FM's own rate, clock / 144 — the rate the caller
// resamples from, as it does Nuked's. Each rendered sample is three int16s:
// FM + rhythm + ADPCM-B left, the same right, and the SSG (mono, unipolar),
// which the caller mixes in at its own gain.
//
// Beside it, each sound's own part — FM 1-6, SSG A-C, the ADPCM-B, the rhythm
// BD SD TOP HH TOM RIM — sixteen lanes a sample, for the oscilloscope: the
// chip's sample is recomputed with each channel's output kept (ym2608_taps),
// which sums to what ymfm's own makes.
//
// The chip reads two external memories through the host, as MAME's does: the
// rhythm ROM (ACCESS_ADPCM_A, 8 KB, Yamaha's — the caller brings it) and the
// ADPCM-B's RAM (ACCESS_ADPCM_B, 256 KB, the score's baked image).
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "ymfm_opn.h"

#define Y8_MAX_RENDER_SAMPLES 4096
#define Y8_ROM_BYTES 0x2000
#define Y8_RAM_BYTES (256 * 1024)

namespace {

class host : public ymfm::ymfm_interface {
 public:
  uint8_t rom[Y8_ROM_BYTES];
  uint8_t ram[Y8_RAM_BYTES];

  uint8_t ymfm_external_read(ymfm::access_class type, uint32_t address) override {
    if (type == ymfm::ACCESS_ADPCM_A) return address < Y8_ROM_BYTES ? rom[address] : 0;
    if (type == ymfm::ACCESS_ADPCM_B) return address < Y8_RAM_BYTES ? ram[address] : 0;
    return 0;
  }

  void ymfm_external_write(ymfm::access_class type, uint32_t address, uint8_t data) override {
    if (type == ymfm::ACCESS_ADPCM_B && address < Y8_RAM_BYTES) ram[address] = data;
  }
};

// ymfm's YM2608 with each channel's output kept. One FM-rate sample is
// ym2608::generate(out, 3) at the default prescale (6): the FM clocked once,
// its output held three times, the SSG resampled 2:3 — done here channel by
// channel. At another prescale the lanes stay silent and ymfm's own runs.
class ym2608_taps : public ymfm::ym2608 {
 public:
  static constexpr int LANES = 16;
  int32_t lane[LANES];

  explicit ym2608_taps(ymfm::ymfm_interface &intf) : ym2608(intf) {}

  void generate3(output_data *out) {
    if (m_fm_samples_per_output != 3) {
      for (int k = 0; k < LANES; k++) lane[k] = 0;
      generate(out, 3);
      return;
    }
    const uint32_t fmmask = ymfm::bitfield(m_irq_enable, 7) ? 0x3f : 0x07;
    const uint32_t env = m_fm.clock(fm_engine::ALL_CHANNELS);
    if (ymfm::bitfield(env, 0, 2) == 0) m_adpcm_a.clock(ymfm::bitfield(env, 2) ? 0x0f : 0x3f);
    m_adpcm_b.clock();
    m_last_fm.clear();
    fm_engine::output_data o;
    // One channel's stereo part, added to the sum; its lane the louder side.
    auto keep = [&](int k) {
      lane[k] = std::abs(o.data[0]) >= std::abs(o.data[1]) ? o.data[0] : o.data[1];
      m_last_fm.data[0] += o.data[0];
      m_last_fm.data[1] += o.data[1];
    };
    for (int ch = 0; ch < 6; ch++) {
      o.clear();
      if ((fmmask >> ch) & 1) m_fm.output(o, 1, 32767, 1u << ch);
      keep(ch);
    }
    o.clear();
    m_adpcm_b.output(o, 1);
    keep(9);
    for (int ch = 0; ch < 6; ch++) {
      o.clear();
      m_adpcm_a.output(o, 1u << ch);
      keep(10 + ch);
    }
    m_last_fm.clamp16();
    for (int k = 0; k < 3; k++) {
      out[k].data[0] = m_last_fm.data[0];
      out[k].data[1] = m_last_fm.data[1];
    }
    m_ssg_resampler.resample(out, 3);
    ymfm::ssg_engine::output_data so;
    m_ssg.output(so);
    for (int ch = 0; ch < 3; ch++) lane[6 + ch] = so.data[ch];
  }
};

host g_host;
ym2608_taps *g_chip = nullptr;
// Without a ROM the rhythm is not keyed at all: zeroed memory is no silence
// to an ADPCM decoder (each 0 nibble steps the level up).
int g_has_rom = 0;
int16_t g_buffer[Y8_MAX_RENDER_SAMPLES * 3];
int16_t g_taps[Y8_MAX_RENDER_SAMPLES * ym2608_taps::LANES];

// ymfm applies a write at once and reads the key state once a sample, so a
// channel keyed off and on again within one sample (a driver's key-off,
// F-number, key-on, all at one instant) never sees the off, and its note is
// not re-attacked. The chip sees it: its bus takes microseconds a write.
// A second $28 to a channel in the same sample therefore waits, with every
// write after it, for the next sample.
struct pending { uint8_t port, addr, data; };
const int Y8_QUEUE = 8192;
pending g_queue[Y8_QUEUE];
int g_qhead = 0, g_qlen = 0;
uint8_t g_keyed = 0; // channels ($28 bits 2-0) keyed in this sample

void ensure_init() {
  if (g_chip) return;
  memset(g_host.rom, 0, sizeof g_host.rom);
  memset(g_host.ram, 0, sizeof g_host.ram);
  g_chip = new ym2608_taps(g_host);
  g_chip->set_fidelity(ymfm::OPN_FIDELITY_MIN);
  g_chip->reset();
}

// Apply one write now, or return false when it must wait (see g_queue).
bool apply_write(int port, int addr, int data) {
  if (!(port & 1) && addr == 0x28) {
    const uint8_t bit = 1 << (data & 7);
    if (g_keyed & bit) return false;
    g_keyed |= bit;
  }
  if (!(port & 1) && addr == 0x10 && !g_has_rom) return true;
  if (port & 1) {
    g_chip->write_address_hi((uint8_t)addr);
    g_chip->write_data_hi((uint8_t)data);
  } else {
    g_chip->write_address((uint8_t)addr);
    g_chip->write_data((uint8_t)data);
  }
  return true;
}

void drain_queue() {
  while (g_qlen > 0) {
    const pending &w = g_queue[g_qhead];
    if (!apply_write(w.port, w.addr, w.data)) return;
    g_qhead = (g_qhead + 1) % Y8_QUEUE;
    g_qlen--;
  }
}

}  // namespace

extern "C" {

int y8_init(void) {
  ensure_init();
  return 1;
}

void y8_reset(void) {
  ensure_init();
  g_chip->reset();
  g_qlen = 0;
  g_keyed = 0;
}

// port 0: $00-$FF of the first address space (SSG, rhythm, FM ch1-3);
// port 1: the second (ADPCM-B, FM ch4-6).
void y8_write_reg(int port, int addr, int data) {
  ensure_init();
  port &= 1;
  addr &= 0xff;
  data &= 0xff;
  if (g_qlen == 0 && apply_write(port, addr, data)) return;
  if (g_qlen == Y8_QUEUE) return; // a burst no score makes
  g_queue[(g_qhead + g_qlen) % Y8_QUEUE] = { (uint8_t)port, (uint8_t)addr, (uint8_t)data };
  g_qlen++;
}

// Where the caller copies the rhythm ROM and the ADPCM-B image to; cleared to
// zero on every call, so a shorter image leaves zeros behind it.
int y8_get_rom_ptr(void) {
  ensure_init();
  memset(g_host.rom, 0, sizeof g_host.rom);
  g_has_rom = 0;
  return (int)(intptr_t)g_host.rom;
}

// After the ROM is copied in: 1 when there is one.
void y8_set_rom_loaded(int on) { g_has_rom = on ? 1 : 0; }

int y8_get_ram_ptr(void) {
  ensure_init();
  memset(g_host.ram, 0, sizeof g_host.ram);
  return (int)(intptr_t)g_host.ram;
}

int y8_get_buffer_ptr(void) { return (int)(intptr_t)g_buffer; }
int y8_get_tap_ptr(void) { return (int)(intptr_t)g_taps; }

// Render `count` samples at clock / 144 into the buffer; returns the count.
int y8_render(int count) {
  ensure_init();
  if (count > Y8_MAX_RENDER_SAMPLES) count = Y8_MAX_RENDER_SAMPLES;
  ymfm::ym2608::output_data out[3];
  int16_t *dst = g_buffer;
  int16_t *tap = g_taps;
  for (int i = 0; i < count; i++) {
    drain_queue();
    g_chip->generate3(out);
    g_keyed = 0;
    for (int k = 0; k < 3; k++)
      *dst++ = (int16_t)((out[0].data[k] + out[1].data[k] + out[2].data[k]) / 3);
    for (int k = 0; k < ym2608_taps::LANES; k++) {
      const int32_t v = g_chip->lane[k];
      *tap++ = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
    }
  }
  return count;
}

}  // extern "C"

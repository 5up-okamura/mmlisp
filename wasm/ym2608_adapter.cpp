// ymfm's YM2608 (OPNA) behind a small C API, for the pc88 preview.
//
// The chip runs at ymfm's lowest fidelity (output = clock / 48, the FM
// repeated 3:1, the SSG resampled 2:3), and every three of its samples are
// averaged into one at the FM's own rate, clock / 144 — the rate the caller
// resamples from, as it does Nuked's. Each rendered sample is three int16s:
// FM + rhythm + ADPCM-B left, the same right, and the SSG (mono, unipolar),
// which the caller mixes in at its own gain.
//
// The chip reads two external memories through the host, as MAME's does: the
// rhythm ROM (ACCESS_ADPCM_A, 8 KB, Yamaha's — the caller brings it) and the
// ADPCM-B's RAM (ACCESS_ADPCM_B, 256 KB, the score's baked image).
#include <stdint.h>
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

host g_host;
ymfm::ym2608 *g_chip = nullptr;
// Without a ROM the rhythm is not keyed at all: zeroed memory is no silence
// to an ADPCM decoder (each 0 nibble steps the level up).
int g_has_rom = 0;
int16_t g_buffer[Y8_MAX_RENDER_SAMPLES * 3];

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
  g_chip = new ymfm::ym2608(g_host);
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

// Render `count` samples at clock / 144 into the buffer; returns the count.
int y8_render(int count) {
  ensure_init();
  if (count > Y8_MAX_RENDER_SAMPLES) count = Y8_MAX_RENDER_SAMPLES;
  ymfm::ym2608::output_data out[3];
  int16_t *dst = g_buffer;
  for (int i = 0; i < count; i++) {
    drain_queue();
    g_chip->generate(out, 3);
    g_keyed = 0;
    for (int k = 0; k < 3; k++)
      *dst++ = (int16_t)((out[0].data[k] + out[1].data[k] + out[2].data[k]) / 3);
  }
  return count;
}

}  // extern "C"

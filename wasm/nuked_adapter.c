#include <stdint.h>

#include "ym3438.h"

#define NOPN_CLOCKS_PER_SAMPLE 24
#define NOPN_MAX_RENDER_SAMPLES 4096

static ym3438_t g_chip;
static int16_t g_buffer[NOPN_MAX_RENDER_SAMPLES * 2];
// Per-channel oscilloscope taps, interleaved [sample][channel 0..5]. Filled
// alongside g_buffer on every render from the core's ch_out state (9-bit
// signed, -256..255). Channel 6 carries the DAC byte while the DAC is on.
static int16_t g_ch_buffer[NOPN_MAX_RENDER_SAMPLES * 6];
static int g_initialized = 0;

// DAC streaming state. When enabled, FM channel 6 is replaced by the value of
// register 0x2a, which we restream every rendered sample. 0x80 is the centered
// (silent) value: ym3438 maps 0x2a writes as (value ^ 0x80) << 1.
static int g_dac_enabled = 0;
static int g_dac_sample = 0x80;

static void nopn_clock_cycles(int cycles) {
  int16_t frame[2] = {0, 0};
  for (int i = 0; i < cycles; i++) {
    OPN2_Clock(&g_chip, frame);
  }
}

static void nopn_ensure_init(void) {
  if (g_initialized) {
    return;
  }
  OPN2_SetChipType(ym3438_mode_ym2612);
  OPN2_Reset(&g_chip);
  g_initialized = 1;
}

int nopn_init(void) {
  nopn_ensure_init();
  return 1;
}

void nopn_reset(void) {
  nopn_ensure_init();
  OPN2_Reset(&g_chip);
  g_dac_enabled = 0;
  g_dac_sample = 0x80;
}

// Enable/disable the DAC (register 0x2b bit7). Called rarely (on transitions),
// so the extra latch cycles are negligible. Sacrifices FM channel 6 while on.
void nopn_set_dac_enabled(int on) {
  nopn_ensure_init();
  g_dac_enabled = on ? 1 : 0;
  OPN2_Write(&g_chip, 0, 0x2b);
  nopn_clock_cycles(24);
  OPN2_Write(&g_chip, 1, (uint8_t)(on ? 0x80 : 0x00));
  nopn_clock_cycles(24);
  if (!on) {
    g_dac_sample = 0x80;
  }
}

// Set the unsigned-8-bit DAC value (0x80 = center) to be streamed on the next
// render. The actual 0x2a write is folded into nopn_render's per-sample clock
// budget so it adds no extra cycles.
void nopn_set_dac_sample(int value) {
  g_dac_sample = value & 0xff;
}

void nopn_write_reg(int port, int addr, int data) {
  nopn_ensure_init();
  const int base = (port & 1) ? 2 : 0;
  OPN2_Write(&g_chip, base, (uint8_t)(addr & 0xff));
  nopn_clock_cycles(24);
  OPN2_Write(&g_chip, base + 1, (uint8_t)(data & 0xff));
  nopn_clock_cycles(24);
}

int nopn_get_buffer_ptr(void) {
  return (int)(uintptr_t)g_buffer;
}

int nopn_get_channel_buffer_ptr(void) {
  return (int)(uintptr_t)g_ch_buffer;
}

double nopn_get_native_sample_rate(void) {
  return 7670454.0 / 144.0;
}

int nopn_render(int sample_count) {
  nopn_ensure_init();

  if (sample_count < 0) {
    return 0;
  }
  if (sample_count > NOPN_MAX_RENDER_SAMPLES) {
    sample_count = NOPN_MAX_RENDER_SAMPLES;
  }

  for (int sample_index = 0; sample_index < sample_count; sample_index++) {
    int32_t acc_l = 0;
    int32_t acc_r = 0;
    for (int i = 0; i < NOPN_CLOCKS_PER_SAMPLE; i++) {
      // Restream the DAC byte within this sample's clock budget: select the
      // 0x2a data register, then write the value a few cycles later so the
      // address latch has settled. No extra clocks are spent.
      if (g_dac_enabled) {
        if (i == 0) {
          OPN2_Write(&g_chip, 0, 0x2a);
        } else if (i == 8) {
          OPN2_Write(&g_chip, 1, (uint8_t)g_dac_sample);
        }
      }
      int16_t frame[2] = {0, 0};
      OPN2_Clock(&g_chip, frame);
      acc_l += frame[0];
      acc_r += frame[1];
    }
    g_buffer[sample_index * 2] = (int16_t)(acc_l / NOPN_CLOCKS_PER_SAMPLE);
    g_buffer[sample_index * 2 + 1] = (int16_t)(acc_r / NOPN_CLOCKS_PER_SAMPLE);

    // Per-channel scope taps: after a full 24-clock sample every channel's
    // ch_out holds the value computed for this sample. With the DAC on,
    // channel 6's slot in the mix is the DAC byte, so tap dacdata instead.
    int16_t *ch_tap = &g_ch_buffer[sample_index * 6];
    for (int c = 0; c < 6; c++) {
      ch_tap[c] = g_chip.ch_out[c];
    }
    if (g_dac_enabled) {
      ch_tap[5] = g_chip.dacdata;
    }
  }

  return sample_count;
}

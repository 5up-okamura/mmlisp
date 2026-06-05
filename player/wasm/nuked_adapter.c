#include <stdint.h>

#include "ym3438.h"

#define NOPN_CLOCKS_PER_SAMPLE 24
#define NOPN_MAX_RENDER_SAMPLES 4096

static ym3438_t g_chip;
static int16_t g_buffer[NOPN_MAX_RENDER_SAMPLES * 2];
static int g_initialized = 0;

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
      int16_t frame[2] = {0, 0};
      OPN2_Clock(&g_chip, frame);
      acc_l += frame[0];
      acc_r += frame[1];
    }
    g_buffer[sample_index * 2] = (int16_t)(acc_l / NOPN_CLOCKS_PER_SAMPLE);
    g_buffer[sample_index * 2 + 1] = (int16_t)(acc_r / NOPN_CLOCKS_PER_SAMPLE);
  }

  return sample_count;
}

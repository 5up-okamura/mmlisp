#include <stdint.h>

#include "ympsg.h"

// Nuked-PSG renders one native sample per 16 chip clocks. For the SEGA
// Mega Drive PSG the chip clock is the NTSC Z80 clock (3.579545 MHz), so the
// native sample rate is 3579545 / 16 ~= 223722 Hz. The worklet decimates this
// down to the AudioContext rate.
#define PSG_MASTER_CLOCK 3579545.0
#define PSG_CLOCK_DIV 16.0
#define PSG_MAX_RENDER_SAMPLES 4096

static ympsg_t g_chip;
static float g_buffer[PSG_MAX_RENDER_SAMPLES];
static int g_initialized = 0;

static void psg_ensure_init(void) {
  if (g_initialized) {
    return;
  }
  YMPSG_Init(&g_chip);
  g_initialized = 1;
}

int psg_init(void) {
  psg_ensure_init();
  return 1;
}

void psg_reset(void) {
  YMPSG_Init(&g_chip);
  g_initialized = 1;
}

// Feed a raw SN76489 latch/data byte. YMPSG_WriteBuffered schedules the write
// in the chip's own sample-time so back-to-back latch+data bytes are applied in
// order without us having to clock between them by hand.
void psg_write(int byte) {
  psg_ensure_init();
  YMPSG_WriteBuffered(&g_chip, (uint8_t)(byte & 0xff));
}

int psg_get_buffer_ptr(void) {
  return (int)(uintptr_t)g_buffer;
}

double psg_get_native_sample_rate(void) {
  return PSG_MASTER_CLOCK / PSG_CLOCK_DIV;
}

// Generate `sample_count` native samples into g_buffer. Output is the raw
// Nuked-PSG mix: a *unipolar* sum of up to four channels, each in [0, 1]
// (silence = 0). The worklet box-filter decimates, DC-blocks, and scales it.
int psg_render(int sample_count) {
  psg_ensure_init();

  if (sample_count < 0) {
    return 0;
  }
  if (sample_count > PSG_MAX_RENDER_SAMPLES) {
    sample_count = PSG_MAX_RENDER_SAMPLES;
  }

  for (int i = 0; i < sample_count; i++) {
    int32_t v = 0;
    YMPSG_Generate(&g_chip, &v);
    g_buffer[i] = (float)v / 8192.0f;
  }

  return sample_count;
}

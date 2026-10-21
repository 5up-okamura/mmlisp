// ---------------------------------------------------------------------------
// Target profiles: what one machine's sound hardware is, for the toolchain.
//
// The IR is chip-agnostic; a target decides what a score's channels are, the
// clocks every pitch and timer is computed from, how a PSG write is encoded,
// and how PCM plays. The Mega Drive (`md`) is the default and the only target
// with a driver of its own (MMLispDRV); the others are delivered as VGM
// (docs/roadmap.md, "Other machines, as VGM").
//
// A profile is data plus the few encoders that differ between chips. Code
// that must stay Mega Drive only — the MMB exporter, drv-player, the C
// sequencer — does not read it.
// ---------------------------------------------------------------------------

// SN76489 (the Mega Drive's PSG): one write port, a byte stream. A write is
// [port, addr, data]; port 2 is the PSG in the worklet protocol.
const SN76489 = {
  chip: "sn76489",
  clock: 3579545,
  // The tone counter divides the clock by 32 per period step; 1..1023.
  period(hz) {
    return Math.max(1, Math.min(1023, Math.round(this.clock / (32 * hz))));
  },
  // Attenuation 0 (loud) .. 15 (silent): latch | ch | r=1 | att.
  att(ch, att) {
    return [[2, 0, 0x80 | ((ch & 0x03) << 5) | 0x10 | (att & 0x0f)]];
  },
  // Tone period: the latch byte carries its low 4 bits, the data byte the
  // high 6.
  tone(ch, period) {
    return [
      [2, 0, 0x80 | ((ch & 0x03) << 5) | (period & 0x0f)],
      [2, 0, (period >> 4) & 0x3f],
    ];
  },
  // Noise control (channel 3): FB + NF, the 0–7 NOISE_MODE value.
  noise(mode) {
    return [[2, 0, 0x80 | (0x03 << 5) | (mode & 0x07)]];
  },
};

export const TARGETS = {
  md: {
    name: "md",
    system: "Sega Mega Drive",
    preview: true,
    // The score's channels, by kind. `fm3`'s special-mode and CSM tracks are
    // the FM part's (both OPN chips have them).
    channels: {
      fm: ["fm1", "fm2", "fm3", "fm4", "fm5", "fm6"],
      fm3: ["fm3-1", "fm3-2", "fm3-3", "fm3-4", "fm3-csm", "fm3-csm-rate"],
      psg: ["sqr1", "sqr2", "sqr3", "noise"],
      pcm: ["pcm1", "pcm2", "pcm3"],
    },
    // YM2612. `fnumRate` is the F-number formula's clock / 144, as the
    // driver's pitch tables are generated from it (rounded: 53,267 Hz).
    fm: { chip: "ym2612", clock: 7670454, fnumRate: 53267 },
    psg: SN76489,
    // PCM is up to three voices soft-mixed on the Z80 into fm6's DAC: the
    // song's voice count picks the engine image (`:pcm-voices`), and a score
    // with PCM owns fm6 (language.md §16).
    pcm: { model: "dac-mix", dacChannel: "fm6", maxVoices: 3 },
  },
  // PC-8801 with Sound Board II (YM2608 / OPNA; PC-98's 86 board has no
  // ADPCM RAM). No driver: the score is delivered as VGM. `preview` is false
  // until its encoder and emulator exist — the compiler checks a pc88 score,
  // nothing plays it yet (docs/roadmap.md).
  pc88: {
    name: "pc88",
    system: "NEC PC-8801",
    preview: false,
    channels: {
      fm: ["fm1", "fm2", "fm3", "fm4", "fm5", "fm6"],
      fm3: ["fm3-1", "fm3-2", "fm3-3", "fm3-4", "fm3-csm", "fm3-csm-rate"],
      // The SSG's three channels; `noise` is sqr3 with its mixer on noise.
      psg: ["sqr1", "sqr2", "sqr3", "noise"],
      // pcm1 is the ADPCM-B (a kit role there plays its :file); pcm2 and
      // pcm3 play the rhythm sounds.
      pcm: ["pcm1", "pcm2", "pcm3"],
    },
    fm: { chip: "ym2608", clock: 7987200, fnumRate: 7987200 / 144 },
    // The SSG at the chip's clock / 4; tone and noise divide it by 16. The
    // song's noise period starts at 9, the nearest to the Mega Drive's white0.
    psg: { chip: "ssg", clock: 7987200 / 4, noiseRate: 9 },
    // The six rhythm sounds in the chip's ROM, each the kit role of that
    // name (guide.md, the kits) — built in where the score defines none —
    // and one ADPCM-B voice for every other sample (pcm1's).
    pcm: {
      model: "opna",
      adpcmChannel: "pcm1",
      rhythm: { kick: "bd", snare: "sd", ride: "top", hat: "hh", tom4: "tom", rim: "rim" },
    },
  },
};

export const DEFAULT_TARGET = "md";

/** The profile for `name` (a score's `:target`), or the Mega Drive's. */
export function targetProfile(name) {
  return TARGETS[name ?? DEFAULT_TARGET] ?? TARGETS[DEFAULT_TARGET];
}

/** Every channel name the target has, in the order the compiler lists them. */
export function targetChannelNames(profile) {
  const c = profile.channels;
  return [...c.fm.slice(0, 3), ...c.fm3, ...c.fm.slice(3), ...c.psg, ...c.pcm];
}

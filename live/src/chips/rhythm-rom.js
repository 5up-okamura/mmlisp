// The YM2608's rhythm: six sounds in the chip's ROM, keyed by one register,
// each a voice of its own with its own level and pan. They are the kits'
// roles of the same name (guide.md, the kits), built in where a score
// defines none; a sound has no pitch, no loop and no range, and a def's :fx
// does not reach it.
import { pitchToMidi } from "../ir-utils.js";
import { words } from "./parts.js";
import { resample } from "./adpcm-b.js";

export const rhythmRom = {
  name: "rhythm",
  label: "ROM rhythm",
  kind: "sample",
  words: words("PAN"), // each hit's, with its level
  level: { stepDb: 0.75, steps: 32 }, // the IL, 31 loud .. 0
  points: false,
  kit: { kick: "bd", snare: "sd", ride: "top", hat: "hh", tom4: "tom", rim: "rim" },
  // A hit sounds on its sound: the `:prio` layers of one track compete only
  // with the same sound's notes, and one track plays all six at once.
  voiceOf(ev, sampleDefs) {
    return ev.cmd === "PCM_NOTE_ON" ? sampleDefs.get(ev.args?.sample)?.rhythm ?? "" : "";
  },
  checkNote({ sample, sampleName, pitch, mode, target, once }) {
    const file = target.headsOf("adpcm-b")[0];
    const elsewhere = file ? `play its :file on ${file} (the ADPCM-B)` : "it has no sound here";
    if (!sample.rhythm) {
      once(`adpcm:${sampleName}`, `on ${target.name} ${target.headsOf("rhythm").join(" and ")} play the ROM rhythm sounds, ${Object.keys(this.kit).join(" ")}; ${sampleName} is not one — ${elsewhere}`);
      return;
    }
    const what = `the ROM rhythm sound ${sample.rhythm} (${sampleName})`;
    if (mode === "loop") once(`loop:${sampleName}`, `${what} plays once; it has no loop`);
    if (pitchToMidi(pitch) !== 60)
      once(`pitch:${sampleName}`, `${what} has no pitch: write it at c4${file ? `, or ${elsewhere}` : ""}`);
    if (sample.fxNode || sample.importFx?.length)
      once(`fx:${sampleName}`, `${sampleName}'s :fx shapes its :file; ${what} plays as the chip has it`, "warning");
  },
};

// --- the stand-in ROM ------------------------------------------------------
//
// The ROM is Yamaha's and does not ship. Without the user's, a score's kit
// stands in for it: each role's :file encoded as the chip's ADPCM-A into an
// 8 KB image laid out as the ROM is (MAME / ymfm), so the chip plays it with
// its own level, pan and dump. A sound is cut to its slot's length — the
// ROM's sounds are short — and fades out over its last 2 ms there.

// Each sound's slot (byte addresses, the end inclusive) and the rate the chip
// reads it at: one sample every 3 FM samples (clock / 432), TOM and RIM every
// other of those.
const ROM_BYTES = 0x2000;
const ADPCM_A_RATE = 7987200 / 432;
// A kit's samples are normalized near full scale, which the ROM's sounds are
// not: the stand-in plays them this much lower (by ear, against mucom88).
const STAND_IN_DB = -3;
const SLOTS = {
  bd: [0x0000, 0x01bf, 1], sd: [0x01c0, 0x043f, 1], top: [0x0440, 0x1b7f, 1],
  hh: [0x1b80, 0x1cff, 1], tom: [0x1d00, 0x1f7f, 2], rim: [0x1f80, 0x1fff, 2],
};

/** How long each ROM sound plays from its key, in seconds. */
export const ROM_SOUND_SEC = Object.fromEntries(
  Object.entries(SLOTS).map(([k, [a, b, div]]) => [k, ((b - a + 1) * 2 * div) / ADPCM_A_RATE]),
);

const STEPS = [
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544,
  598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552,
];
const STEP_INC = [-1, -1, -1, -1, 2, 5, 7, 9];

// A box-filtered downsample, or a linear upsample.
function toRate(data, from, to) {
  if (to < from) return resample(data, from, to);
  const n = Math.floor((data.length * to) / from), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i * from) / to, k = Math.floor(t), f = t - k;
    out[i] = data[k] * (1 - f) + (data[k + 1] ?? data[k]) * f;
  }
  return out;
}

// Yamaha ADPCM-A (12-bit, the accumulator wrapping as the chip's does): each
// nibble the one whose decode lands nearest the signal. `bytes` long; past
// the signal it holds the level where it is.
function encodeAdpcmA(pcm, bytes) {
  const out = new Uint8Array(bytes);
  let acc = 0, step = 0;
  for (let i = 0; i < bytes * 2; i++) {
    const x = i < pcm.length ? Math.max(-2048, Math.min(2047, Math.round(pcm[i] * 2048))) : 0;
    let best = 0, bestErr = Infinity, bestAcc = 0;
    for (let n = 0; n < 16; n++) {
      let d = ((2 * (n & 7) + 1) * STEPS[step]) >> 3;
      if (n & 8) d = -d;
      const a = (((acc + d) & 0xfff) << 20) >> 20; // sign-extended 12 bits
      const err = Math.abs(a - x);
      if (err < bestErr) { bestErr = err; best = n; bestAcc = a; }
    }
    acc = bestAcc;
    step = Math.max(0, Math.min(48, step + STEP_INC[best & 7]));
    out[i >> 1] |= i & 1 ? best : best << 4;
  }
  return out;
}

/**
 * The stand-in ROM for a score's rhythm: the roles it plays that have a
 * :file, from their decoded blobs ({ name: { data, baseRate } }). Returns
 * { rom, roles } — roles the kit names that stand in — or null when none do.
 */
export function bakeRhythmStandIn(ir, blobs) {
  const rom = new Uint8Array(ROM_BYTES);
  const roles = [];
  for (const s of ir.metadata?.samples ?? []) {
    const slot = SLOTS[s.rhythm];
    const blob = s.file && blobs?.[s.name];
    if (!slot || !blob?.data?.length) continue;
    const [start, end, div] = slot;
    const srcRate = blob.baseRate ?? s.rate ?? 16000;
    const a = Math.max(0, Math.round((s.startSec ?? 0) * srcRate));
    const b = s.endSec != null ? Math.min(blob.data.length, Math.round(s.endSec * srcRate)) : blob.data.length;
    const rate = ADPCM_A_RATE / div;
    const bytes = end - start + 1;
    const pcm = Float32Array.from(toRate(blob.data.subarray(a, Math.max(a, b)), srcRate, rate).subarray(0, bytes * 2));
    const g = 10 ** (STAND_IN_DB / 20);
    for (let i = 0; i < pcm.length; i++) pcm[i] *= g;
    const fade = Math.min(pcm.length, Math.round(rate * 0.002));
    if (pcm.length === bytes * 2) for (let i = 0; i < fade; i++) pcm[pcm.length - 1 - i] *= i / fade;
    rom.set(encodeAdpcmA(pcm, bytes), start);
    roles.push(s.name);
  }
  if (!roles.length) return null;
  // The slots no :file fills hold silence: zeros are none to the decoder.
  const filled = new Set(ir.metadata.samples.filter((s) => roles.includes(s.name)).map((s) => s.rhythm));
  for (const [sound, [start, end]] of Object.entries(SLOTS))
    if (!filled.has(sound)) rom.set(encodeAdpcmA(new Float32Array(0), end - start + 1), start);
  return { rom, roles };
}

// ---------------------------------------------------------------------------
// DefleMask module (.dmf) → the tracker model (import-tracker.js)
//
// The layout follows Furnace's DMF loader (src/engine/fileOps/dmf.cpp), the
// reference for every DefleMask version: a zlib stream holding
// the header, the order matrix, instruments, wavetables, patterns (stored
// once per order entry), and samples. Read from version
// 0x0d (DefleMask v5.1), with Furnace's conversions of the older layouts.
// ---------------------------------------------------------------------------

import { inflate, readArp, convertLegacySamples } from "./import-tracker.js";

// The systems, by DMF id: each channel's kind (import-tracker.js
// CHANNEL_KINDS), the name the dialog shows and its chip family (import-fur.js).
const ch = (kind, name, chip) => ({ kind, name, ...(chip ? { chip } : {}) });
const fm = (n, from = 1, chip = "ym2612") => Array.from({ length: n }, (_, i) => ch("fm", `FM${i + from}`, chip));
const sn = [ch("psg", "SQ1", "sn76489"), ch("psg", "SQ2", "sn76489"), ch("psg", "SQ3", "sn76489"), ch("noise", "Noise", "sn76489")];
const ssg = [1, 2, 3].map((i) => ch("psg", `SSG${i}`, "ssg"));
// The 2A03's channels (chips/rp2a03.js), which an fc score keeps.
// (`legacy`: a channel of the legacy sample mode — import-tracker.js
// convertLegacySamples.)
const nes = [ch("psg", "Pulse 1"), ch("psg", "Pulse 2"), ch("wave", "Triangle"), ch("noise", "Noise"), { ...ch("pcm", "DPCM"), legacy: "always" }]
  .map((c) => ({ ...c, chip: "nes" }));
const DMF_SYSTEMS = {
  0x02: { name: "Genesis", channels: [...fm(5), { ...ch("fm", "FM6", "ym2612"), legacy: "toggle" }, ...sn] },
  0x42: { name: "Genesis (ext. CH3)", channels: [...fm(2), ...[1, 2, 3, 4].map((i) => ch("fm3op", `FM3 OP${i}`, "ym2612")),
    ...fm(2, 4), { ...ch("fm", "FM6", "ym2612"), legacy: "toggle" }, ...sn] },
  0x03: { name: "Master System", channels: sn },
  0x43: { name: "Master System + FM", channels: [...sn, ...Array.from({ length: 9 }, (_, i) => ch("opll", `FM${i + 1}`, "opll"))] },
  0x04: { name: "Game Boy", channels: [ch("psg", "Pulse 1"), ch("psg", "Pulse 2"), ch("wave", "Wave"), ch("noise", "Noise")] },
  // The HuC6280's channels (chips/huc6280.js): a 5-bit volume, their own
  // wavetables, 5 and 6 able to turn to noise.
  0x05: { name: "PC Engine", channels: Array.from({ length: 6 }, (_, i) => ({ ...ch("wave", `CH${i + 1}`), chip: "pce", volMax: 31 })) },
  0x06: { name: "NES", channels: nes },
  0x46: { name: "NES + VRC7", channels: [...nes, ...Array.from({ length: 6 }, (_, i) => ch("opll", `VRC7 ${i + 1}`))] },
  0x86: { name: "NES + FDS", channels: [...nes, ch("wave", "FDS")] },
  0x07: { name: "C64 (8580)", channels: Array.from({ length: 3 }, (_, i) => ch("psg", `SID ${i + 1}`)) },
  0x47: { name: "C64 (6581)", channels: Array.from({ length: 3 }, (_, i) => ch("psg", `SID ${i + 1}`)) },
  0x08: { name: "Arcade (YM2151 + SegaPCM)", channels: [...Array.from({ length: 8 }, (_, i) => ch("opm", `FM${i + 1}`, "opm")),
    ...Array.from({ length: 5 }, (_, i) => ch("pcm", `PCM${i + 1}`))] },
  0x09: { name: "Neo Geo CD", channels: [...fm(4, 1, "opn"), ...ssg,
    ...Array.from({ length: 6 }, (_, i) => ch("pcm", `ADPCM-A ${i + 1}`))] },
  0x49: { name: "Neo Geo CD (ext. CH2)", channels: [ch("fm", "FM1", "opn"), ...[1, 2, 3, 4].map((i) => ch("fm3op", `FM2 OP${i}`, "opn")),
    ch("fm", "FM3", "opn"), ch("fm", "FM4", "opn"), ...ssg, ...Array.from({ length: 6 }, (_, i) => ch("pcm", `ADPCM-A ${i + 1}`))] },
  0x0a: { name: "MSX + SCC", channels: [ch("psg", "PSG1", "ssg"), ch("psg", "PSG2", "ssg"), ch("psg", "PSG3", "ssg"),
    ...Array.from({ length: 5 }, (_, i) => ch("wave", `SCC${i + 1}`, "scc"))] },
};

// A sample's rate by its code, and the step its pitch reads it at (Furnace's
// fileToDivRate and samplePitches).
const DMF_RATES = [4000, 8000, 11025, 16000, 22050, 32000];
const DMF_PITCHES = [0.1666666666, 0.2, 0.25, 0.333333333, 0.5, 1, 2, 3, 4, 5, 6];

/** @returns {Promise<object>} the tracker model (import-tracker.js) */
export async function parseDmf(bytes) {
  const u8 = await inflate(bytes);
  let p = 0;
  const end = () => { if (p > u8.length) throw new Error("DMF: unexpected end of file"); };
  const c = () => { end(); return u8[p++]; };
  const s16 = () => { const v = u8[p] | (u8[p + 1] << 8); p += 2; end(); return (v << 16) >> 16; };
  const i32 = () => { const v = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24); p += 4; end(); return v; };
  const str = (n) => { const d = u8.subarray(p, p + n); p += n; end(); return new TextDecoder("latin1").decode(d); };
  const pstr = () => str(c());

  if (str(16) !== ".DelekDefleMask.") throw new Error("not a DefleMask module");
  const version = c();
  if (version < 0x0d) throw new Error(`DMF version 0x${version.toString(16)} is too old (DefleMask v5.1 or later is needed)`);
  if (version > 0x1b) throw new Error(`DMF version 0x${version.toString(16)} is newer than this importer knows`);
  const sysId = c();
  const system = DMF_SYSTEMS[sysId];
  if (!system) throw new Error(`DMF system 0x${sysId.toString(16)} is not supported`);
  const nch = system.channels.length;
  const title = pstr();
  const author = pstr();
  const hilightA = c();
  const hilightB = c();
  const timeBase = c();
  const speed1 = c();
  const speed2 = c();
  const ntsc = c();
  const customHz = c();
  const hzText = str(3);
  let hz = ntsc ? 60 : 50;
  if (customHz && +hzText > 0) hz = +hzText;
  const patLen = version > 0x17 ? i32() : c();
  const ordersLen = c();
  if (version < 0x14) c(); // the arpeggio's tick length (not read)

  const orders = Array.from({ length: ordersLen }, () => new Array(nch).fill(0));
  for (let i = 0; i < nch; i++) {
    for (let j = 0; j < ordersLen; j++) {
      orders[j][i] = c();
      if (version > 0x18) pstr(); // pattern name
    }
  }

  const instruments = [];
  const nins = c();
  for (let i = 0; i < nins; i++) {
    const name = pstr();
    const mode = c();
    if (mode) {
      // Before 0x13 each word had a spare byte after it, the operators
      // the OPL's words between theirs (Furnace's dmf.cpp).
      const old = version < 0x13;
      const alg = c(); if (old) c();
      const fb = c(); if (old) c();
      const fms = c(); if (old) { c(); c(); } // spare, the operator count
      const ams = c();
      const ops = [];
      for (let j = 0; j < 4; j++) {
        const am = c(), ar = c(); if (old) c(); // dam
        const dr = c(); if (old) { c(); c(); c(); if (version < 0x11) c(); } // dvb, egt, ksl, ksr
        const mul = c(), rr = c(), sl = c(); if (old) c(); // sus
        const tl = c();
        c(); if (old) c(); // dt2 (OPM); before 0x13 vib, ws
        const rs = c(), dt = c(), sr = c(), ssg = c();
        ops.push({ am, ar, dr, mul, rr, sl, tl, rs, dt, sr, ssg: ssg & 8 ? ssg & 15 : 0 });
      }
      instruments.push({ name, kind: "fm", fm: { alg, fb, fms, ams, ops } });
    } else {
      const macro = (wide = version >= 0x0e) => {
        const len = c();
        const values = [];
        for (let j = 0; j < len; j++) values.push(wide ? i32() : c());
        const loop = len > 0 ? c() : 255;
        return { values, loop: loop < len ? loop : null };
      };
      const gb = sysId === 0x04;
      const vol = gb && version >= 0x12 ? { values: [], loop: null } : macro();
      const arp = macro();
      const arpFixed = version > 0x0f ? c() : 0;
      if (!arpFixed) arp.values = arp.values.map((v) => v - 12);
      const duty = macro(); // duty, or the noise switch (the PC Engine's)
      const wave = macro(); // the wavetable each tick: an index into `waves`
      if (sysId === 0x07 || sysId === 0x47) p += version < 0x11 ? 23 : 20; // SID settings
      if (gb && version >= 0x12) p += 4; // GB envelope
      instruments.push({ name, kind: "std", vol, arp: readArp(arp, !!arpFixed), wave, duty });
    }
  }

  // The wavetables: each its steps, 0..31 on the systems with a 5-bit wave
  // (DefleMask's wavetable height is the system's).
  const waves = [];
  const nwaves = c();
  for (let i = 0; i < nwaves; i++) {
    const len = i32();
    const values = [];
    for (let j = 0; j < len; j++) values.push(version < 0x0e ? c() : i32());
    waves.push({ name: "", values, height: sysId === 0x05 ? 31 : 15 });
  }

  const channels = system.channels.map((sc) => ({ ...sc, patterns: new Map() }));
  for (let i = 0; i < nch; i++) {
    const cols = c();
    for (let j = 0; j < ordersLen; j++) {
      const rows = [];
      for (let k = 0; k < patLen; k++) {
        const note = s16();
        let octave = s16();
        // Furnace's corrections (dmf.cpp): the SMS's and the Genesis PSG's
        // octaves read one lower before 0x0e, the Game Boy noise's two
        // lower before 0x12, the MSX PSG's one higher (every version).
        if (octave > 0) {
          if (version < 0x0e && (sysId === 0x03 || (sysId === 0x02 && i > 5))) octave--;
          else if (sysId === 0x0a && i < 3) octave++;
          if (version < 0x12 && sysId === 0x04 && i === 3) octave -= 2;
        }
        let vol = s16();
        // The Game Boy's wave volume was 0-3 before 0x12.
        if (version < 0x12 && sysId === 0x04 && i === 2 && vol > 0) vol = (vol & 3) * 5;
        const fx = [];
        for (let l = 0; l < cols; l++) {
          const code = s16();
          let val = s16();
          if ((code === 0x09 || code === 0x0f) && val !== -1) val = Math.max(1, Math.min(255, val * (timeBase + 1)));
          // E5xx: a quarter of the range before 0x14; twice it on the YM2151.
          if (code === 0xe5 && val !== -1) {
            if (version < 0x14) val = 128 + Math.trunc((val - 128) / 4);
            if (sysId === 0x08) val = Math.max(0, Math.min(255, 2 * ((val & 0xff) - 0x80) + 0x80));
          }
          if (code !== -1) fx.push([code, val]);
        }
        const ins = s16();
        rows.push({ note: splitNote(note, octave), vol, ins, fx });
      }
      channels[i].patterns.set(orders[j][i], rows);
    }
  }

  // The samples, as Furnace reads them: 16-bit words (an 8-bit sample's
  // unsigned), at one of six rates, stretched by the pitch (5 is 1:1) and
  // scaled by the amp (50 is 1:1), then cut (from 0x1b).
  const samples = [];
  const nsamples = c();
  for (let i = 0; i < nsamples; i++) {
    const length = i32();
    const name = version > 0x16 ? pstr() : "";
    const rate = DMF_RATES[Math.max(0, Math.min(5, c()))];
    let pitch = c();
    if (pitch > 10) pitch = 5;
    const mult = c() / 50;
    const depth = version > 0x15 ? (c() === 8 ? 8 : 16) : 16;
    let cutStart = 0, cutEnd = -1;
    if (version >= 0x1b) { cutStart = i32(); cutEnd = i32(); }
    const words = Array.from({ length }, () => s16());
    const step = DMF_PITCHES[pitch];
    const top = depth === 8 ? 128 : 32768;
    const scaled = [];
    for (let j = 0; j < length && scaled.length < Math.ceil(length / step); j += step) {
      const v = (depth === 8 ? words[Math.floor(j)] - 0x80 : words[Math.floor(j)]) * mult;
      scaled.push(Math.trunc(Math.max(-top, Math.min(top - 1, v))) / top);
    }
    while (scaled.length < Math.ceil(length / step)) scaled.push(0);
    const data = Float32Array.from(cutEnd >= cutStart && cutEnd <= scaled.length && (cutStart > 0 || cutEnd < scaled.length)
      ? scaled.slice(cutStart, cutEnd) : scaled);
    samples.push({ name, rate, depth, data, loop: null });
  }

  const t = {
    format: "DefleMask", system: system.name, title, author, hz,
    rowsPerBeat: hilightA, rowsPerBar: hilightB,
    speeds: [speed1 * (timeBase + 1), speed2 * (timeBase + 1)],
    patLen, orders, channels, instruments, waves,
    fmVolMax: 127, psgVolMax: 15,
    linearPitch: true, pitchSlideSpeed: 4, // as Furnace plays a DMF
    properNoiseLayout: false, // the PC Engine's noise rate by DefleMask's table
    newVolumeScaling: false, // a volume macro's 4-bit steps added to the column's (Furnace's dmf.cpp)
    samples,
  };
  convertLegacySamples(t);
  return t;
}

// note 1-12 (C# … C of the next octave) + octave → a semitone count where
// C-0 is 0, as Furnace reads it (dmf.cpp, splitNoteToNote); a C is also
// written as note 0 of its own octave. 100 is note off, 101/102 release.
function splitNote(note, octave) {
  if (note === 100 || note === 101 || note === 102) return "off";
  if (note === 0) return octave === 0 ? null : octave * 12;
  return note + octave * 12;
}

// ---------------------------------------------------------------------------
// DefleMask module (.dmf) → the tracker model (import-tracker.js)
//
// The layout follows Furnace's DMF loader (src/engine/fileOps/dmf.cpp), the
// reference for every DefleMask version since 0.12: a zlib stream holding
// the header, the order matrix, instruments, wavetables, patterns (stored
// once per order entry), and samples, which are not read.
// ---------------------------------------------------------------------------

import { inflate } from "./import-tracker.js";

// The systems, by DMF id: each channel's kind (import-tracker.js
// CHANNEL_KINDS) and the name the dialog shows.
const ch = (kind, name) => ({ kind, name });
const fm = (n, from = 1) => Array.from({ length: n }, (_, i) => ch("fm", `FM${i + from}`));
const sn = [ch("psg", "SQ1"), ch("psg", "SQ2"), ch("psg", "SQ3"), ch("noise", "Noise")];
const nes = [ch("psg", "Pulse 1"), ch("psg", "Pulse 2"), ch("wave", "Triangle"), ch("noise", "Noise"), ch("pcm", "DPCM")];
export const DMF_SYSTEMS = {
  0x02: { name: "Genesis", channels: [...fm(6), ...sn] },
  0x42: { name: "Genesis (ext. CH3)", channels: [...fm(2), ch("fm3op", "FM3 OP1"), ch("fm3op", "FM3 OP2"),
    ch("fm3op", "FM3 OP3"), ch("fm3op", "FM3 OP4"), ...fm(3, 4), ...sn] },
  0x03: { name: "Master System", channels: sn },
  0x43: { name: "Master System + FM", channels: [...sn, ...Array.from({ length: 9 }, (_, i) => ch("opll", `FM${i + 1}`))] },
  0x04: { name: "Game Boy", channels: [ch("psg", "Pulse 1"), ch("psg", "Pulse 2"), ch("wave", "Wave"), ch("noise", "Noise")] },
  0x05: { name: "PC Engine", channels: Array.from({ length: 6 }, (_, i) => ch("wave", `CH${i + 1}`)) },
  0x06: { name: "NES", channels: nes },
  0x46: { name: "NES + VRC7", channels: [...nes, ...Array.from({ length: 6 }, (_, i) => ch("opll", `VRC7 ${i + 1}`))] },
  0x86: { name: "NES + FDS", channels: [...nes, ch("wave", "FDS")] },
  0x07: { name: "C64 (8580)", channels: Array.from({ length: 3 }, (_, i) => ch("psg", `SID ${i + 1}`)) },
  0x47: { name: "C64 (6581)", channels: Array.from({ length: 3 }, (_, i) => ch("psg", `SID ${i + 1}`)) },
  0x08: { name: "Arcade (YM2151 + SegaPCM)", channels: [...Array.from({ length: 8 }, (_, i) => ch("opm", `FM${i + 1}`)),
    ...Array.from({ length: 5 }, (_, i) => ch("pcm", `PCM${i + 1}`))] },
  0x09: { name: "Neo Geo CD", channels: [...fm(4), ch("psg", "SSG1"), ch("psg", "SSG2"), ch("psg", "SSG3"),
    ...Array.from({ length: 6 }, (_, i) => ch("pcm", `ADPCM-A ${i + 1}`))] },
  0x49: { name: "Neo Geo CD (ext. CH2)", channels: [ch("fm", "FM1"), ch("fm3op", "FM2 OP1"), ch("fm3op", "FM2 OP2"),
    ch("fm3op", "FM2 OP3"), ch("fm3op", "FM2 OP4"), ch("fm", "FM3"), ch("fm", "FM4"),
    ch("psg", "SSG1"), ch("psg", "SSG2"), ch("psg", "SSG3"), ...Array.from({ length: 6 }, (_, i) => ch("pcm", `ADPCM-A ${i + 1}`))] },
  0x0a: { name: "MSX + SCC", channels: [ch("psg", "PSG1"), ch("psg", "PSG2"), ch("psg", "PSG3"),
    ...Array.from({ length: 5 }, (_, i) => ch("wave", `SCC${i + 1}`))] },
};

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
  if (version < 0x13) throw new Error(`DMF version ${version} is too old (DefleMask 0.12 or later is needed)`);
  if (version > 0x1b) throw new Error(`DMF version ${version} is newer than this importer knows`);
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
      const alg = c(), fb = c(), fms = c(), ams = c();
      const ops = [];
      for (let j = 0; j < 4; j++) {
        const am = c(), ar = c(), dr = c(), mul = c(), rr = c(), sl = c(), tl = c();
        c(); // dt2 (OPM)
        const rs = c(), dt = c(), sr = c(), ssg = c();
        ops.push({ am, ar, dr, mul, rr, sl, tl, rs, dt, sr, ssg: ssg & 8 ? ssg & 15 : 0 });
      }
      instruments.push({ name, kind: "fm", fm: { alg, fb, fms, ams, ops } });
    } else {
      const macro = (wide = true) => {
        const len = c();
        const values = [];
        for (let j = 0; j < len; j++) values.push(wide ? i32() : c());
        const loop = len > 0 ? c() : 255;
        return { values, loop: loop < len ? loop : null };
      };
      const gb = sysId === 0x04;
      const vol = gb ? { values: [], loop: null } : macro();
      const arp = macro();
      const arpFixed = c();
      if (!arpFixed) arp.values = arp.values.map((v) => v - 12);
      macro(); // duty / noise
      macro(); // wavetable
      if (sysId === 0x07 || sysId === 0x47) p += 20; // SID settings
      if (gb) p += 4; // GB envelope
      instruments.push({ name, kind: "std", vol, arp: arpFixed ? { values: [], loop: null } : arp, arpFixed: !!arpFixed });
    }
  }

  const nwaves = c();
  for (let i = 0; i < nwaves; i++) {
    const len = i32();
    p += len * 4;
  }

  const channels = system.channels.map((sc) => ({ ...sc, patterns: new Map() }));
  for (let i = 0; i < nch; i++) {
    const cols = c();
    for (let j = 0; j < ordersLen; j++) {
      const rows = [];
      for (let k = 0; k < patLen; k++) {
        const note = s16();
        const octave = s16();
        const vol = s16();
        const fx = [];
        for (let l = 0; l < cols; l++) {
          const code = s16();
          let val = s16();
          if ((code === 0x09 || code === 0x0f) && val !== -1) val = Math.max(1, Math.min(255, val * (timeBase + 1)));
          if (code !== -1) fx.push([code, val]);
        }
        const ins = s16();
        rows.push({ note: splitNote(note, octave), vol, ins, fx });
      }
      channels[i].patterns.set(orders[j][i], rows);
    }
  }

  return {
    format: "DefleMask", system: system.name, title, author, hz,
    rowsPerBeat: hilightA, rowsPerBar: hilightB,
    speeds: [speed1 * (timeBase + 1), speed2 * (timeBase + 1)],
    patLen, orders, channels, instruments,
    fmVolMax: 127, psgVolMax: 15,
  };
}

// note 1-12 (C# … C of the next octave) + octave → a semitone count where
// C-0 is 0, as Furnace reads it (dmf.cpp, splitNoteToNote); a C is also
// written as note 0 of its own octave. 100 is note off, 101/102 release.
function splitNote(note, octave) {
  if (note === 100 || note === 101 || note === 102) return "off";
  if (note === 0) return octave === 0 ? null : octave * 12;
  return note + octave * 12;
}

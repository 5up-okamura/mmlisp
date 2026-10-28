// ---------------------------------------------------------------------------
// Furnace module (.fur) → the tracker model (import-tracker.js)
//
// The layout follows Furnace's own loader (src/engine/fileOps/fur.cpp,
// song.cpp DivSubSong::readData, instrument.cpp): a zlib stream with the
// song info (INFO, or INF2 + SNG2 from version 240), patterns (PATR, or
// the packed PATN from 157) and instruments (INS2 features, or the old INST
// block, whose FM part is read). Only the first subsong is imported.
// ---------------------------------------------------------------------------

import { inflate, readArp, convertLegacySamples } from "./import-tracker.js";

// Channel layouts by Furnace system id. A chip not listed plays its notes on
// a stand-in voice (its channel count comes from FUR_CHANNELS, or from the
// file itself from version 240). `chip` is the machine's chip family the
// channel is (import-tracker.js TARGET_CHIPS: the targets that play it as
// their own); `drum` a rhythm channel's sound.
const k = (kind, n, name) => Array.from({ length: n }, (_, i) => ({ kind, name: `${name}${n > 1 ? i + 1 : ""}` }));
const opn3op = (name, chip = "opn") => [{ kind: "fm", name: `${name} FM1` }, { kind: "fm", name: `${name} FM2` },
  ...[1, 2, 3, 4].map((i) => ({ kind: "fm3op", name: `${name} FM3 OP${i}` }))].map((c) => ({ ...c, chip }));
const named = (prefix, list, chip) => list.map((c) => ({ ...c, name: `${prefix} ${c.name}`, ...(chip ? { chip } : {}) }));
const SN = [...k("psg", 3, "SQ"), { kind: "noise", name: "Noise" }];
const SSG = k("psg", 3, "SSG");
const fmFrom = (n, from) => k("fm", n, "FM").map((c, i) => ({ ...c, name: `FM${i + from}` }));
// The YM2608's rhythm (its key bits' order) and the ADPCM-B; the OPLL's
// rhythm sounds (its channels 7-11 in drums mode).
const OPNA_RHYTHM = [["Kick", "kick"], ["Snare", "snare"], ["Top", "ride"], ["HiHat", "hat"], ["Tom", "tom4"], ["Rim", "rim"]]
  .map(([name, drum]) => ({ kind: "rhythm", name, drum, chip: "opna-rhythm", volMax: 31 }));
const OPNA_PCM = [...OPNA_RHYTHM, { kind: "pcm", name: "ADPCM-B", chip: "adpcm-b" }];
const OPLL_DRUMS = [["Kick", "kick"], ["Snare", "snare"], ["Tom", "tom4"], ["Top", "ride"], ["HiHat", "hat"]]
  .map(([name, drum]) => ({ kind: "rhythm", name, drum, chip: "opll-rhythm" }));
const ADPCM_A = (n) => k("pcm", n, "ADPCM-A ");
const FUR_SYSTEMS = {
  // (`legacy`: the channel that plays samples — the DAC, the DMC — whose
  // legacy sample mode a file before 239 has; import-tracker.js
  // convertLegacySamples.)
  0x83: () => named("YM2612", k("fm", 6, "FM"), "ym2612").map((c, i) => (i === 5 ? { ...c, legacy: "toggle" } : c)),
  0xa0: () => [...opn3op("YM2612", "ym2612"), ...named("YM2612", fmFrom(3, 4), "ym2612")]
    .map((c, i) => (i === 8 ? { ...c, legacy: "toggle" } : c)),
  0xbe: () => [...named("YM2612", k("fm", 5, "FM"), "ym2612"), ...k("pcm", 2, "DAC")],
  0xbd: () => [...opn3op("YM2612", "ym2612"), ...named("YM2612", fmFrom(2, 4), "ym2612"), ...k("pcm", 2, "DAC"),
    { kind: "pcm", name: "CSM" }],
  0xc1: () => [...opn3op("YM2612", "ym2612"), ...named("YM2612", fmFrom(3, 4), "ym2612"), { kind: "pcm", name: "CSM" }],
  0x03: () => named("SN76489", SN, "sn76489"),
  0xbf: () => named("T6W28", SN, "sn76489"),
  0x80: () => named("AY", SSG, "ssg"),
  0x9a: () => named("AY8930", SSG, "ssg"),
  0x82: () => named("YM2151", k("opm", 8, "FM"), "opm"),
  0x8d: () => [...named("YM2203", k("fm", 3, "FM"), "opn"), ...named("YM2203", SSG, "ssg")],
  0xb6: () => [...opn3op("YM2203"), ...named("YM2203", SSG, "ssg")],
  0x8e: () => [...named("YM2608", k("fm", 6, "FM"), "opn"), ...named("YM2608", SSG, "ssg"), ...named("YM2608", OPNA_PCM)],
  0xb7: () => [...opn3op("YM2608"), ...named("YM2608", fmFrom(3, 4), "opn"),
    ...named("YM2608", SSG, "ssg"), ...named("YM2608", OPNA_PCM)],
  0xa5: () => [...named("YM2610", k("fm", 4, "FM"), "opn"), ...named("YM2610", SSG, "ssg"), ...ADPCM_A(6), { kind: "pcm", name: "ADPCM-B" }],
  0xa6: () => [{ kind: "fm", name: "YM2610 FM1", chip: "opn" }, ...[1, 2, 3, 4].map((i) => ({ kind: "fm3op", name: `YM2610 FM2 OP${i}`, chip: "opn" })),
    ...named("YM2610", fmFrom(2, 3), "opn"), ...named("YM2610", SSG, "ssg"), ...ADPCM_A(6), { kind: "pcm", name: "ADPCM-B" }],
  0x9e: () => [...named("YM2610B", k("fm", 6, "FM"), "opn"), ...named("YM2610B", SSG, "ssg"), ...ADPCM_A(6), { kind: "pcm", name: "ADPCM-B" }],
  0xde: () => [...opn3op("YM2610B"), ...named("YM2610B", fmFrom(3, 4), "opn"),
    ...named("YM2610B", SSG, "ssg"), ...ADPCM_A(6), { kind: "pcm", name: "ADPCM-B" }],
  0x89: () => named("OPLL", k("opll", 9, "FM"), "opll"),
  0xa7: () => [...named("OPLL", k("opll", 6, "FM"), "opll"), ...named("OPLL", OPLL_DRUMS)],
  0x9d: () => named("VRC7", k("opll", 6, "FM")),
  0x8f: () => named("OPL", k("opl", 9, "FM")),
  0x90: () => named("OPL2", k("opl", 9, "FM")),
  0x91: () => named("OPL3", k("opl", 18, "FM")),
  0xa2: () => [...named("OPL", k("opl", 6, "FM")), ...k("pcm", 5, "Drum ")],
  0xa3: () => [...named("OPL2", k("opl", 6, "FM")), ...k("pcm", 5, "Drum ")],
  0xa4: () => [...named("OPL3", k("opl", 15, "FM")), ...k("pcm", 5, "Drum ")],
  0x04: () => named("GB", [...k("psg", 2, "Pulse"), { kind: "wave", name: "Wave" }, { kind: "noise", name: "Noise" }]),
  0x06: () => named("NES", [...k("psg", 2, "Pulse"), { kind: "wave", name: "Triangle" }, { kind: "noise", name: "Noise" }, { kind: "pcm", name: "DPCM" }])
    .map((c, i) => ({ ...c, chip: "nes", ...(i === 4 ? { legacy: "always" } : {}) })),
  0x05: () => named("PCE", k("wave", 6, "CH")).map((c) => ({ ...c, chip: "pce", volMax: 31 })),
  0x07: () => named("SID", k("psg", 3, "CH")),
  0x47: () => named("SID", k("psg", 3, "CH")),
  0x8b: () => named("MMC5", [...k("psg", 2, "Pulse"), { kind: "pcm", name: "PCM" }]),
  0x88: () => named("VRC6", [...k("psg", 2, "Pulse"), { kind: "wave", name: "Saw", volMax: 63 }], "vrc6"),
  0x8a: () => [{ kind: "wave", name: "FDS" }],
  0xa1: () => named("SCC", k("wave", 5, "CH"), "scc"),
  0xb4: () => named("SCC+", k("wave", 5, "CH"), "scc"),
  0x8c: () => named("N163", k("wave", 8, "CH")),
  0x81: () => named("Amiga", k("pcm", 4, "CH")),
  0x87: () => named("SNES", k("pcm", 8, "CH")),
  0x9b: () => named("SegaPCM", k("pcm", 16, "CH")),
  0xa9: () => named("SegaPCM", k("pcm", 5, "CH")),
};
// Furnace system id → channel count, for a chip FUR_SYSTEMS does not lay
// out in a file older than version 240 (which does not store the counts).
const FUR_CHANNELS = {
  0x01: 17, 0x84: 2, 0x85: 4, 0x86: 1, 0x92: 28, 0x93: 1, 0xfc: 1, 0x94: 4, 0x95: 8, 0x96: 4, 0x97: 6, 0x98: 8,
  0x99: 1, 0x9c: 6, 0x9f: 6, 0xa8: 4, 0xe0: 19, 0xac: 17, 0xb0: 16, 0xad: 2, 0xae: 42, 0xaf: 44, 0xb1: 32,
  0xb2: 10, 0xb3: 12, 0xb5: 8, 0xaa: 4, 0xab: 1, 0xb8: 8, 0xb9: 3, 0xba: 8, 0xbb: 8, 0xbc: 8, 0xc0: 1, 0xc6: 2,
  0xc7: 4, 0xe3: 4, 0xe5: 4, 0xc8: 3, 0xcb: 3, 0xca: 5, 0xcc: 4, 0xcd: 2, 0xce: 24, 0xcf: 16, 0xd1: 18, 0xd4: 4,
  0xd5: 6, 0xd7: 2, 0xd8: 16, 0xd6: 16, 0xf1: 5, 0xd9: 4, 0xf0: 3, 0xf5: 7, 0xe2: 4, 0xe4: 8, 0xe7: 1, 0xfd: 8,
};
// The pre-240 compound systems, split the way Furnace splits them.
// Neo Geo CD keeps its 13 (16) channels: no ADPCM-B.
const COMPOUND = { 0x02: [0x83, 0x03], 0x42: [0xa0, 0x03], 0x08: [0x82, 0xa9], 0x09: ["ngcd"], 0x49: ["ngcd-ext"] };
FUR_SYSTEMS.ngcd = () => [...named("YM2610", k("fm", 4, "FM"), "opn"), ...named("YM2610", SSG, "ssg"), ...ADPCM_A(6)];
FUR_SYSTEMS["ngcd-ext"] = () => FUR_SYSTEMS[0xa6]().slice(0, 16);

function layoutOf(id, count = null) {
  if (FUR_SYSTEMS[id]) {
    const chans = FUR_SYSTEMS[id]();
    if (count == null || count === chans.length) return chans;
    // A chip with a channel count other than its default: keep the kinds we
    // know, as many as there are.
    return Array.from({ length: count }, (_, i) => chans[i] ?? { kind: "wave", name: `CH${i + 1}` });
  }
  const n = count ?? FUR_CHANNELS[id];
  if (!n) throw new Error(`Furnace system 0x${id.toString(16)} is not known to this importer`);
  return Array.from({ length: n }, (_, i) => ({ kind: "wave", name: `chip 0x${id.toString(16)} CH${i + 1}` }));
}

/** @returns {Promise<object>} the tracker model (import-tracker.js) */
export async function parseFur(bytes) {
  const u8 = await inflate(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const end = () => { if (p > u8.length) throw new Error("FUR: unexpected end of file"); };
  const c = () => { end(); return u8[p++]; };
  const s16 = () => { const v = dv.getInt16(p, true); p += 2; return v; };
  const u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const f32 = () => { const v = dv.getFloat32(p, true); p += 4; return v; };
  const str = () => {
    const s = p;
    while (p < u8.length && u8[p] !== 0) p++;
    const out = new TextDecoder("utf-8").decode(u8.subarray(s, p));
    p++;
    return out;
  };
  const magic = () => String.fromCharCode(...u8.subarray(p, p + 4));

  if (String.fromCharCode(...u8.subarray(0, 16)) !== "-Furnace module-") throw new Error("not a Furnace module");
  p = 16;
  const version = u16();
  p += 2;
  const infoSeek = i32();
  p = infoSeek;

  let tuning = 440;
  let title, author, chans, hz, speeds, patLen, ordersLen, hilightA, hilightB, vtN = 1, vtD = 1;
  let orders, insPtr = [], patPtr = [], wavePtr = [], samplePtr = [];
  // Pitch: linear (1/128 semitone steps) unless the song says not, and the
  // multiplier on slide speeds (compat flags); the PC Engine's noise rate
  // straight from the note (Furnace's default since it has the flag).
  let linearPitch = 1, pitchSlideSpeed = 4, properNoiseLayout = true, newVolumeScaling = true, cflgPtr = 0;
  const channels = [];
  const effectCols = [];

  if (version >= 240) {
    if (magic() !== "INF2") throw new Error("FUR: invalid song info");
    p += 8;
    title = str(); author = str();
    str(); str(); str(); str(); str(); str(); // system name, category, Japanese names
    tuning = f32() || 440;
    c(); // auto system
    f32(); // master volume
    chans = u16();
    const nsys = u16();
    for (let i = 0; i < nsys; i++) {
      const id = u16();
      const n = u16();
      p += 12; // volume, pan, front/rear pan
      channels.push(...layoutOf(id, n));
    }
    const conns = i32();
    p += 4 * conns + 1; // patchbay, auto
    const subPtr = [];
    for (;;) {
      const type = c();
      if (type === 0) break;
      const n = i32();
      const ptrs = [];
      for (let i = 0; i < n; i++) ptrs.push(i32());
      if (type === 1) subPtr.push(...ptrs); // subsongs
      else if (type === 4) insPtr = ptrs; // instruments
      else if (type === 5) wavePtr = ptrs; // wavetables
      else if (type === 6) samplePtr = ptrs; // samples
      else if (type === 7) patPtr = ptrs; // patterns
      else if (type === 8) cflgPtr = ptrs[0] ?? 0; // compat flags
    }
    if (!subPtr.length) throw new Error("FUR: no song");
    p = subPtr[0];
    if (magic() !== "SNG2") throw new Error("FUR: invalid subsong");
    p += 8;
    hz = f32(); c(); c(); // arp speed, effect divider
    patLen = u16(); ordersLen = u16();
    hilightA = c(); hilightB = c();
    vtN = u16() || 1; vtD = u16() || 1;
    const nsp = c();
    const sp = [];
    for (let i = 0; i < 16; i++) sp.push(u16());
    speeds = nsp >= 2 ? [sp[0], sp[1]] : [sp[0], sp[0]];
    str(); str();
    orders = Array.from({ length: ordersLen }, () => new Array(chans).fill(0));
    for (let j = 0; j < chans; j++) for (let o = 0; o < ordersLen; o++) orders[o][j] = c();
    for (let j = 0; j < chans; j++) effectCols.push(c());
  } else {
    if (magic() !== "INFO") throw new Error("FUR: invalid song info");
    p += 8;
    const timeBase = c();
    speeds = [c() * (timeBase + 1), c() * (timeBase + 1)];
    c(); // arp speed
    hz = f32();
    patLen = s16(); ordersLen = s16();
    hilightA = c(); hilightB = c();
    const insLen = s16(), waveLen = s16(), sampleLen = s16();
    const nPats = i32();
    const ids = [];
    for (let i = 0; i < 32; i++) ids.push(c());
    for (const id of ids) {
      if (!id) continue;
      for (const sub of COMPOUND[id] ?? [id]) channels.push(...layoutOf(sub));
    }
    chans = channels.length;
    p += 32 + 32 + 128; // chip volumes, pans, flag pointers
    title = str(); author = str();
    tuning = f32() || 440;
    // The compatibility flags: limitSlides, linearPitch, loopModality, then
    // properNoiseLayout from version 43 — off before it (Furnace fur.cpp).
    if (version >= 37) linearPitch = u8[p + 1];
    properNoiseLayout = version >= 43 ? u8[p + 3] > 0 : false;
    // newVolumeScaling (a volume macro × the column, else their 4-bit steps
    // added) from version 99, the tenth flag; off before it.
    newVolumeScaling = version >= 99 ? u8[p + 9] > 0 : false;
    p += 20; // compatibility flags
    for (let i = 0; i < insLen; i++) insPtr.push(i32());
    for (let i = 0; i < waveLen; i++) wavePtr.push(i32());
    for (let i = 0; i < sampleLen; i++) samplePtr.push(i32());
    for (let i = 0; i < nPats; i++) patPtr.push(i32());
    orders = Array.from({ length: ordersLen }, () => new Array(chans).fill(0));
    for (let j = 0; j < chans; j++) for (let o = 0; o < ordersLen; o++) orders[o][j] = c();
    for (let j = 0; j < chans; j++) effectCols.push(c());
    if (version >= 96) {
      // Skip to the virtual tempo: channel show/collapse/names, notes, master
      // volume, the extended compatibility flags.
      try {
        if (version >= 39) {
          p += 2 * chans;
          for (let j = 0; j < 2 * chans; j++) str();
          str();
        }
        if (version >= 59) p += 4;
        if (version >= 70) { if (version >= 94) pitchSlideSpeed = u8[p + 13] || 4; p += 28; }
        vtN = s16() || 1; vtD = s16() || 1;
      } catch { vtN = vtD = 1; }
    }
  }

  // Patterns of the first subsong.
  const pats = channels.map(() => new Map());
  for (const ptr of patPtr) {
    p = ptr;
    const m = magic();
    p += 8;
    if (m === "PATN") {
      const subs = c();
      const ch = c();
      const index = s16();
      str();
      if (subs !== 0 || ch >= chans) continue;
      const rows = Array.from({ length: patLen }, () => ({ note: null, vol: -1, ins: -1, fx: [] }));
      for (let j = 0; j < patLen; j++) {
        const mask = c();
        if (mask === 0xff) break;
        if (mask & 128) { j += (mask & 127) + 1; continue; }
        let fxMask = 0;
        if (mask & 32) fxMask |= c();
        if (mask & 64) fxMask |= c() << 8;
        if (mask & 8) fxMask |= 1;
        if (mask & 16) fxMask |= 2;
        const row = rows[j];
        if (mask & 1) {
          const note = c();
          if (note === 180 || note === 181 || note === 182) row.note = "off";
          else if (note === 183) p += 4; // a raw frequency
          else if (note < 180) row.note = note - 60;
        }
        if (mask & 2) row.ins = c();
        if (mask & 4) row.vol = c();
        const vals = new Array(16).fill(-1);
        for (let b = 0; b < 16; b++) if (fxMask & (1 << b)) vals[b] = c();
        for (let e = 0; e < 8; e++) if (vals[2 * e] >= 0) row.fx.push([vals[2 * e], vals[2 * e + 1]]);
      }
      pats[ch].set(index, rows);
    } else if (m === "PATR") {
      const ch = s16();
      const index = s16();
      const subs = s16();
      s16();
      if (subs !== 0 || ch >= chans) continue;
      const rows = [];
      for (let j = 0; j < patLen; j++) {
        let note = s16(), octave = s16();
        const ins = s16(), vol = s16();
        const fx = [];
        for (let e = 0; e < effectCols[ch]; e++) {
          const code = s16(), val = s16();
          if (code >= 0) fx.push([code, val]);
        }
        let n = null;
        if (note === 100 || note === 101 || note === 102) n = "off";
        else if (note === 0 && octave !== 0) n = octave * 12;
        else if (note > 0) n = note + ((octave << 24) >> 24) * 12;
        rows.push({ note: n, vol, ins, fx });
      }
      pats[ch].set(index, rows);
    }
  }

  const none = () => ({ values: [], loop: null });
  const instruments = insPtr.map((ptr) => {
    try {
      p = ptr;
      return readInstrument();
    } catch {
      return { name: "", kind: "std", vol: { values: [], loop: null }, arp: { values: [], loop: null } };
    }
  });

  function readInstrument() {
    const m = magic();
    p += 4;
    if (m === "INST") {
      p += 4; // block size
      const iv = u16(); // the format version (the file's)
      const type = c();
      c();
      const name = str();
      const alg = c(), fb = c(), fms = c(), ams = c();
      c(); // op count
      const opllPreset = c();
      p += 2; // reserved
      const ops = [];
      for (let i = 0; i < 4; i++) {
        const am = c(), ar = c(), dr = c(), mul = c(), rr = c(), sl = c(), tl = c();
        const dt2 = c();
        const rs = c(), dt = c(), sr = c(), ssg = c();
        c(); c(); // dam, dvb
        const egt = c(), ksl = c(), sus = c(), vib = c(), ws = c(), ksr = c();
        p += 12;
        ops.push({ am, ar, dr, mul, rr, sl, tl, rs, dt, sr, ssg, dt2, egt, ksl, sus, vib, ws, ksr });
      }
      const fm = { alg, fb, fms, ams, ops, opllPreset };
      if (type === 1 || type === 33) return { name, kind: "fm", fm };
      // The old standard data (papers/oldIns.md): past the Game Boy (4),
      // C64 (24) and Amiga (16) data, each macro's length and loop (pitch
      // and the extras from version 17), the arp's fixed mode (before 112),
      // three heights or reserved, then the values, 4 bytes each.
      p += 4 + 24;
      const sampleMap = { init: s16(), noteMap: null }; // the Amiga data's first word
      p += 14;
      const n = iv >= 17 ? 8 : 4;
      const lens = Array.from({ length: n }, () => i32());
      const loops = Array.from({ length: n }, () => i32());
      const arpFixedOld = c();
      p += 3;
      const [vol, arp, duty, wave, pitch = none(), , ex2 = none(), ex3 = none()] = lens.map((len, k) => {
        const values = Array.from({ length: Math.max(0, len) }, () => i32());
        return { values, loop: loops[k] >= 0 && loops[k] < len ? loops[k] : null };
      });
      // Before version 31 a relative arp's values were stored 12 up.
      if (iv < 31 && !arpFixedOld) arp.values = arp.values.map((v) => v - 12);
      ayMode(type, wave);
      return { name, kind: "std", type, vol, arp: readArp(arp, iv < 112 && !!arpFixedOld), wave, duty, sampleMap,
        ex2, ex3, alg: none(), ex5: none(), pitch, ...(type === 13 ? { fm } : {}) };
    }
    if (m !== "INS2" && m !== "FINS") throw new Error("not an instrument");
    const len = m === "INS2" ? i32() : u8.length - p;
    const stop = p + len;
    p += 2; // format version
    const type = u16();
    let name = "";
    let fm = null;
    const vol = { values: [], loop: null };
    const arp = { values: [], loop: null };
    const wave = { values: [], loop: null };
    const duty = { values: [], loop: null };
    // The AY's envelope: its shape (ex2), the auto-envelope's ratio to the
    // tone (ex3 : alg) and its period (ex5).
    const ex2 = none(), ex3 = none(), alg = none(), ex5 = none(), pitch = none();
    // The sample map (SM, and NE's DPCM rate and DAC start per note):
    // Furnace's notes from C-5 (0), C-0 at 60; files before 246 store
    // C-0 up.
    const sampleMap = { init: 0, noteMap: null };
    const mapAt = (k) => (sampleMap.noteMap[k] ??= { freq: k, sample: -1, dpcmFreq: -1, dpcmDelta: -1 });
    while (p + 2 <= stop) {
      const code = String.fromCharCode(u8[p], u8[p + 1]);
      p += 2;
      if (code === "EN") break;
      const flen = u16();
      const fend = p + flen;
      if (code === "NA") name = str();
      else if (code === "FM") {
        const opCount = c() & 15;
        let nx = c();
        const alg = (nx >> 4) & 7, fb = nx & 7;
        nx = c();
        const ams = (nx >> 3) & 3, fms = nx & 7;
        const opllPreset = c() & 31;
        if (version >= 224) c();
        const ops = [];
        // (The OPLL's and the OPM's fields too: KSR, sustain, vibrato, KSL,
        // EG type, DT2, waveform.)
        for (let i = 0; i < opCount; i++) {
          const b = [c(), c(), c(), c(), c(), c(), c(), c()];
          ops.push({
            dt: (b[0] >> 4) & 7, mul: b[0] & 15, tl: b[1] & 127, rs: b[2] >> 6, ar: b[2] & 31,
            am: b[3] >> 7, dr: b[3] & 31, sr: b[4] & 31, sl: b[5] >> 4, rr: b[5] & 15, ssg: b[6] & 15,
            ksr: b[0] >> 7, sus: b[1] >> 7, vib: (b[2] >> 5) & 1, ksl: (b[3] >> 5) & 3, egt: b[4] >> 7,
            dt2: (b[7] >> 3) & 3, ws: b[7] & 7,
          });
        }
        while (ops.length < 4) ops.push({ dt: 3, mul: 1, tl: 127, rs: 0, ar: 31, am: 0, dr: 0, sr: 0, sl: 0, rr: 15, ssg: 0 });
        fm = { alg, fb, fms, ams, ops, opllPreset };
      } else if (code === "SM") {
        sampleMap.init = s16();
        const useMap = c() & 1;
        c(); // wave length
        if (useMap) {
          sampleMap.noteMap ??= [];
          for (let k = version >= 246 ? 0 : 60; k < 180; k++) {
            const e = mapAt(k);
            e.freq = s16() + (version >= 246 ? 0 : 60);
            e.sample = s16();
            if (version < 152) e.freq = k;
          }
        }
      } else if (code === "NE") {
        if (c()) {
          sampleMap.noteMap ??= [];
          for (let k = version >= 246 ? 0 : 60; k < 180; k++) {
            const e = mapAt(k);
            e.dpcmFreq = (c() << 24) >> 24;
            e.dpcmDelta = (c() << 24) >> 24;
          }
        }
      } else if (code === "MA") {
        const hlen = u16();
        while (p < fend) {
          const hstart = p;
          const mc = c();
          if (mc === 255) break;
          const mlen = c(), loop = c();
          const rel = c(); // the release point: held there until the note's release
          const mode = c(), ws = c() >> 6;
          const delay = hlen >= 8 ? c() : 0, speed = hlen >= 8 ? c() || 1 : 1;
          p = hstart + hlen;
          const vals = [];
          for (let i = 0; i < mlen; i++) {
            if (ws === 0) vals.push(c());
            else if (ws === 1) vals.push((c() << 24) >> 24);
            else if (ws === 2) vals.push(s16());
            else vals.push(i32());
          }
          const macro = { values: vals, loop: loop < mlen ? loop : null, rel: rel < mlen ? rel : null };
          if (mc === 0) Object.assign(vol, macro);
          else if (mc === 3) Object.assign(wave, macro); // the wavetable
          else if (mc === 2) Object.assign(duty, macro); // duty, or the PC Engine's noise switch
          else if (mc === 1) Object.assign(arp, macro);
          // The pitch macro: 1/128 semitones (linear pitch), added up a step
          // at a time where its mode is relative; its delay and speed in ticks.
          else if (mc === 4) Object.assign(pitch, macro, { relative: !!(mode & 1), delay, speed });
          else if (mc === 6) Object.assign(ex2, macro);
          else if (mc === 7) Object.assign(ex3, macro);
          else if (mc === 8) Object.assign(alg, macro);
          else if (mc === 16) Object.assign(ex5, macro);
        }
      }
      p = fend;
    }
    if (fm && (type === 1 || type === 33)) return { name, kind: "fm", fm };
    ayMode(type, wave);
    // (An OPLL instrument keeps its voice beside its macros.)
    return { name, kind: "std", type, sampleMap, vol, arp: readArp(arp), wave, duty, ex2, ex3, alg, ex5, pitch,
      ...(fm && type === 13 ? { fm } : {}) };
  }

  // An AY's wave macro is its mixer (1 tone, 2 noise, 4 the envelope),
  // stored one lower before version 193 (Furnace adds it back on load).
  function ayMode(type, wave) {
    if (version < 193 && (type === 6 || type === 7)) wave.values = wave.values.map((v) => v + 1);
  }

  // The wavetables: "WAVE", a size, its name, width, a reserved word, its
  // height (the top value), then `width` steps.
  const waves = wavePtr.map((ptr) => {
    try {
      p = ptr;
      if (magic() !== "WAVE") return null;
      p += 8;
      const name = str();
      const width = i32();
      i32();
      const height = i32();
      const values = [];
      for (let i = 0; i < width; i++) values.push(i32());
      return { name, values, height };
    } catch {
      return null;
    }
  });

  // The samples (sample.cpp readSampleData): SMP2 from version 102, else
  // the older SMPL; each as floats at its rate (C-4's), the 8- and 16-bit
  // PCM and the 1-bit DPCM (each bit a step of the 7-bit DAC, as Furnace
  // renders it). Another depth is null.
  const samples = samplePtr.map((ptr) => {
    try {
      p = ptr;
      const m = magic();
      if (m !== "SMP2" && m !== "SMPL") return null;
      p += 8;
      const name = str();
      const length = i32();
      let rate = i32(), depth, loopStart = -1, loopEnd = length;
      if (m === "SMP2") {
        rate = i32();
        depth = c();
        p += 3; // loop mode, BRR emphasis, dither
        loopStart = i32(); loopEnd = i32();
        p += 16; // the render masks
      } else {
        if (version < 58) return null; // a legacy sample, pitch-scaled
        p += 4;
        depth = c();
        c();
        if (version >= 38) rate = u16(); else p += 2;
        loopStart = version >= 19 ? i32() : -1;
      }
      let data = null;
      if (depth === 8) data = Float32Array.from(u8.subarray(p, p + length), (v) => ((v << 24) >> 24) / 128);
      else if (depth === 16) data = Float32Array.from({ length }, (_, i) => dv.getInt16(p + 2 * i, true) / 32768);
      else if (depth === 1) {
        data = new Float32Array(length);
        let acc = 0;
        for (let i = 0; i < length; i++) {
          acc = Math.max(-64, Math.min(63, acc + ((u8[p + (i >> 3)] >> (i & 7)) & 1 ? 1 : -1)));
          data[i] = acc / 64;
        }
      }
      if (!data) return { name, rate, depth, data: null };
      const loop = loopStart >= 0 && loopEnd > loopStart && loopEnd <= length ? { start: loopStart, end: loopEnd } : null;
      return { name, rate: rate || 8000, depth, data, loop };
    } catch {
      return null;
    }
  });

  if (cflgPtr) {
    // "CFLG", a size, then `key=value` lines.
    p = cflgPtr;
    if (magic() === "CFLG") {
      p += 8;
      for (const line of str().split("\n")) {
        const [k, v] = line.split("=");
        if (k === "linearPitch") linearPitch = +v;
        if (k === "pitchSlideSpeed") pitchSlideSpeed = +v || 4;
        if (k === "properNoiseLayout") properNoiseLayout = +v > 0;
        if (k === "newVolumeScaling") newVolumeScaling = +v > 0;
      }
    }
  }
  if (channels.length !== chans) throw new Error(`FUR: ${chans} channels in the song, ${channels.length} in its chips`);
  const t = {
    format: "Furnace", system: describe(channels), title, author,
    hz: (hz || 60) * (vtN / vtD),
    rowsPerBeat: hilightA, rowsPerBar: hilightB,
    speeds, patLen, orders,
    channels: channels.map((ch, i) => ({ ...ch, patterns: pats[i] })),
    instruments, waves, samples,
    // The NES's DPCM channel as the DMC (from version 154; before, a PCM
    // the CPU writes to the DAC at the note's rate).
    dpcmMode: version >= 154,
    fmVolMax: 127, psgVolMax: 15,
    linearPitch: linearPitch > 0, pitchSlideSpeed, properNoiseLayout, newVolumeScaling,
    tuning, // A-4's Hz
  };
  // Furnace converts the legacy sample mode of a file before 239 on load.
  if (version < 239) convertLegacySamples(t);
  return t;
}

function describe(channels) {
  const chips = [...new Set(channels.map((c) => c.name.split(" ")[0]))];
  return chips.slice(0, 4).join(" + ") + (chips.length > 4 ? " …" : "");
}

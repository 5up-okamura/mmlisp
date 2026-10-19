/**
 * SoundFont 2 (`.sf2`) drum kit → a sample library in the kit vocabulary.
 *
 * Only percussion kits are taken: a kit is a key → sound map, and the GM key
 * names the sound, so every key comes out under the role name the preset kits
 * use (presets/rx5, presets/gm-drums: kick, snare, hat, tom1-tom6 …) and a
 * score written against one kit plays this one unchanged. The SF2's own sample
 * names carry no convention and are not used. A melodic preset spreads one
 * instrument over many zones a def-pcm cannot hold, and is not offered.
 *
 * Each key is rendered the way the SF2 plays it — every zone it hits at full
 * velocity, at the pitch that key plays it, through the volume envelope's
 * attack, hold and decay — then brought into the presets' shape: mono, 22,050
 * Hz, shortened with a half-cosine fade, and its loudest 50 ms set to the
 * role's RMS (presets/rx5/README.md). The kit becomes ONE wav that every def
 * slices (`:offset` / `:frames`), which the caller saves next to the score.
 *
 * Not read: modulators, the filter, the LFOs, the modulation envelope, pan,
 * and 24-bit samples' low byte (sm24).
 */

import { encodeWav } from "./export-wav.js";

const KIT_RATE = 22050;

// Role names by GM key: the vocabulary every preset kit shares.
const KIT_ROLES = {
  35: "kick2", 36: "kick", 37: "rim", 38: "snare", 39: "clap", 40: "snare2", 41: "tom1", 42: "hat",
  43: "tom2", 44: "hat-pedal", 45: "tom3", 46: "hat-open", 47: "tom4", 48: "tom5", 49: "crash", 50: "tom6",
  51: "ride", 52: "china", 53: "ride-bell", 54: "tamb", 55: "splash", 56: "cowbell", 57: "crash2",
  58: "vibraslap", 59: "ride2", 60: "bongo-hi", 61: "bongo-lo", 62: "conga-mute", 63: "conga-hi",
  64: "conga-lo", 65: "timbale-hi", 66: "timbale-lo", 67: "agogo-hi", 68: "agogo-lo", 69: "cabasa",
  70: "maracas", 71: "whistle", 72: "whistle-long", 73: "guiro", 74: "guiro-long", 75: "claves",
  76: "woodblock-hi", 77: "woodblock-lo", 78: "cuica-mute", 79: "cuica", 80: "triangle-mute",
  81: "triangle", 85: "castanets",
};

// Level (RMS of the loudest 50 ms, dBFS) and longest length (s) by role, as
// the preset kits are baked.
const ROLE_SHAPE = (() => {
  const shape = {};
  const set = (names, db, len) => { for (const n of names.split(" ")) shape[n] = { db, len }; };
  set("kick kick2", -3, 0.3);
  set("snare snare2 clap", -3, 0.4);
  set("tom1 tom2 tom3 tom4 tom5 tom6", -5, 0.5);
  set("hat hat-pedal", -9, 0.2);
  set("hat-open", -9, 0.6);
  set("crash crash2 china splash ride ride2 ride-bell", -10, 0.6);
  for (const n of Object.values(KIT_ROLES)) shape[n] ??= { db: -8, len: 0.4 }; // rim and hand percussion
  set("vibraslap whistle-long guiro-long triangle", -8, 0.5);
  return shape;
})();

const PERCUSSION_BANK = 128;
const FULL_VELOCITY = 127;

// ── RIFF / SF2 structure ──────────────────────────────────────────────────

const GEN = {
  startAddrsOffset: 0, endAddrsOffset: 1, startloopAddrsOffset: 2, endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4, endAddrsCoarseOffset: 12, delayVolEnv: 33, attackVolEnv: 34,
  holdVolEnv: 35, decayVolEnv: 36, sustainVolEnv: 37, keynumToVolEnvHold: 39, keynumToVolEnvDecay: 40,
  instrument: 41, keyRange: 43, velRange: 44, startloopAddrsCoarseOffset: 45, initialAttenuation: 48,
  endloopAddrsCoarseOffset: 50, coarseTune: 51, fineTune: 52, sampleID: 53, sampleModes: 54,
  scaleTuning: 56, overridingRootKey: 58,
};
const GEN_DEFAULT = {
  [GEN.delayVolEnv]: -12000, [GEN.attackVolEnv]: -12000, [GEN.holdVolEnv]: -12000,
  [GEN.decayVolEnv]: -12000, [GEN.scaleTuning]: 100, [GEN.overridingRootKey]: -1,
};
// Generators a preset zone may not offset (SF2 2.04 §8.5): ranges, which
// intersect instead, the sample addressing, and the indices.
const PRESET_EXCLUDED = new Set([0, 1, 2, 3, 4, 12, 45, 50, 41, 43, 44, 53, 54, 57, 58]);

function chunks(dv, start, end) {
  const out = [];
  for (let p = start; p + 8 <= end; ) {
    const id = fourcc(dv, p);
    const size = dv.getUint32(p + 4, true);
    const body = p + 8;
    out.push({ id, body, size: Math.min(size, end - body), list: id === "LIST" ? fourcc(dv, body) : null });
    p = body + size + (size & 1);
  }
  return out;
}

function fourcc(dv, p) {
  return String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
}

function cstr(dv, p, n) {
  let s = "";
  for (let i = 0; i < n; i++) {
    const c = dv.getUint8(p + i);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/**
 * Read the parts of an SF2 a drum kit needs.
 * @param {Uint8Array} bytes
 */
export function parseSf2(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || fourcc(dv, 0) !== "RIFF" || fourcc(dv, 8) !== "sfbk") throw new Error("not a SoundFont 2 file");
  let name = "";
  let smpl = null;
  const pdta = {};
  for (const c of chunks(dv, 12, bytes.length)) {
    if (c.id !== "LIST") continue;
    for (const s of chunks(dv, c.body + 4, c.body + c.size)) {
      if (c.list === "INFO" && s.id === "INAM") name = cstr(dv, s.body, s.size);
      else if (c.list === "sdta" && s.id === "smpl") smpl = new Int16Array(bytes.slice(s.body, s.body + (s.size & ~1)).buffer);
      else if (c.list === "pdta") pdta[s.id] = s;
    }
  }
  if (!smpl) throw new Error("no sample data (an SF3's compressed samples are not read)");
  for (const id of ["phdr", "pbag", "pgen", "inst", "ibag", "igen", "shdr"])
    if (!pdta[id]) throw new Error(`no ${id} chunk`);
  const records = (id, size, read) => {
    const out = [];
    for (let p = pdta[id].body; p + size <= pdta[id].body + pdta[id].size; p += size) out.push(read(p));
    return out;
  };
  const gens = (id) => records(id, 4, (p) => ({ op: dv.getUint16(p, true), lo: dv.getUint8(p + 2), hi: dv.getUint8(p + 3), amount: dv.getInt16(p + 2, true) }));
  const bags = (id) => records(id, 4, (p) => dv.getUint16(p, true));
  const phdr = records("phdr", 38, (p) => ({ name: cstr(dv, p, 20), program: dv.getUint16(p + 20, true), bank: dv.getUint16(p + 22, true), bag: dv.getUint16(p + 24, true) }));
  const inst = records("inst", 22, (p) => ({ name: cstr(dv, p, 20), bag: dv.getUint16(p + 20, true) }));
  const shdr = records("shdr", 46, (p) => ({
    name: cstr(dv, p, 20), start: dv.getUint32(p + 20, true), end: dv.getUint32(p + 24, true),
    loopStart: dv.getUint32(p + 28, true), loopEnd: dv.getUint32(p + 32, true), rate: dv.getUint32(p + 36, true),
    rootKey: dv.getUint8(p + 40), correction: dv.getInt8(p + 41), type: dv.getUint16(p + 44, true),
  }));
  const pbag = bags("pbag"), pgen = gens("pgen"), ibag = bags("ibag"), igen = gens("igen");
  // Zones of the record `i` in a header list whose last record is the terminal.
  const zonesOf = (hdr, bag, gen, i) => {
    const out = [];
    for (let b = hdr[i].bag; b < hdr[i + 1].bag; b++) out.push(gen.slice(bag[b], bag[b + 1]));
    return out;
  };
  const presets = phdr.slice(0, -1).map((h, i) => ({ ...h, index: i, zones: zonesOf(phdr, pbag, pgen, i) }));
  const instruments = inst.slice(0, -1).map((h, i) => ({ ...h, zones: zonesOf(inst, ibag, igen, i) }));
  return { name, presets, instruments, samples: shdr.slice(0, -1), smpl };
}

/** The presets a kit can come from: the percussion bank, or every preset when the file has none. */
export function sf2Kits(sf2) {
  const drums = sf2.presets.filter((p) => p.bank === PERCUSSION_BANK);
  const list = drums.length ? drums : sf2.presets;
  return list.slice().sort((a, b) => a.bank - b.bank || a.program - b.program);
}

// ── Zones → the sound a key plays ─────────────────────────────────────────

function zoneMap(zone) {
  const m = new Map();
  for (const g of zone) m.set(g.op, g);
  return m;
}

function inRange(g, v) {
  return !g || (v >= g.lo && v <= g.hi);
}

// Split a zone list into its global zone (the first, when it lacks the
// terminal generator) and the rest.
function splitGlobal(zones, terminal) {
  const maps = zones.map(zoneMap);
  if (maps.length && !maps[0].has(terminal)) return { global: maps[0], local: maps.slice(1) };
  return { global: new Map(), local: maps };
}

// Every (instrument zone, summed generators) pair that sounds for `key` at full velocity.
function layersFor(sf2, preset, key) {
  const out = [];
  const pz = splitGlobal(preset.zones, GEN.instrument);
  for (const p of pz.local) {
    if (!p.has(GEN.instrument)) continue;
    const pr = (op) => p.get(op) ?? pz.global.get(op);
    if (!inRange(pr(GEN.keyRange), key) || !inRange(pr(GEN.velRange), FULL_VELOCITY)) continue;
    const ins = sf2.instruments[p.get(GEN.instrument).amount];
    if (!ins) continue;
    const iz = splitGlobal(ins.zones, GEN.sampleID);
    for (const z of iz.local) {
      if (!z.has(GEN.sampleID)) continue;
      const ir = (op) => z.get(op) ?? iz.global.get(op);
      if (!inRange(ir(GEN.keyRange), key) || !inRange(ir(GEN.velRange), FULL_VELOCITY)) continue;
      const gen = (op) => {
        const v = ir(op)?.amount ?? GEN_DEFAULT[op] ?? 0;
        return PRESET_EXCLUDED.has(op) ? v : v + (pr(op)?.amount ?? 0);
      };
      const sample = sf2.samples[z.get(GEN.sampleID).amount];
      if (sample && !(sample.type & 0x8000)) out.push({ sample, gen });
    }
  }
  return out;
}

const secs = (timecents) => (timecents <= -12000 ? 0 : 2 ** (timecents / 1200));

// One layer at KIT_RATE, as the SF2 plays it at `key`: pitched, attenuated,
// looped if it loops (up to `maxSec`), through the volume envelope.
function renderLayer(sf2, { sample, gen }, key, maxSec) {
  const start = sample.start + gen(GEN.startAddrsOffset) + 32768 * gen(GEN.startAddrsCoarseOffset);
  const end = sample.end + gen(GEN.endAddrsOffset) + 32768 * gen(GEN.endAddrsCoarseOffset);
  const loopStart = sample.loopStart + gen(GEN.startloopAddrsOffset) + 32768 * gen(GEN.startloopAddrsCoarseOffset) - start;
  const loopEnd = sample.loopEnd + gen(GEN.endloopAddrsOffset) + 32768 * gen(GEN.endloopAddrsCoarseOffset) - start;
  const src = sf2.smpl.subarray(Math.max(0, start), Math.min(sf2.smpl.length, end));
  if (src.length < 2 || !sample.rate) return new Float32Array(0);
  const rootKey = gen(GEN.overridingRootKey) >= 0 ? gen(GEN.overridingRootKey) : sample.rootKey;
  const cents = (key - rootKey) * gen(GEN.scaleTuning) + 100 * gen(GEN.coarseTune) + gen(GEN.fineTune) + sample.correction;
  const step = (sample.rate * 2 ** (cents / 1200)) / KIT_RATE; // source frames per output frame
  const loops = (gen(GEN.sampleModes) & 1) === 1 && loopStart >= 0 && loopEnd > loopStart + 1 && loopEnd <= src.length;
  const outLen = Math.ceil(Math.min(maxSec, loops ? Infinity : src.length / step / KIT_RATE) * KIT_RATE);
  const out = resample(src, step, outLen, loops ? { start: loopStart, end: loopEnd } : null);
  const gain = 10 ** (-Math.max(0, gen(GEN.initialAttenuation)) / 200);
  // Volume envelope: delay, a linear attack, hold, then a decay in dB to the sustain level.
  const delay = secs(gen(GEN.delayVolEnv));
  const attack = secs(gen(GEN.attackVolEnv));
  const hold = secs(gen(GEN.holdVolEnv) + gen(GEN.keynumToVolEnvHold) * (60 - key));
  const decay = secs(gen(GEN.decayVolEnv) + gen(GEN.keynumToVolEnvDecay) * (60 - key));
  const sustainCb = Math.min(1440, Math.max(0, gen(GEN.sustainVolEnv)));
  for (let i = 0; i < out.length; i++) {
    let t = i / KIT_RATE - delay;
    let env;
    if (t < 0) env = 0;
    else if (t < attack) env = t / attack;
    else if ((t -= attack) < hold) env = 1;
    else {
      t -= hold;
      // SF2 decay time is the time to fall the full 100 dB; it stops at the sustain level.
      const cb = decay > 0 ? Math.min(sustainCb, (1000 * t) / decay) : sustainCb;
      env = cb >= 1440 ? 0 : 10 ** (-cb / 200);
    }
    out[i] *= env * gain;
  }
  return out;
}

// Windowed-sinc resample of int16 `src` read `step` frames per output frame,
// low-passed below the output's Nyquist when it reads faster than 1:1. The
// kernel is tabled at PHASES fractional offsets.
const PHASES = 256;
function resample(src, step, outLen, loop) {
  const cutoff = Math.min(1, 1 / step) * 0.95;
  const span = Math.ceil(16 / cutoff);
  const width = 2 * span;
  const kernel = new Float32Array(PHASES * width);
  for (let ph = 0; ph < PHASES; ph++) {
    for (let j = 0; j < width; j++) {
      const d = ph / PHASES + span - 1 - j; // x - k for k = c - span + 1 + j
      const u = d * cutoff;
      const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
      kernel[ph * width + j] = sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / (span + 1))) * cutoff; // Hann
    }
  }
  const at = (i) => {
    if (loop) {
      if (i >= loop.end) i = loop.start + ((i - loop.start) % (loop.end - loop.start));
    } else if (i >= src.length) return 0;
    return i < 0 ? 0 : src[i] / 32768;
  };
  const out = new Float32Array(outLen);
  for (let n = 0; n < outLen; n++) {
    const x = n * step;
    const c = Math.floor(x);
    const k0 = c - span + 1;
    const row = Math.min(PHASES - 1, Math.round((x - c) * PHASES)) * width;
    let acc = 0;
    if (!loop && k0 >= 0 && k0 + width <= src.length) {
      for (let j = 0; j < width; j++) acc += src[k0 + j] * kernel[row + j];
      acc /= 32768;
    } else {
      for (let j = 0; j < width; j++) acc += at(k0 + j) * kernel[row + j];
    }
    out[n] = acc;
  }
  return out;
}

// ── The preset kits' shape: length and level ─────────────────────────────

// Lead-in silence off, the tail cut below −50 dB of the peak, and anything past
// `maxSec` shortened with a half-cosine fade.
function shorten(x, maxSec) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return x.subarray(0, 0);
  let a = 0;
  while (a < x.length && Math.abs(x[a]) < peak * 1e-3) a++;
  let b = x.length;
  while (b > a && Math.abs(x[b - 1]) < peak * 0.00316) b--;
  const maxLen = Math.round(maxSec * KIT_RATE);
  if (b - a <= maxLen) return x.slice(a, b);
  const out = x.slice(a, a + maxLen);
  const fade = Math.round(Math.min(0.15, maxSec / 3) * KIT_RATE);
  for (let i = 0; i < fade; i++) out[maxLen - fade + i] *= 0.5 + 0.5 * Math.cos((Math.PI * (i + 1)) / fade);
  return out;
}

function loudestRms(x) {
  const n = Math.round(0.05 * KIT_RATE);
  if (x.length <= n) return Math.sqrt(x.reduce((s, v) => s + v * v, 0) / n);
  let acc = 0, best = 0;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    if (i >= n) acc -= x[i - n] * x[i - n];
    if (i >= n - 1) best = Math.max(best, acc);
  }
  return Math.sqrt(best / n);
}

// Gain, then a peak limiter with its ceiling over full scale, then a hard clip:
// what the limiter lets through is the grit of classic game PCM. `ahead` is
// |x|'s peak over the limiter's 2 ms lookahead (aheadPeaks).
function drive(x, ahead, gain, ceiling) {
  const release = Math.exp(-1 / (0.04 * KIT_RATE));
  const out = new Float32Array(x.length);
  let g = 1;
  for (let i = 0; i < x.length; i++) {
    const peak = ahead[i] * gain;
    const want = peak > ceiling ? ceiling / peak : 1;
    g = want < g ? want : want + (g - want) * release;
    out[i] = Math.max(-1, Math.min(1, x[i] * gain * g));
  }
  return out;
}

function aheadPeaks(x) {
  const look = Math.round(0.002 * KIT_RATE);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let peak = 0;
    for (let j = i; j < Math.min(x.length, i + look); j++) peak = Math.max(peak, Math.abs(x[j]));
    out[i] = peak;
  }
  return out;
}

// Bring the loudest 50 ms to `db`: a quieter sound is driven up, a louder one
// turned down. The limiter clips 6 dB at most; a sound too dense to reach its
// level that way (noise is) is driven into the clip alone.
function level(x, db) {
  const target = 10 ** (db / 20);
  const rms = loudestRms(x);
  if (rms === 0) return x;
  if (rms >= target) return x.map((v) => (v * target) / rms);
  const ahead = aheadPeaks(x);
  for (const ceiling of [2, Infinity]) {
    const at = (gainDb) => drive(x, ahead, 10 ** (gainDb / 20), ceiling);
    const maxDb = 36;
    if (ceiling !== Infinity && loudestRms(at(maxDb)) < target) continue;
    let lo = 0, hi = maxDb;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (loudestRms(at(mid)) < target) lo = mid;
      else hi = mid;
    }
    return at(hi);
  }
}

// ── The import ────────────────────────────────────────────────────────────

/**
 * Convert one kit of an SF2 into role-named defs over one wav.
 *
 * @param {object} sf2 parseSf2's result
 * @param {object} preset one of sf2Kits(sf2)
 * @param {string} [fileName] the .sf2's name, which names the wav
 * @returns {{ source:string, warnings:string[], pcm:object }}
 */
export function sf2KitToMmlisp(sf2, preset, fileName = "soundfont.sf2") {
  const warnings = [];
  const sounds = [];
  const skipped = [];
  for (let key = 0; key < 128; key++) {
    const layers = layersFor(sf2, preset, key);
    if (!layers.length) continue;
    const role = KIT_ROLES[key];
    if (!role) { skipped.push(key); continue; }
    const shape = ROLE_SHAPE[role];
    const rendered = layers.map((l) => renderLayer(sf2, l, key, shape.len + 0.25));
    const mix = new Float32Array(Math.max(...rendered.map((r) => r.length)));
    for (const r of rendered) for (let i = 0; i < r.length; i++) mix[i] += r[i];
    const shot = shorten(mix, shape.len);
    if (!shot.length) { warnings.push(`key ${key} (${role}) is silent — skipped`); continue; }
    sounds.push({ key, role, data: level(shot, shape.db) });
  }
  if (skipped.length) warnings.push(`keys outside the kit vocabulary skipped: ${skipped.join(" ")}`);
  if (!sounds.length) warnings.push(`no GM drum keys in "${preset.name}"`);

  const base = String(fileName).replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  const kitSlug = preset.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const wavFile = `${base}${kitSlug ? "-" + kitSlug : ""}.wav`;
  const mono = new Float32Array(sounds.reduce((n, s) => n + s.data.length, 0));
  const lines = [
    `; ${preset.name} from ${base}.sf2${sf2.name ? ` (${sf2.name})` : ""} — ${sounds.length} sounds by role,`,
    `; mono ${KIT_RATE} Hz, levels set by role as in the preset kits.`,
    "",
  ];
  let offset = 0;
  for (const s of sounds) {
    mono.set(s.data, offset);
    lines.push(`(def-pcm ${s.role} :file "${wavFile}" :offset ${offset} :frames ${s.data.length}) ; key ${s.key}`);
    offset += s.data.length;
  }
  return {
    source: lines.join("\n") + "\n",
    warnings,
    pcm: { wavFile, rate: KIT_RATE, mono, wav: encodeWav(mono, null, KIT_RATE), entries: sounds, tag: "SoundFont" },
  };
}

// ---------------------------------------------------------------------------
// Standard MIDI File (.mid) → MMLisp import
//
// Notes, tempo, time signatures and programs. A program names a voice of
// presets/gm (the libOPNMIDI XG bank), played at the bank's own note offset;
// channel 10 plays presets/gm-drums on the PCM channels. MIDI plays chords on
// one channel and MMLisp one note a track, so each channel is split into
// lanes (a lane is as many notes as can sound at once) and every lane gets a
// destination: fm1-6, sqr1-3, pcm1-3 for drums, or dropped. The defaults put
// the busiest lanes on FM, then the PSG; what does not fit is dropped and
// reported — from the channels with the most lanes first (a channel's first
// lane goes before any channel's second).
//
// Volume (CC7), expression (CC11) and velocity fold into `:vel`; the song's
// loudest note lands on 15. Pan (CC10) sets an FM track's `:pan`. The
// sustain pedal (CC64) holds notes. Pitch bend (its range from RPN 0) is
// read frame by frame through each note and drawn as a `:pitch` macro — a
// vibrato or a few lines, shared as defs (import-song.js assignBends); the
// modulation wheel (CC1) is a vibrato on a fixed mapping: 127 → ±50 cents
// at 5.5 Hz. The other controllers are skipped and reported. A loop marked the RPG Maker way (CC111) or with
// `loopStart` / `loopEnd` markers becomes `#top … (go top)`; without one the
// whole song loops (unless the dialog says not to).
//
//   parseMidi(bytes)                  → the file's events
//   analyzeMidi(parsed)               → what the import dialog shows
//   defaultMidiOptions(analysis)      → its defaults
//   midiToMmlisp(parsed, options, analysis) → { source, warnings }
// ---------------------------------------------------------------------------

import { PPQN, RATE, barEnds, emitSong, emitStructured, bestBars, qstr, estimateGrid, regrid,
  assignBends, PITCH_NONE } from "./import-song.js";

// presets/gm, in program order (README.md), and the bank's note offsets
// (xg.wopn, melodic bank MSB 0 / LSB 0): the voice sounds `offset`
// semitones below the key, so the key is raised by it.
export const GM_VOICES = ("gm-piano gm-piano-bright gm-piano-e-grand gm-honkytonk gm-ep1 gm-ep2 gm-harpsi " +
  "gm-clav gm-celesta gm-glock gm-musicbox gm-vibes gm-marimba gm-xylo gm-tubular gm-dulcimer gm-organ-drawbar " +
  "gm-organ-perc gm-organ-rock gm-organ-church gm-organ-reed gm-accordion gm-harmonica gm-bandoneon " +
  "gm-guitar-nylon gm-guitar-steel gm-guitar-jazz gm-guitar-clean gm-guitar-mute gm-guitar-od gm-guitar-dist " +
  "gm-guitar-harm gm-bass-acoustic gm-bass-finger gm-bass-pick gm-bass-fretless gm-bass-slap1 gm-bass-slap2 " +
  "gm-bass-syn1 gm-bass-syn2 gm-violin gm-viola gm-cello gm-contrabass gm-str-trem gm-str-pizz gm-harp " +
  "gm-timpani gm-strings1 gm-strings2 gm-synstr1 gm-synstr2 gm-choir gm-voice-ooh gm-synvox gm-orch-hit " +
  "gm-trumpet gm-trombone gm-tuba gm-trumpet-mute gm-horn gm-brass gm-synbrass1 gm-synbrass2 gm-sax-soprano " +
  "gm-sax-alto gm-sax-tenor gm-sax-bari gm-oboe gm-english-horn gm-bassoon gm-clarinet gm-piccolo gm-flute " +
  "gm-recorder gm-panflute gm-bottle gm-shakuhachi gm-whistle gm-ocarina gm-lead-square gm-lead-saw " +
  "gm-lead-calliope gm-lead-chiff gm-lead-charang gm-lead-voice gm-lead-fifths gm-lead-basslead gm-pad-newage " +
  "gm-pad-warm gm-pad-poly gm-pad-choir gm-pad-bowed gm-pad-metal gm-pad-halo gm-pad-sweep gm-fx-rain " +
  "gm-fx-soundtrack gm-fx-crystal gm-fx-atmos gm-fx-bright gm-fx-goblins gm-fx-echoes gm-fx-scifi gm-sitar " +
  "gm-banjo gm-shamisen gm-koto gm-kalimba gm-bagpipe gm-fiddle gm-shanai gm-tinkle gm-agogo gm-steeldrum " +
  "gm-woodblock gm-taiko gm-tom-melodic gm-syndrum gm-revcymbal gm-fretnoise gm-breath gm-seashore gm-bird " +
  "gm-phone gm-heli gm-applause gm-gunshot").split(" ");
export const GM_NOTE_OFFSETS = [
  0, 0, 0, 0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 12, -12, 0, 0, -12, -12, 12, 0, 0, 0, 0, 12, 12, 0, 0, 0, 0, 0, 12,
  12, 12, 12, 12, 12, 12, -12, 12, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 12, 12, 0, 12, 0, -12, 12, 12, -12, 0, 12,
  0, 0, 12, 12, 12, 12, 0, 0, 12, 0, -12, 0, -12, 0, 0, -12, 0, 0, 0, 0, 0, 0, 0, 0, -24, 0, 0, 0, 12, 12, 0, 0,
  0, 0, 0, -12, -12, 0, 0, 0, 0, 0, 0, -12, 0, 0, 0, 12, 0, 0, 0, -12, 0, -12, 0, 0, 0, 0, 0, -12, 0, 0, 0, -12,
  0, 0,
];

// presets/gm-drums by GM key; the keys the kit lacks borrow a neighbour.
const GM_DRUMS = {
  35: "kick2", 36: "kick", 37: "rim", 38: "snare", 41: "tom1", 42: "hat", 43: "tom2", 44: "hat-pedal",
  45: "tom3", 46: "hat-open", 47: "tom4", 48: "tom5", 49: "crash", 50: "tom6", 51: "ride", 53: "ride-bell",
  54: "tamb", 56: "cowbell", 57: "crash2", 58: "vibraslap", 59: "ride2", 60: "bongo-hi", 61: "bongo-lo",
  62: "conga-mute", 63: "conga-hi", 64: "conga-lo", 65: "timbale-hi", 66: "timbale-lo", 67: "agogo-hi",
  68: "agogo-lo", 69: "cabasa", 71: "whistle", 72: "whistle-long", 73: "guiro", 74: "guiro-long",
  75: "claves", 76: "woodblock-hi", 77: "woodblock-lo", 78: "cuica-mute", 79: "cuica",
  80: "triangle-mute", 81: "triangle",
  39: "snare", 40: "snare", 52: "crash2", 55: "crash", 70: "cabasa",
};
const DRUM_CH = 9;
const DRUM_KEY = 60; // a PCM note at c4 plays the sample as recorded

export const FM_DESTS = ["fm1", "fm2", "fm3", "fm4", "fm5", "fm6"];
export const PSG_DESTS = ["sqr1", "sqr2", "sqr3"];
export const PCM_DESTS = ["pcm1", "pcm2", "pcm3"];
// Quantize grids, coarsest first: 16th, 16th triplet, 32nd, 32nd triplet, 64th…
export const GRIDS = [24, 16, 12, 8, 6, 4, 3, 2, 1];

// ── The file ──────────────────────────────────────────────────────────────

/**
 * @returns {{ format, division, tracks: Array<Array<{tick, kind, ch?, a?, b?, text?, value?}>> }}
 *   kind: on (a key, b velocity) | off | cc (a controller, b value) | pc (a)
 *   | bend (value) | tempo (value: µs per quarter) | ts (a num, b den)
 *   | name | marker (text)
 */
export function parseMidi(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  const u32 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const u16 = (o) => (u8[o] << 8) | u8[o + 1];
  let p = 0;
  // RIFF-wrapped MIDI (.rmi)
  if (str(0, 4) === "RIFF" && str(8, 4) === "RMID") {
    p = 12;
    while (p + 8 <= u8.length && str(p, 4) !== "data") p += 8 + (u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24));
    p += 8;
  }
  if (str(p, 4) !== "MThd") throw new Error("not a Standard MIDI File (no MThd)");
  const hlen = u32(p + 4);
  const format = u16(p + 8);
  const ntrk = u16(p + 10);
  const division = u16(p + 12);
  if (division & 0x8000) throw new Error("SMPTE-timed MIDI files are not supported");
  p += 8 + hlen;
  const tracks = [];
  for (let k = 0; k < ntrk && p + 8 <= u8.length; k++) {
    const id = str(p, 4);
    const len = u32(p + 4);
    const start = p + 8;
    const end = Math.min(u8.length, start + len);
    p = start + len;
    if (id !== "MTrk") { k--; continue; }
    const ev = [];
    let q = start;
    let tick = 0;
    let running = 0;
    const vlq = () => {
      let v = 0;
      for (let i = 0; i < 4 && q < end; i++) {
        const b = u8[q++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      return v;
    };
    while (q < end) {
      tick += vlq();
      let st = u8[q];
      if (st & 0x80) q++;
      else st = running;
      if (st === 0xff) {
        const type = u8[q++];
        const n = vlq();
        const d = u8.subarray(q, q + n);
        q += n;
        if (type === 0x2f) break;
        if (type === 0x51 && n >= 3) ev.push({ tick, kind: "tempo", value: (d[0] << 16) | (d[1] << 8) | d[2] });
        else if (type === 0x58 && n >= 2) ev.push({ tick, kind: "ts", a: d[0], b: 1 << d[1] });
        else if (type === 0x03) ev.push({ tick, kind: "name", text: decodeText(d) });
        else if (type === 0x06 || type === 0x01) ev.push({ tick, kind: "marker", text: decodeText(d) });
        continue;
      }
      if (st === 0xf0 || st === 0xf7) {
        q += vlq();
        continue;
      }
      if (!(st & 0x80)) throw new Error(`track ${k + 1}: data byte with no running status at ${q}`);
      running = st;
      const hi = st & 0xf0;
      const ch = st & 0x0f;
      const a = u8[q++];
      const b = hi === 0xc0 || hi === 0xd0 ? 0 : u8[q++];
      if (hi === 0x90 && b > 0) ev.push({ tick, kind: "on", ch, a, b });
      else if (hi === 0x80 || hi === 0x90) ev.push({ tick, kind: "off", ch, a });
      else if (hi === 0xb0) ev.push({ tick, kind: "cc", ch, a, b });
      else if (hi === 0xc0) ev.push({ tick, kind: "pc", ch, a });
      else if (hi === 0xe0) ev.push({ tick, kind: "bend", ch, value: ((b << 7) | a) - 8192 });
    }
    tracks.push(ev);
  }
  return { format, division, tracks };
}

function decodeText(d) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(d).trim();
  } catch {
    try {
      return new TextDecoder("shift-jis").decode(d).trim();
    } catch {
      return String.fromCharCode(...d).trim();
    }
  }
}

// ── What is in it ────────────────────────────────────────────────────────

/**
 * Notes with their channel state, the tempo map, the lanes.
 * @returns {{ title, division, tempos, timeSigs, loop, notes, lanes, counts }}
 *   lanes: [{key, ch, lane, drums, program, voice, notes, label}]
 */
export function analyzeMidi(parsed) {
  const all = [];
  parsed.tracks.forEach((tr, ti) => tr.forEach((e, i) => all.push({ ...e, ti, i })));
  // Same tick: offs before ons, so a repeated key is released then struck.
  const order = { off: 0, cc: 1, pc: 1, tempo: 1, ts: 1, bend: 1, name: 2, marker: 2, on: 3 };
  all.sort((x, y) => x.tick - y.tick || order[x.kind] - order[y.kind] || x.ti - y.ti || x.i - y.i);

  const tempos = [];
  const timeSigs = [];
  let title = null;
  let loopStart = null;
  let loopEnd = null;
  const counts = { bend: 0, cc: new Map() };
  // Pitch bend in cents, through each channel's range (RPN 0, ±2 semitones
  // until set), and the modulation wheel: [tick, value] a channel.
  const bends = Array.from({ length: 16 }, () => [[0, 0]]);
  const mods = Array.from({ length: 16 }, () => [[0, 0]]);
  const range = new Array(16).fill(200);
  const rpn = Array.from({ length: 16 }, () => [127, 127]);
  const raw = new Array(16).fill(0);
  const program = new Array(16).fill(0);
  const vol = new Array(16).fill(100);
  const expr = new Array(16).fill(127);
  const pan = new Array(16).fill(null);
  const sustain = new Array(16).fill(false);
  const sounding = new Map(); // ch*128+key → [note …]
  const pedalHeld = Array.from({ length: 16 }, () => []);
  const notes = [];
  const close = (n, tick) => { n.end = Math.max(tick, n.tick); };

  for (const e of all) {
    switch (e.kind) {
      case "tempo": tempos.push({ tick: e.tick, usPerQ: e.value }); break;
      case "ts": timeSigs.push({ tick: e.tick, num: e.a, den: e.b }); break;
      case "name": if (title == null && e.ti === 0 && e.text) title = e.text; break;
      case "marker":
        if (/^loop\s*start$/i.test(e.text) && loopStart == null) loopStart = e.tick;
        else if (/^loop\s*end$/i.test(e.text) && loopEnd == null) loopEnd = e.tick;
        break;
      case "pc": program[e.ch] = e.a; break;
      case "bend":
        if (e.value !== 0) counts.bend++;
        raw[e.ch] = e.value;
        bends[e.ch].push([e.tick, (e.value / 8192) * range[e.ch]]);
        break;
      case "cc":
        if (e.a === 101) rpn[e.ch][0] = e.b;
        else if (e.a === 100) rpn[e.ch][1] = e.b;
        else if ((e.a === 6 || e.a === 38) && rpn[e.ch][0] === 0 && rpn[e.ch][1] === 0) {
          range[e.ch] = e.a === 6 ? e.b * 100 + (range[e.ch] % 100) : Math.floor(range[e.ch] / 100) * 100 + e.b;
          bends[e.ch].push([e.tick, (raw[e.ch] / 8192) * range[e.ch]]);
        } else if (e.a === 1) mods[e.ch].push([e.tick, e.b]);
        else if (e.a === 7) vol[e.ch] = e.b;
        else if (e.a === 11) expr[e.ch] = e.b;
        else if (e.a === 10) pan[e.ch] ??= e.b;
        else if (e.a === 111) loopStart ??= e.tick;
        else if (e.a === 64) {
          sustain[e.ch] = e.b >= 64;
          if (!sustain[e.ch]) {
            for (const n of pedalHeld[e.ch]) close(n, e.tick);
            pedalHeld[e.ch] = [];
          }
        } else if (![0, 32, 6, 38, 98, 99, 100, 101, 121, 120, 123].includes(e.a)) {
          counts.cc.set(e.a, (counts.cc.get(e.a) ?? 0) + 1);
        }
        break;
      case "on": {
        const k = e.ch * 128 + e.a;
        // A key struck again while sounding ends the earlier note.
        const prev = sounding.get(k);
        if (prev?.length) for (const n of prev.splice(0)) close(n, e.tick);
        const n = {
          tick: e.tick, end: null, ch: e.ch, key: e.a, vel: e.b, program: program[e.ch],
          level: gainDb(e.b) + gainDb(vol[e.ch]) + gainDb(expr[e.ch]),
        };
        notes.push(n);
        sounding.set(k, [...(sounding.get(k) ?? []), n]);
        break;
      }
      case "off": {
        const list = sounding.get(e.ch * 128 + e.a);
        const n = list?.shift();
        if (!n) break;
        if (sustain[e.ch]) pedalHeld[e.ch].push(n);
        else close(n, e.tick);
        break;
      }
    }
  }
  const last = all.length ? all[all.length - 1].tick : 0;
  for (const n of notes) if (n.end == null) n.end = Math.max(last, n.tick + 1);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, usPerQ: 500000 });

  // Lanes: per channel, each note on the first lane free at its start.
  const lanes = [];
  const byCh = new Map();
  for (const n of notes) {
    if (!byCh.has(n.ch)) byCh.set(n.ch, []);
    byCh.get(n.ch).push(n);
  }
  // A 32nd: how long a drum hit holds its lane, and how far a played note
  // may run into the next before that takes a second lane (it is cut).
  const slack = parsed.division / 8;
  for (const [ch, list] of [...byCh].sort((a, b) => a[0] - b[0])) {
    const drums = ch === DRUM_CH;
    // A chord, even a played one, is laned top note first.
    list.sort((a, b) => Math.round(a.tick / slack) - Math.round(b.tick / slack) || b.key - a.key);
    const ends = [];
    for (const n of list) {
      const end = drums ? n.tick + slack : n.end;
      let l = ends.findIndex((x) => x <= n.tick + (drums ? 0 : slack));
      if (l < 0) { l = ends.length; ends.push(0); }
      ends[l] = end;
      n.lane = l;
    }
    for (let l = 0; l < ends.length; l++) {
      const mine = list.filter((n) => n.lane === l);
      const prog = mine[0].program;
      const voice = drums ? "drums" : GM_VOICES[prog];
      lanes.push({
        key: `${ch}:${l}`, ch, lane: l, drums, program: prog, voice, notes: mine.length,
        pan: pan[ch],
        label: `ch${ch + 1}${ends.length > 1 ? ` · ${l + 1}/${ends.length}` : ""} · ${voice} · ${mine.length} notes`,
      });
    }
  }
  // Seconds, through the tempo map.
  const marks = [];
  let at = 0;
  for (let i = 0; i < tempos.length; i++) {
    if (i > 0) at += ((tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].usPerQ) / parsed.division / 1e6;
    marks.push({ tick: tempos[i].tick, sec: at, usPerQ: tempos[i].usPerQ });
  }
  const secOf = (tick) => {
    let m = marks[0];
    for (const x of marks) if (x.tick <= tick) m = x;
    return m.sec + ((tick - m.tick) * m.usPerQ) / parsed.division / 1e6;
  };
  // The tempo the music starts at: a file may run a silent setup section at
  // a tempo of its own before the first note.
  const firstTick = notes.length ? Math.min(...notes.map((n) => n.tick)) : 0;
  const atFirst = tempos.filter((t) => t.tick <= firstTick).pop() ?? tempos[0];
  const a = {
    title, division: parsed.division, tempos, timeSigs, notes, lanes, counts, secOf, firstTick, bends, mods,
    loop: loopStart != null ? { start: loopStart, end: loopEnd } : null,
    bpm: 60e6 / atFirst.usPerQ,
  };
  a.fileGrid = detectGrid(a);
  a.beat = estimateGrid(notes.map((n) => secOf(n.tick) * RATE));
  return a;
}

/** dB of a 0-127 MIDI level (GM: 40 log10). */
const gainDb = (v) => (v <= 0 ? -96 : 40 * Math.log10(v / 127));

/**
 * The coarsest grid the onsets sit on within a tick. `fits` is false when
 * only a grid finer than a 64th does — the file's ticks are not its beat (a
 * recorded performance, a conversion from a log) and the beat has to be
 * estimated from the notes' times instead.
 */
export function detectGrid(analysis) {
  const k = PPQN / analysis.division;
  const ticks = analysis.notes.map((n) => n.tick * k);
  if (!ticks.length) return { grid: 12, fits: true };
  for (const g of GRIDS) {
    let err = 0;
    for (const t of ticks) err += Math.abs(t - Math.round(t / g) * g);
    if (err / ticks.length <= 1) return { grid: g, fits: g >= 6 };
  }
  return { grid: 12, fits: false };
}

/**
 * The dialog's defaults: lanes by importance (every channel's first lane,
 * busiest first, before any second lane) onto FM, then the PSG; drums onto
 * the PCM channels.
 */
export function defaultMidiOptions(analysis) {
  const melodic = analysis.lanes.filter((l) => !l.drums)
    .sort((a, b) => a.lane - b.lane || b.notes - a.notes);
  const drums = analysis.lanes.filter((l) => l.drums).sort((a, b) => a.lane - b.lane);
  const pcmVoices = Math.min(2, drums.length);
  const dest = {};
  drums.forEach((l, i) => { dest[l.key] = i < pcmVoices ? PCM_DESTS[i] : "drop"; });
  const free = [...(pcmVoices ? FM_DESTS.slice(0, 5) : FM_DESTS), ...PSG_DESTS];
  melodic.forEach((l) => { dest[l.key] = free.shift() ?? "drop"; });
  const timing = analysis.fileGrid.fits || analysis.beat.frames ? "file" : "beats";
  return { dest, grid: analysis.fileGrid.grid, timing, bpm: null, loop: true };
}

// ── The score ────────────────────────────────────────────────────────────

/**
 * @param options {dest: {laneKey: channel|"drop"}, grid, bpm?: number|null,
 *                 timing: "file" (the file's ticks and tempo map, quantized
 *                 to `grid`; `bpm` scales the map) | "beats" (the beat
 *                 estimated from the notes' times; `bpm` replaces it),
 *                 loop: bool, fileName?}
 */
export function midiToMmlisp(parsed, options, analysis = analyzeMidi(parsed)) {
  const warnings = [];
  const k = PPQN / analysis.division;
  const beats = options.timing === "beats";
  // q: a file tick → a score tick. Either way the song starts at the first
  // note's bar (file) or step (beats): a silent lead-in is not written.
  let g, q, beat = null;
  if (beats) {
    beat = analysis.beat;
    if (options.bpm > 0) beat = regrid(beat, options.bpm);
    g = beat.unitTicks;
    q = (t) => Math.max(0, beat.units(analysis.secOf(t) * RATE)) * g;
    warnings.push(`timed by the estimated beat (${beat.bpm.toFixed(1)} BPM, onsets fit ${Math.round(beat.fit * 100)}%) — the file's tempo map is not used`);
  } else {
    g = Math.max(1, options.grid | 0);
    const sig = analysis.timeSigs.filter((x) => x.tick <= analysis.firstTick).pop() ?? { num: 4, den: 4 };
    const bar = Math.max(1, Math.round((PPQN * 4 * sig.num) / sig.den));
    const first = Math.round((analysis.firstTick * k) / g) * g;
    const lead = Math.floor(first / bar) * bar;
    q = (t) => Math.max(0, Math.round((t * k) / g) * g - lead);
  }
  const dest = options.dest ?? {};

  // Channels: each used once; a second lane sent to the same one is dropped.
  const laneDest = new Map();
  const taken = new Set();
  for (const l of analysis.lanes) {
    const d = dest[l.key] ?? "drop";
    if (d === "drop") continue;
    if (taken.has(d)) { warnings.push(`${l.label}: ${d} is already taken — dropped`); continue; }
    if (l.drums !== d.startsWith("pcm")) {
      warnings.push(`${l.label}: ${l.drums ? "drums go on pcm1-3" : "pcm1-3 take only drums"} — dropped`);
      continue;
    }
    taken.add(d);
    laneDest.set(l.key, d);
  }
  const dropped = analysis.lanes.filter((l) => !laneDest.has(l.key));
  if (dropped.length)
    warnings.push(`dropped ${dropped.length} lane(s): ${dropped.map((l) => l.label).join("; ")}`);
  // pcm2 alone still needs two voices: the count is the highest one used.
  const pcmUsed = Math.max(0, ...[...taken].filter((d) => d.startsWith("pcm")).map((d) => +d.slice(3)));
  if (pcmUsed && taken.has("fm6")) {
    warnings.push("fm6 is the DAC in a score with PCM — its lane was dropped");
    for (const [key, d] of laneDest) if (d === "fm6") laneDest.delete(key);
  }

  // Levels: the loudest note kept lands on :vel 15, 2 dB a step.
  const kept = analysis.notes.filter((n) => laneDest.has(`${n.ch}:${n.lane}`));
  const top = Math.max(-96, ...kept.map((n) => n.level));
  const velOf = (n) => Math.max(0, Math.min(15, Math.round(15 + (n.level - top) / 2)));

  // The song: its end on a bar, the loop — the file's, or with none marked
  // the whole song.
  const loop = !options.loop ? null : analysis.loop ?? { start: 0, end: null };
  let endTick = Math.max(0, ...kept.map((n) => q(n.end)));
  if (loop?.end != null) endTick = q(loop.end);
  const timeSigs = beats ? [] : analysis.timeSigs.map((s) => ({ ...s, tick: q(s.tick) }));
  const bars = barEnds(timeSigs, Math.max(1, endTick));
  endTick = bars.length ? bars[bars.length - 1] : endTick;
  const loopTick = loop ? q(loop.start) : null;

  // Tempo: the map, scaled when the first tempo is set by hand.
  const scale = options.bpm ? options.bpm / analysis.bpm : 1;
  const bpmToken = (us) => {
    const bpm = (60e6 / us) * scale;
    return `:tempo ${Number.isInteger(bpm) ? bpm : +bpm.toFixed(2)}`;
  };
  const tempoMarks = [];
  if (beats) {
    const bpm = Math.abs(beat.bpm - Math.round(beat.bpm)) < 0.1 ? Math.round(beat.bpm) : +beat.bpm.toFixed(2);
    tempoMarks.push({ tick: 0, tokens: [`:tempo ${bpm}`] });
  } else for (const t of analysis.tempos) {
    // A tempo set before the first note (a setup section's) gives way to
    // the one the music starts at.
    const tick = t.tick <= analysis.firstTick ? 0 : q(t.tick);
    if (tick >= endTick && tick > 0) continue;
    const prev = tempoMarks.findIndex((m) => m.tick === tick);
    if (prev >= 0) tempoMarks.splice(prev, 1);
    tempoMarks.push({ tick, tokens: [bpmToken(t.usPerQ)] });
  }
  // `(go top)` keeps the end's tempo: restate the loop's own.
  if (!beats && loopTick != null && !tempoMarks.some((m) => m.tick === loopTick)
    && tempoMarks.some((m) => m.tick > loopTick)) {
    const inForce = analysis.tempos.filter((t) => q(t.tick) <= loopTick).pop();
    tempoMarks.push({ tick: loopTick, tokens: [bpmToken(inForce.usPerQ)] });
  }

  // Tracks in channel order.
  const order = [...FM_DESTS, ...PSG_DESTS, "noise", ...PCM_DESTS];
  const tracks = [];
  // A note's pitch as it plays: the bend, a frame (1/60 s) each, from where
  // it is struck to where it ends — its own key moved to the semitone it
  // spends the most frames at, a move of 30 cents or less dropped — else the
  // modulation wheel's vibrato.
  const secOfBend = analysis.bends.map((list) => list.map(([t, c]) => [analysis.secOf(t), c]));
  const valueAt = (list, sec) => { let v = 0; for (const [t, x] of list) { if (t > sec) break; v = x; } return v; };
  const pitchOf = (n, note) => {
    const s0 = analysis.secOf(n.tick), s1 = analysis.secOf(n.end);
    const F = Math.max(1, Math.min(600, Math.round((s1 - s0) * 60)));
    const list = secOfBend[n.ch];
    const c = [];
    for (let f = 0; f < F; f++) c.push(valueAt(list, s0 + (f + 0.5) / 60));
    const at = new Map();
    for (const v of c) { const k = Math.round(v / 100); at.set(k, (at.get(k) ?? 0) + 1); }
    const shift = [...at].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    note.midi += shift;
    const rel = c.map((v) => Math.round((v - shift * 100) / 5) * 5);
    if (Math.max(...rel) - Math.min(...rel) > 30) { note.bend = rel; return; }
    // The wheel: at the note's start, or from where it comes in.
    const mods = analysis.mods[n.ch].map(([t, v]) => [analysis.secOf(t), v]);
    let m = valueAt(mods, s0), wait = 0;
    if (!m) {
      const later = mods.find(([t, v]) => t > s0 && t < s1 && v > 0);
      if (later) { m = later[1]; wait = Math.round(((later[0] - s0) * 60) / 2) * 2; }
    }
    const depth = Math.round((m / 127) * 50 / 10) * 10;
    if (depth > 0) note.vib = { kind: "vib", centre: 0, depth, period: 11, wait };
  };
  const laneNotes = [];
  for (const [key, d] of [...laneDest].sort((a, b) => order.indexOf(a[1]) - order.indexOf(b[1]))) {
    const lane = analysis.lanes.find((l) => l.key === key);
    const fm = d.startsWith("fm");
    const src = kept.filter((n) => `${n.ch}:${n.lane}` === key).sort((a, b) => a.tick - b.tick);
    const notes = [];
    let cur = null;
    for (const n of src) {
      const tick = q(n.tick);
      if (tick >= endTick) break;
      let end = Math.min(endTick, q(n.end));
      if (lane.drums) end = tick; // a drum lasts to the next hit (below)
      const note = { tick, len: Math.max(g, end - tick), vel: velOf(n) };
      if (lane.drums) {
        const name = GM_DRUMS[n.key];
        if (!name) { warnings.push(`drum key ${n.key} has no sample in presets/gm-drums — dropped`); continue; }
        note.midi = DRUM_KEY;
        if (name !== cur) { note.pre = [name]; cur = name; }
      } else {
        note.midi = n.key + (fm ? GM_NOTE_OFFSETS[n.program] : 0);
        if (fm && GM_VOICES[n.program] !== cur) { note.pre = [GM_VOICES[n.program]]; cur = GM_VOICES[n.program]; }
        pitchOf(n, note);
      }
      note.voice = cur;
      note.midi = Math.max(0, Math.min(127, note.midi));
      const prev = notes[notes.length - 1];
      if (prev && prev.tick === tick) {
        // Two notes quantized onto one start: keep the louder.
        if (note.vel > prev.vel) notes[notes.length - 1] = { ...note, pre: note.pre ?? prev.pre };
        continue;
      }
      if (prev && prev.tick + prev.len > tick) prev.len = tick - prev.tick;
      notes.push(note);
    }
    for (let i = 0; i < notes.length; i++) {
      const next = i + 1 < notes.length ? notes[i + 1].tick : endTick;
      // A drum lasts to the next hit; a gap of one grid step is legato.
      if (lane.drums || next - (notes[i].tick + notes[i].len) <= g) notes[i].len = next - notes[i].tick;
    }
    if (!notes.length) continue;
    laneNotes.push(notes);
    // The first note's switch goes in the head (its pitch, below).
    const head = notes[0].pre ?? [];
    delete notes[0].pre;
    if (fm && lane.pan != null) head.push(`:pan ${lane.pan < 43 ? "left" : lane.pan > 85 ? "right" : "center"}`);
    tracks.push({ channel: d, head, notes, marks: [] });
  }
  if (tracks.length) tracks[0].marks = tempoMarks;
  else warnings.push("no notes to import");

  // Bends and modulation → `:pitch`, stated as a switch beside the voice;
  // `(macro :pitch none)` after one.
  const bendDefs = assignBends(laneNotes.flat());
  for (const [i, notes] of laneNotes.entries()) {
    if (!notes.some((n) => n.bendName)) continue;
    let curP = null;
    notes.forEach((n, j) => {
      const tok = n.bendName ?? PITCH_NONE;
      n.state = [...(n.voice ? [n.voice] : []), ...tracks[i].head.filter((t) => t.startsWith(":pan")), tok];
      if (tok !== curP && !(curP == null && tok === PITCH_NONE)) {
        if (j === 0) tracks[i].head.push(tok);
        else n.pre = [...(n.pre ?? []), tok];
      }
      curP = tok;
    });
  }
  const ccs = [...analysis.counts.cc].map(([c, n]) => `CC${c}×${n}`);
  if (ccs.length) warnings.push(`controllers skipped: ${ccs.join(", ")}`);

  const header = [`; Imported from ${options.fileName ?? "a MIDI file"} (MIDI)`];
  if (analysis.title) header.push(`(def title ${qstr(analysis.title)})`);
  if (tracks.some((t) => t.channel.startsWith("fm"))) header.push('(import "presets/gm/set.mmlisp")');
  if (pcmUsed) header.push('(import "presets/gm-drums/set.mmlisp")', `(def pcm-voices ${pcmUsed})`);
  if (bendDefs.length) header.push("", ...bendDefs);

  // Timed by its notes, the file's bars say nothing: place them where the
  // song folds most.
  const song = { header, bars, endTick, loopTick, tracks };
  const source = options.structure === false ? emitSong(song)
    : emitStructured(beats ? { ...song, bars: bestBars(song) } : song);
  return { source, warnings };
}

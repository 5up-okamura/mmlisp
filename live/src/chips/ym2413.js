// The YM2413 (OPLL), the FM-PAC cartridge's FM: nine 2-op channels, each
// playing one of fifteen ROM voices or the one user voice ($00-$07), or six
// channels and the five rhythm sounds on the last three. ymfm's YM2413
// plays it (synth-msx.js), with the ROM below.
//
// Its registers, as the worklet's port 4: $00-$07 the user voice, $0E the
// rhythm, $10-$18 each channel's F-number (low 8 bits), $20-$28 its sustain,
// key, block and the F-number's top bit, $30-$38 its voice and volume.
//
// The FM is the OPN's language on two operators (language.md §19, msx): op1
// the modulator, op2 the carrier, whose level is the channel's 4-bit volume.
// A voice is one of the ROM's when its registers are, and the user voice
// otherwise — one for the chip, the last written winning.
import { fmWords } from "./fm-words.js";
import { NO_WORDS } from "./parts.js";
import { pitchToMidi } from "../ir-utils.js";

const CLOCK = 3579545; // the MSX's 3.58 MHz
export const OPLL_PORT = 4;
const RATE = CLOCK / 72; // the sample rate, which the F-number counts in
const CHANNELS = 9;

// The ROM, as the chip's die has it (Nuked-OPLL's patch_ym2413), in the user
// voice's $00-$07 layout: the fifteen voices, then the three rhythm patches
// (BD; HH and SD; TOM and CYM), which the emulator takes whole.
const ROM = [
  [0x71, 0x61, 0x1e, 0x17, 0xd0, 0x78, 0x00, 0x17], // violin
  [0x13, 0x41, 0x1a, 0x0d, 0xd8, 0xf7, 0x23, 0x13], // guitar
  [0x13, 0x01, 0x99, 0x00, 0xf2, 0xc4, 0x11, 0x23], // piano
  [0x31, 0x61, 0x0e, 0x07, 0xa8, 0x64, 0x70, 0x27], // flute
  [0x32, 0x21, 0x1e, 0x06, 0xe0, 0x76, 0x00, 0x28], // clarinet
  [0x31, 0x22, 0x16, 0x05, 0xe0, 0x71, 0x00, 0x18], // oboe
  [0x21, 0x61, 0x1d, 0x07, 0x82, 0x81, 0x10, 0x07], // trumpet
  [0x23, 0x21, 0x2d, 0x14, 0xa2, 0x72, 0x00, 0x07], // organ
  [0x61, 0x61, 0x1b, 0x06, 0x64, 0x65, 0x10, 0x17], // horn
  [0x41, 0x61, 0x0b, 0x18, 0x85, 0xf7, 0x71, 0x07], // synthesizer
  [0x13, 0x01, 0x83, 0x11, 0xfa, 0xe4, 0x10, 0x04], // harpsichord
  [0x17, 0xc1, 0x24, 0x07, 0xf8, 0xf8, 0x22, 0x12], // vibraphone
  [0x61, 0x50, 0x0c, 0x05, 0xc2, 0xf5, 0x20, 0x42], // synthesizer bass
  [0x01, 0x01, 0x55, 0x03, 0xc9, 0x95, 0x03, 0x02], // acoustic bass
  [0x61, 0x41, 0x89, 0x03, 0xf1, 0xe4, 0x40, 0x13], // electric guitar
];
const ROM_RHYTHM = [
  [0x01, 0x01, 0x18, 0x0f, 0xdf, 0xf8, 0x6a, 0x6d],
  [0x01, 0x01, 0x00, 0x00, 0xc8, 0xd8, 0xa7, 0x48],
  [0x05, 0x01, 0x00, 0x00, 0xf8, 0xaa, 0x59, 0x55],
];
// The VRC7's ROM (Konami's YM2413 cut down to six channels; Nuked-OPLL's
// patch_ds1001), in the same layout: its fifteen voices, which a VGM marks
// by its YM2413 clock's bit 31.
export const VRC7_ROM = [
  [0x03, 0x21, 0x05, 0x06, 0xe8, 0x81, 0x42, 0x27],
  [0x13, 0x41, 0x14, 0x0d, 0xd8, 0xf6, 0x23, 0x12],
  [0x11, 0x11, 0x08, 0x08, 0xfa, 0xb2, 0x20, 0x12],
  [0x31, 0x61, 0x0c, 0x07, 0xa8, 0x64, 0x61, 0x27],
  [0x32, 0x21, 0x1e, 0x06, 0xe1, 0x76, 0x01, 0x28],
  [0x02, 0x01, 0x06, 0x00, 0xa3, 0xe2, 0xf4, 0xf4],
  [0x21, 0x61, 0x1d, 0x07, 0x82, 0x81, 0x11, 0x07],
  [0x23, 0x21, 0x22, 0x17, 0xa2, 0x72, 0x01, 0x17],
  [0x35, 0x11, 0x25, 0x00, 0x40, 0x73, 0x72, 0x01],
  [0xb5, 0x01, 0x0f, 0x0f, 0xa8, 0xa5, 0x51, 0x02],
  [0x17, 0xc1, 0x24, 0x07, 0xf8, 0xf8, 0x22, 0x12],
  [0x71, 0x23, 0x11, 0x06, 0x65, 0x74, 0x18, 0x16],
  [0x01, 0x02, 0xd3, 0x05, 0xc9, 0x95, 0x03, 0x02],
  [0x61, 0x63, 0x0c, 0x00, 0x94, 0xc0, 0x33, 0xf6],
  [0x21, 0x72, 0x0d, 0x00, 0xc1, 0xd5, 0x56, 0x06],
];
/** The YM2413's ROM voices, in the user voice's layout. */
export const OPLL_ROM = ROM;
/** The ROM as the emulator takes it (ymfm's instrument data): 18 × 8 bytes. */
export const OPLL_ROM_BYTES = Uint8Array.from([...ROM, ...ROM_RHYTHM].flat());

// The ROM voices' built-in names (language.md §19, msx), in the ROM's order.
export const OPLL_ROM_NAMES = [
  "violin", "guitar", "piano", "flute", "clarinet", "oboe", "trumpet", "organ", "horn",
  "synth", "harpsichord", "vibraphone", "synth-bass", "acoustic-bass", "electric-guitar",
];

// An operator's fields as the user voice packs them, with their ranges:
// [word, field (the IR player's shadow), bits]. op1's TL and both KSLs and
// waveforms live in $02/$03, the rest in the operator's own bytes.
const OP_FIELDS = [
  ["FM_AMEN", "amen", 1], ["FM_VIB", "vib", 1], ["FM_EG", "eg", 1], ["FM_KS", "rs", 1], ["FM_ML", "mul", 4],
  ["FM_KSL", "ksl", 2], ["FM_WS", "ws", 1], ["FM_AR", "ar", 4], ["FM_DR", "dr", 4], ["FM_SL", "sl", 4], ["FM_RR", "rr", 4],
];
const fit = (v, bits) => Math.max(0, Math.min((1 << bits) - 1, Math.round(v ?? 0)));

/**
 * A voice's eight bytes from `get(word)` — a word's value (FM_AR1 …), or
 * undefined for 0 — each field kept to its register's bits.
 */
function voiceBytes(get) {
  const op = (n) => Object.fromEntries(OP_FIELDS.map(([w, , bits]) => [w, fit(get(`${w}${n}`), bits)]));
  const m = op(1), c = op(2);
  const b01 = (o) => (o.FM_AMEN << 7) | (o.FM_VIB << 6) | (o.FM_EG << 5) | (o.FM_KS << 4) | o.FM_ML;
  return [
    b01(m), b01(c),
    (m.FM_KSL << 6) | fit(get("FM_TL1"), 6),
    (c.FM_KSL << 6) | (c.FM_WS << 4) | (m.FM_WS << 3) | fit(get("FM_FB"), 3),
    (m.FM_AR << 4) | m.FM_DR, (c.FM_AR << 4) | c.FM_DR,
    (m.FM_SL << 4) | m.FM_RR, (c.FM_SL << 4) | c.FM_RR,
  ];
}

// A voice's bytes as its words (the inverse): what a ROM voice's name holds.
function voiceWords(b) {
  const out = new Map([["FM_FB", b[3] & 7], ["FM_TL1", b[2] & 0x3f]]);
  for (const n of [1, 2]) {
    const o = n - 1;
    const set = (w, v) => out.set(`${w}${n}`, v);
    set("FM_AMEN", b[o] >> 7); set("FM_VIB", (b[o] >> 6) & 1); set("FM_EG", (b[o] >> 5) & 1);
    set("FM_KS", (b[o] >> 4) & 1); set("FM_ML", b[o] & 15);
    set("FM_KSL", b[2 + o] >> 6); set("FM_WS", (b[3] >> (n === 1 ? 3 : 4)) & 1);
    set("FM_AR", b[4 + o] >> 4); set("FM_DR", b[4 + o] & 15);
    set("FM_SL", b[6 + o] >> 4); set("FM_RR", b[6 + o] & 15);
  }
  return out;
}

// A ROM voice on a 4-op chip (the OPN's, the OPM's): op1 into op2 on
// algorithm 4, op3 and op4 silent. Rates are on the 4-op's 5-bit scale (AR
// and DR twice the OPLL's, RR the same), a percussive envelope decays at
// its RR through SR, KSR 1 is KS 2, the OPLL's multiples 11, 13 and 14 are
// 10, 12 and 15; the KSL, the rectified sine and the vibrato have no 4-op
// register and are left out.
const OPLL_ML = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];
function voiceAs4op(b) {
  const w = voiceWords(b);
  const out = new Map([["FM_ALG", 4], ["FM_FB", w.get("FM_FB")], ["FM_AMS", 0], ["FM_FMS", 0]]);
  for (const n of [1, 2]) {
    const g = (k) => w.get(`${k}${n}`);
    const set = (k, v) => out.set(`${k}${n}`, v);
    set("FM_AR", 2 * g("FM_AR")); set("FM_DR", 2 * g("FM_DR"));
    set("FM_SR", g("FM_EG") ? 0 : 2 * g("FM_RR")); set("FM_RR", g("FM_RR")); set("FM_SL", g("FM_SL"));
    set("FM_TL", n === 1 ? w.get("FM_TL1") : 0); set("FM_KS", 2 * g("FM_KS")); set("FM_ML", OPLL_ML[g("FM_ML")]);
    set("FM_DT", 0); set("FM_SSG", 0); set("FM_AMEN", g("FM_AMEN"));
  }
  for (const n of [3, 4])
    for (const [k, v] of [["FM_AR", 31], ["FM_DR", 0], ["FM_SR", 0], ["FM_RR", 15], ["FM_SL", 0], ["FM_TL", 127],
      ["FM_KS", 0], ["FM_ML", 1], ["FM_DT", 0], ["FM_SSG", 0], ["FM_AMEN", 0]]) out.set(`${k}${n}`, v);
  return out;
}

/** An OPLL voice's bytes ($00-$07) as a 4-op `def-fm` (voiceAs4op's reading). */
export function opllVoiceDef(name, bytes) {
  const w = voiceAs4op(bytes);
  const op = (n) => ["ar", "dr", "sr", "rr", "sl", "tl", "ks", "ml", "dt", "ssg", "am"]
    .map((k) => `:${k}${n} ${w.get(`FM_${k === "am" ? "AMEN" : k.toUpperCase()}${n}`)}`).join(" ");
  return `(def-fm ${name} :alg ${w.get("FM_ALG")} :fb ${w.get("FM_FB")} :ams 0 :fms 0\n  ${[1, 2, 3, 4].map(op).join("\n  ")}\n)`;
}

/**
 * The ROM voices as built-in def-fm voices (language.md §19): name → its
 * words, the OPLL's own where `part` is the OPLL's, else the 4-op reading.
 */
export function opllRomVoices(part) {
  return new Map(ROM.map((b, i) => [OPLL_ROM_NAMES[i], part === opllFm ? voiceWords(b) : voiceAs4op(b)]));
}

/** The ROM voice (1-15) whose registers `bytes` are, or 0: the user voice. */
function romIndex(bytes) {
  const i = ROM.findIndex((r) => r.every((x, k) => x === bytes[k]));
  return i + 1;
}

const OP_WORDS = ["FM_AR", "FM_DR", "FM_SL", "FM_RR", "FM_KS", "FM_ML", "FM_AMEN", "FM_WS", "FM_EG", "FM_KSL", "FM_VIB", "FM_VEL"];

export const opllFm = {
  name: "opll-fm",
  label: "OPLL FM",
  kind: "fm",
  // The carrier's level is the channel's volume, 3 dB a step; a modulator a
  // voice makes velocity-sensitive moves op1's TL, 0.75 dB in 64.
  level: { stepDb: 3, steps: 16 },
  modLevel: { stepDb: 0.75, steps: 64 },
  words: fmWords({
    channel: ["FM_FB", "FM_SUS"],
    ops: 2,
    op: (n) => (n === 1 ? [...OP_WORDS, "FM_TL"] : OP_WORDS),
  }),
  // The registers narrower than the family's (chips/fm-words.js).
  ranges: { FM_AR: [0, 15], FM_DR: [0, 15], FM_TL: [0, 63], FM_KS: [0, 1] },
  // `init-fm` here: a sine — the modulator silent (TL 63), both operators
  // at once, held while keyed (EG 1), released at once.
  initVoice: new Map([
    ["FM_FB", 0],
    ...[1, 2].flatMap((n) => Object.entries({
      FM_AR: 15, FM_DR: 0, FM_SL: 0, FM_RR: 15, FM_KS: 0, FM_ML: 1, FM_AMEN: 0, FM_WS: 0, FM_EG: 1, FM_KSL: 0, FM_VIB: 0,
      ...(n === 1 ? { FM_TL: 63 } : {}),
    }).map(([w, v]) => [`${w}${n}`, v])),
  ]),
  // The chip has one user voice, which a key-on writes (the encoder): a
  // channel may switch between user voices freely, but two channels whose
  // notes sound together on different ones share one register set, and the
  // note keyed last sets it for both. Said once, naming the tracks and the
  // voices where a def names them. `tracks` [{ head, events }], loops
  // written out; `named` [{ name, kwMap }], the voices the score names.
  checkTracks({ tracks, named, push }) {
    const key = (b) => b.join(",");
    const names = new Map();
    for (const { name, kwMap } of named) {
      const b = voiceBytes((w) => kwMap.get(w));
      if (!romIndex(b) && !names.has(key(b))) names.set(key(b), name);
    }
    // Each track's notes on a user voice: [start, end, voice] in ticks, the
    // voice its registers as of the note (init-fm until it names one).
    const spans = tracks.map(({ head, events }) => {
      const regs = new Map(this.initVoice);
      const out = [];
      for (const e of events) {
        if (e.cmd === "PARAM_SET" && /^FM_/.test(e.args?.target ?? "")) regs.set(e.args.target, e.args.value);
        if (e.cmd !== "NOTE_ON") continue;
        const b = voiceBytes((w) => regs.get(w));
        if (romIndex(b)) continue;
        const len = Math.min(e.args?.length ?? 0, e.args?.gate ?? Infinity);
        out.push([e.tick, e.tick + Math.max(1, len), key(b)]);
      }
      return { head, out };
    });
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++)
        for (const [a0, a1, va] of spans[i].out) {
          const hit = spans[j].out.find(([b0, b1, vb]) => vb !== va && a0 < b1 && b0 < a1);
          if (!hit) continue;
          const voice = (k) => (names.has(k) ? `'${names.get(k)}'` : "a voice of its own");
          push("warning", "W_TARGET",
            `${spans[i].head} (${voice(va)}) and ${spans[j].head} (${voice(hit[2])}) sound two user voices at once; the OPLL has one, and the note keyed last sets it for both — a ROM voice (piano …) needs none`);
          return;
        }
  },
};

// The rhythm mode: channels 7-9 (6-8 here) give way to five ROM rhythm
// sounds, keyed by $0E bits 4-0, their 4-bit volumes in $36-$38 (0 loud),
// each channel's F-number tuning its sounds: BD on 6; HH and SD on 7; TOM
// and the top cymbal on 8. The kits' roles name them, as the YM2608's
// (chips/rhythm-rom.js); there is no rim. A sound is keyed until its next
// hit or its gate's end, where it releases. Its channel's F-number is its
// pitch, which the player moves while it sounds and on through its release
// (:pitch, :semi, glide and their macros).
const RHYTHM = {
  bd: { bit: 0x10, ch: 6, vol: [0x36, 0] },
  sd: { bit: 0x08, ch: 7, vol: [0x37, 0] },
  hh: { bit: 0x01, ch: 7, vol: [0x37, 4] },
  tom: { bit: 0x04, ch: 8, vol: [0x38, 4] },
  top: { bit: 0x02, ch: 8, vol: [0x38, 0] },
};
// c4 is the datasheet's tuning of each channel: $1x, $2x (block, F-number bit 8).
const RHYTHM_C4 = { 6: [0x20, 0x05], 7: [0x50, 0x05], 8: [0xc0, 0x01] };
// The pairs on one channel, which a hit tunes for both.
const RHYTHM_PAIRS = [["sd", "hh"], ["tom", "top"]];

export const opllRhythm = {
  name: "opll-rhythm",
  label: "OPLL rhythm",
  kind: "sample",
  words: NO_WORDS, // mono: no :pan
  level: { stepDb: 3, steps: 16 }, // the 4-bit volume, 15 loud .. 0 (the register's 0 .. 15)
  points: false,
  pitch: true, // the channel's F-number, written while the sound rings
  kit: { kick: "bd", snare: "sd", tom4: "tom", ride: "top", hat: "hh" },
  // A sound's scope lane after its part's first (targets.js scopeLane): its
  // channel's, the pairs sharing one.
  kitLane: { bd: 0, sd: 1, hh: 1, tom: 2, top: 2 },
  // How long a hit's level is followed: the ROM sounds have died by then.
  soundSec: { bd: 2, sd: 2, hh: 2, tom: 2, top: 2 },
  checkNote({ sample, sampleName, pitch, mode, target, once, shared }) {
    if (!sample.rhythm) {
      const heads = target.headsOf(this.name);
      once(`kit:${sampleName}`, `on ${target.name} ${heads[0]}–${heads.at(-1)} play the FM-PAC's rhythm sounds, ${Object.keys(this.kit).join(" ")}; ${sampleName} is not one, and the ${target.system} has no sample channel`);
      return;
    }
    const what = `the FM-PAC's rhythm sound ${sample.rhythm} (${sampleName})`;
    if (mode === "loop") once(`loop:${sampleName}`, `${what} plays once; it has no loop`);
    if (sample.fxNode || sample.importFx?.length)
      once(`fx:${sampleName}`, `${sampleName}'s :fx shapes its :file; ${what} plays as the chip has it`, "warning");
    // A pair on one channel plays at the pitch hit last: said once a score.
    const pitches = (shared.pitches ??= {});
    (pitches[sample.rhythm] ??= new Set()).add(pitchToMidi(pitch));
    for (const [a, b] of RHYTHM_PAIRS) {
      if (shared.pairSaid || !pitches[a] || !pitches[b]) continue;
      if ([...pitches[a], ...pitches[b]].some((m) => m !== [...pitches[a]][0])) {
        shared.pairSaid = true;
        once("pair", `${a} and ${b} are one channel of the FM-PAC, tuned by the pitch of whichever is hit last; they are written at different pitches`, "warning");
      }
    }
  },
  // The rhythm takes channels 7-9 from the FM: a score has one or the other.
  checkScore({ target, allHeads, push }) {
    const rhythm = [...allHeads].filter((h) => target.partOf(h) === this);
    const fm = [...allHeads].filter((h) => target.partOf(h) === opllFm && target.channels[h].voice >= 6);
    if (rhythm.length && fm.length)
      push("error", "E_TARGET", `the FM-PAC's rhythm (${rhythm.join(", ")}) plays on its channels 7-9, so ${fm.join(", ")} cannot play beside it`);
  },
};

// The OPLL as the IR player's FM (chips/opn-fm.js has the contract). One per
// player. Nothing is written until a channel first keys on — a cartridge a
// score with no FM track does not have.
//
// A channel's voice is settled at its key-on: the ROM's when its registers
// are one, else the user voice, written there (another channel may have
// written its own since). A voice change inside a note moves the note at
// once; one between notes waits for the next key-on, so a voice switch's
// run of writes never leaves the user voice half-written.
//
// The player does not send a channel's writes in time order: a note's pitch,
// level and voice macros go before its key-on, its key-off as it starts (or
// as the next note does). So every channel's state is kept by time — its
// voice, volume, pitch and sustain as timelines, its notes as spans that
// open at the player's word that a note keys (noteOn, sent before those
// macros) or at the key-on, and close at the key-off — and each write reads
// the state at its own time. A write is inside a note when its time falls
// in a span after the onset (the key-on write sets the key bit there). A
// run of voice writes at one time (a voice switch, a macro's step) is held
// until the channel's next call and moved then, at its own time — the
// write's fourth element — so a key-off sent after it is known first.
const KEEP = 128; // the spans a channel keeps: well past the player's lookahead
// How far behind its latest entry a timeline keeps what was in force: a
// note's macros are set ahead whole (a long note's vibrato, hundreds of
// frames), so a count would drop the note's own onset before its key reads it.
const KEEP_SECS = 30;
const EPS = 1e-9;

/** A value over time: set(t, v) in any order, get(t) the one in force. */
function timeline(init) {
  const list = [{ t: -Infinity, v: init }];
  return {
    set(t, v) {
      let i = list.length;
      while (i > 1 && list[i - 1].t > t + EPS) i--;
      if (Math.abs(list[i - 1].t - t) < EPS) list[i - 1] = { t, v };
      else list.splice(i, 0, { t, v });
      // Entries older than the window go, but the last one before it stays.
      const cut = list[list.length - 1].t - KEEP_SECS;
      let j = 1;
      while (j + 1 < list.length && list[j + 1].t <= cut) j++;
      if (j > 1) list.splice(1, j - 1);
    },
    get: (t) => list.findLast((e) => e.t <= t + EPS)?.v ?? list[0].v,
  };
}

function opllEncoder() {
  let started, ops, fb, voice, vol, pitch, sus, spans, moved, latest;
  let rmode, rq, rkeys, rvols, rtune; // the rhythm: on, its queue, keys, volume bytes, channel tunings
  const reset = () => {
    started = false;
    ops = Array.from({ length: CHANNELS }, () => [{}, {}]); // the latest operator fields
    fb = new Array(CHANNELS).fill(0);
    voice = Array.from({ length: CHANNELS }, () => timeline(voiceBytes(() => 0)));
    vol = Array.from({ length: CHANNELS }, () => timeline(0));
    pitch = Array.from({ length: CHANNELS }, () => timeline({ fnum: 0, block: 0 }));
    sus = Array.from({ length: CHANNELS }, () => timeline(0));
    spans = Array.from({ length: CHANNELS }, () => []);
    moved = new Array(CHANNELS).fill(null); // the time of a voice move not yet written
    latest = -Infinity; // the latest time a call has named
    rmode = false;
    rq = [];
    rkeys = 0;
    rvols = { 0x36: 0, 0x37: 0, 0x38: 0 };
    rtune = {};
  };
  reset();
  // A call with no time — the run's start, a live edit, a key preview — is
  // now: the latest time the encoder has heard of.
  const at = (when) => {
    if (when === undefined || when === null) return latest;
    if (when > latest) latest = when;
    return when;
  };
  const keyedAt = (ch, t) => spans[ch].some((sp) => t > sp.on + EPS && t < sp.off - EPS);
  // A note keyed at `t`: a span of its own unless one opens there already.
  // A note still open before it ends there — the player keys the channel
  // off for it (a full-gate note's key-off comes with the next note, after
  // that note's macros; a slur keys nothing and opens nothing).
  const open = (ch, t) => {
    started = true;
    const list = spans[ch];
    if (list.some((sp) => Math.abs(sp.on - t) < EPS && sp.off === Infinity)) return;
    for (const sp of list) if (sp.off === Infinity && sp.on < t - EPS) sp.off = t;
    list.push({ on: t, off: Infinity });
    if (list.length > KEEP) list.shift();
  };
  const w = (a, d, t) => (t === undefined ? [OPLL_PORT, a, d] : [OPLL_PORT, a, d, t]);
  const r2x = (ch, keyed, t) => {
    const { fnum, block } = pitch[ch].get(t);
    return (sus[ch].get(t) << 5) | (keyed ? 0x10 : 0) | (block << 1) | (fnum >> 8);
  };
  const r3x = (ch, t) => (romIndex(voice[ch].get(t)) << 4) | vol[ch].get(t);
  // The channel's voice into the chip at `t`: the user voice's bytes when it
  // is no ROM voice, and $30's voice and volume (`stamp`: each write's time).
  const settle = (ch, t, stamp) => {
    const b = voice[ch].get(t);
    return [...(romIndex(b) ? [] : b.map((d, a) => w(a, d, stamp))), w(0x30 + ch, r3x(ch, t), stamp)];
  };
  // A held voice move: written, at its time, if a note sounds then.
  const flush = (ch) => {
    const t = moved[ch];
    moved[ch] = null;
    return t !== null && started && keyedAt(ch, t) ? settle(ch, t, t) : [];
  };
  // The channel's voice, from its latest fields, as of `t`; a move at
  // another time than the one held writes that one first.
  const voiceMoved = (ch, t) => {
    const out = moved[ch] !== null && Math.abs(moved[ch] - t) > EPS ? flush(ch) : [];
    voice[ch].set(t, voiceBytes((word) => {
      if (word === "FM_FB") return fb[ch];
      const n = Number(word.slice(-1));
      const field = word === "FM_TL1" ? "tl" : OP_FIELDS.find(([x]) => `${x}${n}` === word)?.[1];
      return ops[ch][n - 1][field];
    }));
    moved[ch] = t;
    return out;
  };
  return {
    channels: CHANNELS,
    csm: false,
    carriers: [1], // op2
    reset,
    op(ch, opIdx, reg, o, when) {
      if (opIdx > 1) return [];
      if (opIdx === 1 && reg === "tl") {
        vol[ch].set(at(when), fit(o.tl, 4));
        return [...flush(ch), ...(started ? [w(0x30 + ch, r3x(ch, at(when)))] : [])];
      }
      Object.assign(ops[ch][opIdx], o);
      return voiceMoved(ch, at(when));
    },
    alg(ch, regs, when) {
      fb[ch] = fit(regs.feedback, 3);
      return voiceMoved(ch, at(when));
    },
    pan: () => [], // mono
    // A (fractional) MIDI note: the lowest block whose F-number fits 9 bits.
    pitch(ch, midi, when) {
      const t = at(when);
      const hz = 440 * 2 ** ((midi - 69) / 12);
      let block = 0;
      let f = Math.round((hz * 2 ** 19) / RATE);
      while (f > 511 && block < 7) f = Math.round((hz * 2 ** 19) / (RATE * 2 ** ++block));
      const fnum = Math.max(0, Math.min(511, f));
      pitch[ch].set(t, { fnum, block });
      return [...flush(ch), ...(started ? [w(0x10 + ch, fnum & 0xff), w(0x20 + ch, r2x(ch, keyedAt(ch, t), t))] : [])];
    },
    // The player's word, before a note's macros, that it keys at `when`.
    noteOn(ch, when) {
      open(ch, at(when));
      return flush(ch);
    },
    // The key: both operators at once, on any mask but 0. A key-off closes
    // the latest span open at its time. Channels 7-9 are the rhythm's in
    // its mode, and an FM key does not reach them.
    key(ch, mask, when) {
      const t = at(when);
      if (rmode && ch >= 6) return [];
      if (!mask) {
        const sp = spans[ch].findLast((x) => x.off === Infinity && x.on <= t + EPS);
        if (sp) sp.off = t;
        return [...flush(ch), ...(started ? [w(0x20 + ch, r2x(ch, false, t))] : [])];
      }
      open(ch, t);
      return [...flush(ch), ...settle(ch, t), w(0x10 + ch, pitch[ch].get(t).fnum & 0xff), w(0x20 + ch, r2x(ch, true, t))];
    },
    // :sus, $2x bit 5.
    sus(ch, v, when) {
      const t = at(when);
      sus[ch].set(t, v ? 1 : 0);
      return [...flush(ch), ...(started ? [w(0x20 + ch, r2x(ch, keyedAt(ch, t), t))] : [])];
    },
    // A live edit (IRPlayer.setParam: the panel, a MIDI CC, the AI link) is
    // heard at once, sounding or not: the channel's voice, now.
    live(ch) {
      if (ch < 0 || ch >= CHANNELS || !started || (rmode && ch >= 6)) return [];
      moved[ch] = null;
      return settle(ch, latest);
    },
    isKeyOn: (port, addr, data) => port === OPLL_PORT && addr >= 0x20 && addr <= 0x28 && (data & 0x10) !== 0,
    lfo: () => [], // the OPLL's LFO is fixed
    rhythm: rhythmOps(),
  };

  // The rhythm as the IR player's (chips/ym2608.js `rhythm` has the
  // contract: hit, level, dump). $0E and the volume bytes hold several
  // sounds each, and the player sends hits out of time order, so every call
  // is queued with its time and the player's flush(horizon) — once every
  // event up to the horizon is sent — writes them in time order. A hit keys
  // its sound (off first if it is keyed, so it starts over), at its level,
  // its channel tuned to its note.
  function rhythmOps() {
    const queue = (op) => { rq.push(op); return []; };
    const tune = (out, ch, midi, t) => {
      const [lo, hi] = RHYTHM_C4[ch];
      const c4 = (lo | ((hi & 1) << 8)) * 2 ** ((hi >> 1) & 7);
      const abs = c4 * 2 ** ((midi - 60) / 12);
      let block = 0;
      while (block < 7 && Math.round(abs / 2 ** block) > 511) block++;
      const fnum = Math.max(1, Math.min(511, Math.round(abs / 2 ** block)));
      const key = (block << 9) | fnum;
      if (rtune[ch] === key) return;
      rtune[ch] = key;
      out.push(w(0x10 + ch, fnum & 0xff, t), w(0x20 + ch, (block << 1) | (fnum >> 8), t));
    };
    const volume = (out, sound, il, t) => {
      const [addr, shift] = RHYTHM[sound].vol;
      const v = 15 - Math.max(0, Math.min(15, il));
      rvols[addr] = (rvols[addr] & ~(15 << shift)) | (v << shift);
      out.push(w(addr, rvols[addr], t));
    };
    const keys = (out, bits, t) => {
      rkeys = bits;
      out.push(w(0x0e, 0x20 | rkeys, t));
    };
    // One op into the chip; `t` its time, stamped on its writes (none: now).
    const apply = (out, op, t) => {
      const r = RHYTHM[op.sound];
      if (!rmode) {
        // The mode, and the volumes' start, at the first rhythm write.
        started = rmode = true;
        out.push(w(0x0e, 0x20, t));
        for (const a of [0x36, 0x37, 0x38]) out.push(w(a, rvols[a], t));
      }
      if (op.k === "hit") {
        volume(out, op.sound, op.il, t);
        tune(out, r.ch, op.midi, t);
        if (rkeys & r.bit) keys(out, rkeys & ~r.bit, t);
        keys(out, rkeys | r.bit, t);
      } else if (op.k === "level") volume(out, op.sound, op.il, t);
      else if (op.k === "tune") tune(out, r.ch, op.midi, t);
      else if (rkeys & r.bit) keys(out, rkeys & ~r.bit, t);
    };
    // A call with a time joins the queue; one with none (an audition, a
    // live edit) is written now.
    const take = (when, op) => {
      if (when !== undefined && when !== null) return queue({ ...op, t: at(when) });
      const out = [];
      apply(out, op);
      return out;
    };
    return {
      hit: (sound, il, _pan, when, midi = 60) => take(when, { k: "hit", sound, il, midi }),
      level: (sound, il, _pan, when) => take(when, { k: "level", sound, il }),
      // The sound's channel at `midi` (fractional: a pitch move's frame).
      tune: (sound, midi, when) => take(when, { k: "tune", sound, midi }),
      // A dump with no time is a stop: the queue is dropped and every sound
      // keyed off now.
      dump(sound, when) {
        if (when !== undefined && when !== null) return queue({ t: at(when), k: "dump", sound });
        rq = [];
        if (!rmode || !rkeys) return [];
        const out = [];
        keys(out, 0);
        return out;
      },
      flush(horizon) {
        const due = rq.filter((op) => op.t <= horizon + EPS).sort((a, b) => a.t - b.t);
        if (!due.length) return [];
        rq = rq.filter((op) => op.t > horizon + EPS);
        const out = [];
        for (const op of due) apply(out, op, op.t);
        return out;
      },
    };
  }
}

export const ym2413 = {
  chip: "ym2413",
  clock: CLOCK,
  parts: [opllFm, opllRhythm],
  encoder: true,
  emulator: true,
  // A cartridge, as the SCC: a score with no OPLL write has no OPLL in its
  // VGM (the encoder writes nothing before a key).
  optional: true,
  init: [],
  // VGM 1.00: the clock at 0x10, and the 0x51 command (an address and a byte).
  vgm: { clock: 0x10, ports: { [OPLL_PORT]: { cmd: 0x51, addr: true } } },
  fmEncoder: opllEncoder,
};

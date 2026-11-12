// ---------------------------------------------------------------------------
// A song import onto `:target midi` (File > Open…, Target
// midi): the file is imported onto its own machine as ever (VGM, NSF, the
// trackers, MDX, MGS), and that score goes through the MIDI export and the
// MIDI import — one road for every importer, the MIDI import's beat, repeats
// and bends included.
//
// On the way each track is given what a GM instrument plays it with, which a
// chip's score does not say:
//   a melodic track   a GM program per voice — by its name where it names an
//                     instrument (a tracker's "Bass", a ROM voice, a gm-*),
//                     else by the channel's kind and range (programFor)
//   the noise         kit roles by pitch: the higher a hat, the lower a
//                     snare, a long high one a crash (noiseRoles)
//   a sample track    kit roles by sample: a role's or a ROM sound's name as
//                     it is, a name that says one (BD, snare, HH …), else read
//                     off the sound (sampleRole: its zero crossings, its low
//                     end, its length); a sample played at many pitches is an
//                     instrument, not a drum
// What a chip has and GM has not — FM patches, duty, wavetables, the noise's
// mode, the samples' own sound — is not carried.
// ---------------------------------------------------------------------------

import { exportMidi } from "../export/export-midi.js";
import { parseMidi, analyzeMidi, defaultMidiOptions, midiToMmlisp } from "./import-midi.js";
import { targetProfile } from "../machine/targets.js";
import { programOf, GM_DRUM_NOTE } from "../midi/gm-names.js";
import { pitchToMidi } from "../lang/ir-utils.js";
import { parse } from "../lang/mmlisp-parser.js";

// Notes are judged in seconds: a chip import's ticks need not sit on a beat
// (a VGM's are 1/240 s).
const HELD_SEC = 0.4; // a note held this long or longer is a sustained one
const TICKING_SEC = 0.25; // hits this close are a hat ticking along
const RINGS_SEC = 0.8; // a top noise held this long is a crash
const BASS_UNDER = 48; // a part whose middle note is under C3 is the bass,
const LOW_UNDER = 55; //   and so is the song's lowest part under G3 when it
const LOW_APART = 7; //    sits a fifth or more under the next

// ── Programs ──────────────────────────────────────────────────────────────

// An instrument a voice's name says (a tracker's instrument, a def's name),
// first match.
const NAMED = [
  [/slap/, "gm-bass-slap1"], [/fretless/, "gm-bass-fretless"], [/synth.?bass|syn.?bs|s\.?bass/, "gm-bass-syn1"],
  [/bass|\bbs\b/, "gm-bass-finger"],
  [/e\.?\s?piano|\bep\b|rhodes|wurl|dx.?ep/, "gm-ep1"], [/piano|\bpno\b|\bpf\b|grand/, "gm-piano"],
  [/harpsi/, "gm-harpsi"], [/clav/, "gm-clav"], [/organ|\borg\b/, "gm-organ-drawbar"], [/accord/, "gm-accordion"],
  [/marimba/, "gm-marimba"], [/xylo/, "gm-xylo"], [/vib(es|raphone)/, "gm-vibes"], [/glock|bell|chime|celest/, "gm-glock"],
  [/dist|overdr|\bod\b/, "gm-guitar-dist"], [/guitar|\bgtr?\b|gt\./, "gm-guitar-clean"],
  [/pizz/, "gm-str-pizz"], [/violin|fiddle/, "gm-violin"], [/cello/, "gm-cello"],
  [/string|\bstr\b|strs|ensemble/, "gm-strings1"], [/choir|voice|vox|aah|ooh/, "gm-choir"],
  [/trump|\btp\b|\btpt\b/, "gm-trumpet"], [/trombone|\btb\b/, "gm-trombone"], [/horn/, "gm-horn"],
  [/synth.?brass|syn.?br/, "gm-synbrass1"], [/brass/, "gm-brass"],
  [/sax/, "gm-sax-alto"], [/oboe/, "gm-oboe"], [/clarinet|\bclar/, "gm-clarinet"], [/flute|\bfl\b|pipe/, "gm-flute"],
  [/ocarina/, "gm-ocarina"], [/whistle/, "gm-whistle"], [/harp/, "gm-harp"], [/sitar/, "gm-sitar"], [/koto/, "gm-koto"],
  [/pad|warm/, "gm-pad-warm"], [/square|\bsqr\b|pulse|chip/, "gm-lead-square"], [/saw|lead|synth|\bsyn\b/, "gm-lead-saw"],
];

/**
 * The gm voice a track's voice plays as: a name GM knows as it is, a name
 * that says an instrument, else by the channel's kind and the notes' range
 * and lengths. `notes`: [{ key, length (s) }] of the notes it plays;
 * `lowest`: its track is the song's bass line by place (gmReading).
 */
export function programFor(name, part, notes, { lowest = false } = {}) {
  if (name && programOf(name) != null) return name;
  const said = name && !numbered(name) && NAMED.find(([re]) => re.test(name.toLowerCase()))?.[1];
  if (said) return said;
  const mid = median(notes.map((n) => n.key));
  const kind = part?.kind;
  if (mid != null && (mid < BASS_UNDER || (lowest && mid < LOW_UNDER))) return kind === "fm" ? "gm-bass-finger" : "gm-bass-syn1";
  if (kind === "fm") return median(notes.map((n) => n.length)) >= HELD_SEC ? "gm-strings1" : "gm-ep1";
  if (part?.name === "fc-tri") return "gm-flute";
  if (kind === "wave" || /saw/.test(part?.name ?? "")) return "gm-lead-saw";
  if (kind === "tone") return "gm-lead-square";
  return "gm-piano";
}

// A name an importer numbers its voices and samples by (voice-01, dac-03):
// it says nothing of the instrument.
const numbered = (name) => /^(voice|dac|pcm|sample|smp|wave|ins|inst|instr|patch|tone|s|v)[-_ ]?\d+$/i.test(name);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── Drums ─────────────────────────────────────────────────────────────────

// The ROM rhythms' sounds (the YM2608's, the YM2413's) as kit roles.
const ROM_ROLES = { bd: "kick", sd: "snare", hh: "hat", top: "crash", tom: "tom3", rim: "rim" };
// A sample's name that says its role.
const NAMED_DRUMS = [
  [/kick|\bbd\b|bass.?drum|\bbd\d/, "kick"], [/snare|\bsd\b|\bsd\d|\bsn\b/, "snare"], [/clap|\bcp\b/, "clap"],
  [/open.?h|\boh\b|ohh|hh.?o/, "hat-open"], [/hi.?hat|\bhh\b|chh|\bch\b|hat/, "hat"],
  [/crash|\bcr\b|cymb|\bcy\b/, "crash"], [/ride|\brd\b/, "ride"], [/tom|\btm\b/, "tom3"],
  [/rim|\brs\b/, "rim"], [/cowbell|\bcb\b/, "cowbell"], [/tamb/, "tamb"], [/shak|maraca/, "maracas"],
];
// The kit's families: a sound heard as one takes the family's first role
// free, in order — the song's most played low sound the kick, the rest the
// toms, low to high (GM's tom1 is the floor tom).
const FAMILY = { kick: "low", tom3: "low", snare: "snare", hat: "hat", "hat-open": "open", crash: "cym" };
const FAMILY_ROLES = {
  low: ["kick", "tom1", "tom3", "tom5", "tom6", "tom2", "tom4", "kick2"],
  snare: ["snare", "snare2", "clap", "rim"], hat: ["hat", "hat-pedal"], open: ["hat-open", "hat-pedal"],
  cym: ["crash", "ride", "crash2", "splash", "china"],
};
// A sample with nothing to go by, in order of use.
const FALLBACK = ["kick", "snare", "hat", "crash", "tom3", "hat-open"];
// Longer than this a sample is a stream (a driver's mix on the DAC), not a hit.
const STREAM_SEC = 2;

/**
 * What a sample sounds like, off its first quarter second: how often it
 * crosses zero (Hz, about its brightness), how much of it is under 150 Hz,
 * and how long it rings (s, to 30 dB under its peak).
 */
export function sampleFeatures(x, rate) {
  const n = Math.min(x.length, Math.round(rate * 0.25));
  const a = 1 - Math.exp((-2 * Math.PI * 150) / rate);
  let zc = 0, all = 0, low = 0, y = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (i && (x[i - 1] < 0) !== (v < 0)) zc++;
    all += v * v;
    y += a * (v - y);
    low += y * y;
  }
  const win = Math.max(1, Math.round(rate / 100));
  let peak = 0, last = 0;
  const rms = [];
  for (let i = 0; i < x.length; i += win) {
    let e = 0;
    for (let j = i; j < Math.min(x.length, i + win); j++) e += x[j] * x[j];
    rms.push(Math.sqrt(e / win));
    peak = Math.max(peak, rms.at(-1));
  }
  rms.forEach((r, k) => { if (r >= peak * 0.03) last = k; });
  return { zcr: n ? zc / 2 / (n / rate) : 0, low: all ? low / all : 0, dur: ((last + 1) * win) / rate };
}

/**
 * The kit role a sample's sound is, from sampleFeatures: low (the kick, or a
 * tom), a cymbal (bright, little low end: a hat, an open hat, a crash by its
 * length), else a snare.
 */
export function sampleRole({ zcr, low, dur }) {
  if (low >= 0.5 || zcr < 120) return "kick";
  if (low >= 0.25 && zcr < 450) return "tom3";
  if (zcr >= 2000 && low < 0.08) return dur >= 0.45 ? "crash" : dur >= 0.2 ? "hat-open" : "hat";
  return "snare";
}

/**
 * The samples' roles as heard (`pcm`: an import's or a score's { mono,
 * entries }), name → role — for a drum whose name says nothing (an MDX's
 * `pdx-003`); a stream (a sample longer than a hit) has none.
 */
export function heardRoles(pcm) {
  const out = new Map();
  for (const sm of pcm?.entries ?? []) {
    const x = pcm.mono.subarray(sm.offset, sm.offset + sm.frames);
    const rate = sm.rate ?? pcm.rate;
    if (!x.length || x.length / rate > STREAM_SEC) continue;
    out.set(sm.name, sampleRole(sampleFeatures(x, rate)));
  }
  return out;
}

/** Each sample's own peak, dBFS (`pcm` as heardRoles): its headroom, which a conversion's normalize lifts it by. */
export function samplePeaks(pcm) {
  const out = new Map();
  for (const sm of pcm?.entries ?? []) {
    const x = pcm.mono.subarray(sm.offset, sm.offset + sm.frames);
    let peak = 0;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    if (peak > 0) out.set(sm.name, 20 * Math.log10(peak));
  }
  return out;
}

// Roles for the sounds heard (or guessed) as `firsts` — [name, role, zcr],
// most played first — each taking its family's next role not `taken`: of
// the low ones the most played kick is the kick and the rest are toms, low to
// high; of the others, those heard as the family's first role go first.
function spread(firsts, taken) {
  const out = new Map();
  const byFamily = new Map();
  for (const f of firsts) {
    const fam = FAMILY[f[1]] ?? f[1];
    (byFamily.get(fam) ?? byFamily.set(fam, []).get(fam)).push(f);
  }
  // An open hat and a crash both ring bright and long: of two such, with
  // none heard as the other, the more played is the open hat.
  for (const [from, to] of [["cym", "open"], ["open", "cym"]]) {
    const list = byFamily.get(from);
    if (list?.length >= 2 && !byFamily.has(to)) byFamily.set(to, [list.splice(from === "cym" ? 0 : list.length - 1, 1)[0]]);
  }
  for (const [fam, list] of byFamily) {
    const roles = (FAMILY_ROLES[fam] ?? [fam]).filter((r) => !taken.has(r));
    let order;
    if (fam === "low") {
      const kick = list.find(([, r]) => r === "kick") ?? list[0];
      order = [kick, ...list.filter((f) => f !== kick).sort((a, b) => a[2] - b[2])];
    } else order = [...list.filter(([, r]) => r === roles[0]), ...list.filter(([, r]) => r !== roles[0])];
    order.forEach(([name], i) => out.set(name, roles[Math.min(i, roles.length - 1)] ?? fam));
  }
  return out;
}

/**
 * The noise's notes ({ key, at, length }, in seconds) as kit roles, by
 * pitch: with one pitch a hat if it ticks along (TICKING_SEC), else a snare; with
 * more, the upper half hats and the lower snares — a long note at the top a
 * crash, one an octave under the rest a kick.
 */
export function noiseRoles(notes) {
  const keys = [...new Set(notes.map((n) => n.key))].sort((a, b) => a - b);
  const roles = new Map();
  if (keys.length === 1) {
    const ats = notes.map((n) => n.at).sort((a, b) => a - b);
    const apart = median(ats.slice(1).map((t, i) => t - ats[i]).filter((d) => d > 1e-6));
    roles.set(keys[0], apart != null && apart <= TICKING_SEC ? "hat" : "snare");
    return roles;
  }
  const mid = keys[Math.floor(keys.length / 2)], top = keys.at(-1);
  for (const k of keys) {
    const long = median(notes.filter((n) => n.key === k).map((n) => n.length)) >= RINGS_SEC;
    roles.set(k, k === top && long ? "crash" : k >= mid ? "hat" : k <= top - 12 && k === keys[0] ? "kick" : "snare");
  }
  return roles;
}

// ── The instruments a score names ─────────────────────────────────────────

/**
 * Each track's instruments as the chip score names them where no voice
 * does: the envelope defs its notes are played under (a tracker's
 * instrument on a wave or a PSG channel is `env-bass`, `vol-lead` …), most
 * used first, through the defs it names. { head → [names] }
 */
export function instrumentNames(source) {
  let ast;
  try { ast = parse(source); } catch { return {}; }
  const atoms = (node, out = []) => {
    if (node.kind === "atom") out.push(node.value);
    else for (const it of node.items ?? []) atoms(it, out);
    return out;
  };
  const defs = new Map();
  const tracks = [];
  for (const form of ast) {
    const [head, name] = form.items ?? [];
    if (head?.value === "def" && name?.kind === "atom") defs.set(name.value, atoms({ items: form.items.slice(2) }));
    else if (head?.kind === "atom" && !/^(def|import|def-|let\b)/.test(head.value)) tracks.push([head.value, atoms({ items: form.items.slice(1) })]);
  }
  const ENV = /^(env|vol|trem)-(.+)$/;
  const out = {};
  for (const [head, words] of tracks) {
    const count = new Map();
    const walk = (ws, depth) => {
      for (const w of ws) {
        const m = ENV.exec(w);
        if (m) count.set(m[2], (count.get(m[2]) ?? 0) + 1);
        else if (defs.has(w) && depth < 8) walk(defs.get(w), depth + 1);
      }
    };
    walk(words, 0);
    if (count.size) out[head] = [...count].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  }
  return out;
}

// ── The rewrite ───────────────────────────────────────────────────────────

const isOn = (e) => e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON";
const keyOf = (e) => pitchToMidi(e.args?.pitch ?? "c4");

/**
 * The chip score's IR with what a GM instrument plays it with: each track's
 * voices as gm voices, its noise and its drum samples as kit roles (see the
 * file's head). `pcm`: the import's samples ({ mono, entries }), heard for
 * their roles; `names`: each track's instruments where no voice names them
 * (instrumentNames). Returns { ir, said: [what was guessed, for the log] }.
 */
export function gmReading(ir, { pcm = null, names = {} } = {}) {
  const target = targetProfile(ir.metadata?.target);
  const said = [];
  // Seconds a tick at the song's first tempo.
  const bpm = ir.tracks.flatMap((t) => t.events).find((e) => e.cmd === "TEMPO_SET")?.args?.bpm ?? 120;
  const sec = (ticks) => (ticks * 60) / bpm / (ir.ppqn || 96);
  // A sample's name → what its sound is: its role, its brightness, or a stream.
  const heard = new Map();
  for (const sm of pcm?.entries ?? []) {
    const x = pcm.mono.subarray(sm.offset, sm.offset + sm.frames);
    const rate = sm.rate ?? pcm.rate;
    if (!x.length) continue;
    if (x.length / rate > STREAM_SEC) { heard.set(sm.name, { stream: true }); continue; }
    const f = sampleFeatures(x, rate);
    heard.set(sm.name, { role: sampleRole(f), zcr: f.zcr });
  }
  const drumTracks = []; // the sample tracks of drums: their roles are the song's, below
  // The song's lowest melodic part, where it sits a fifth under the rest.
  const mids = ir.tracks.map((tr) => {
    const kind = target.partOf(tr.scoreChannel ?? tr.channel)?.kind;
    const keys = tr.events.filter((e) => e.cmd === "NOTE_ON").map(keyOf);
    return kind === "noise" || kind === "sample" || !keys.length ? null : median(keys);
  });
  const order = mids.map((m, i) => [m, i]).filter(([m]) => m != null).sort((a, b) => a[0] - b[0]);
  const lowest = order.length > 1 && order[1][0] - order[0][0] >= LOW_APART ? order[0][1] : -1;
  const tracks = ir.tracks.map((tr, ti) => {
    const head = tr.scoreChannel ?? tr.channel;
    const part = target.partOf(head);
    const events = tr.events.map((e) => ({ ...e, args: e.args && { ...e.args } }));
    const ons = events.filter(isOn);
    if (!ons.length) return { ...tr, events };
    if (part?.kind === "noise") {
      const roles = noiseRoles(ons.map((e) => ({ key: keyOf(e), at: sec(e.tick), length: sec(e.args?.length ?? 0) })));
      for (const e of ons) {
        e.cmd = "PCM_NOTE_ON";
        e.args.sample = roles.get(keyOf(e));
      }
      said.push(`${head}: drums by pitch (${[...new Set(roles.values())].join(", ")})`);
      return { ...tr, events };
    }
    if (part?.kind === "sample" && ons.every((e) => e.cmd === "PCM_NOTE_ON")) {
      // A sample struck at many pitches is an instrument.
      const pitches = new Map();
      for (const e of ons) (pitches.get(e.args.sample) ?? pitches.set(e.args.sample, new Set()).get(e.args.sample)).add(keyOf(e));
      const tuned = [...pitches].filter(([, ks]) => ks.size >= 4).map(([s]) => s);
      if (tuned.length * 2 > pitches.size) return { ...tr, events: voiced(events, part, head, said, sec, (s) => s) };
      drumTracks.push({ head, ons });
      return { ...tr, events };
    }
    return { ...tr, events: voiced(events, part, head, said, sec, null, names[head]?.[0] ?? null, ti === lowest) };
  });
  // The drum samples' roles, across the song: a role's or a ROM sound's name
  // as it is, a name that says one, else what the sound is (or its place in
  // the order of use); a stream is left out.
  if (drumTracks.length) {
    const count = new Map();
    for (const { ons } of drumTracks) for (const e of ons) count.set(e.args.sample, (count.get(e.args.sample) ?? 0) + 1);
    const fixed = new Map(), firsts = [], streams = new Set();
    let fb = 0;
    for (const [smp] of [...count].sort((a, b) => b[1] - a[1])) {
      const h = heard.get(smp);
      if (h?.stream) { streams.add(smp); continue; }
      if (GM_DRUM_NOTE[smp] != null) fixed.set(smp, smp);
      else if (ROM_ROLES[smp]) fixed.set(smp, ROM_ROLES[smp]);
      else {
        const named = numbered(smp) ? null : NAMED_DRUMS.find(([re]) => re.test(smp.toLowerCase()))?.[1];
        if (named) fixed.set(smp, named);
        else firsts.push([smp, h?.role ?? FALLBACK[fb++ % FALLBACK.length], h?.zcr ?? 0]);
      }
    }
    const roles = new Map([...fixed, ...spread(firsts, new Set(fixed.values()))]);
    for (const { head, ons } of drumTracks) {
      for (const e of ons) {
        if (streams.has(e.args.sample)) { e.cmd = "REST"; delete e.args.sample; }
        else e.args.sample = roles.get(e.args.sample);
      }
      const mine = new Set(ons.map((e) => e.args?.sample).filter(Boolean));
      const renamed = [...roles].filter(([smp, r]) => smp !== r && mine.has(r));
      if (renamed.length) said.push(`${head}: ${renamed.map(([smp, r]) => `${smp} → ${r}`).join(", ")}`);
    }
    if (streams.size) said.push(`${[...streams].join(", ")}: a stream (longer than ${STREAM_SEC} s), not a hit — left out`);
  }
  // A title the score did not write is its file's name: none.
  const meta = ir.metadata ?? {};
  const metadata = meta.title === meta.source ? { ...meta, title: "" } : meta;
  return { ir: { ...ir, metadata, tracks }, said };
}

// A melodic track's voices as gm voices: each voice (a note's `_voice`, a
// change's `_voiceSet`; a sample's name on a sample track) read by
// programFor over the notes it plays.
function voiced(events, part, head, said, sec, sampleVoice, named = null, lowest = false) {
  // A note no voice names is the track's instrument's (`named`), if it has one.
  const voiceOf = (e) => (sampleVoice ? sampleVoice(e.args?.sample) : e._voice) ?? named ?? "";
  const follows = !sampleVoice && events.some((e) => e._voiceSet);
  const notesBy = new Map();
  let now = "";
  for (const e of events) {
    if (follows && e._voiceSet) now = e._voiceSet;
    if (!isOn(e)) continue;
    const v = follows ? now : voiceOf(e);
    (notesBy.get(v) ?? notesBy.set(v, []).get(v)).push({ key: keyOf(e), length: sec(e.args?.length ?? 0) });
  }
  const gm = new Map([...notesBy].map(([v, notes]) => [v, programFor(v || null, part, notes, { lowest })]));
  for (const e of events) {
    if (follows && e._voiceSet) e._voiceSet = gm.get(e._voiceSet) ?? programFor(e._voiceSet, part, []);
    else if (isOn(e) && !follows) e._voice = gm.get(voiceOf(e));
  }
  const changed = [...gm].filter(([v, g]) => v !== g);
  if (changed.length) said.push(`${head}: ${changed.map(([v, g]) => `${v || "(its sound)"} → ${g}`).join(", ")}`);
  return events;
}

/**
 * A chip score's IR (compiled with `voiceStamps`) as a `:target midi`
 * score: gmReading, the MIDI export, the MIDI import at its defaults.
 * `source`: the chip score's text, for the instruments it names.
 * `from`: what the header says it was imported from ("VGM, read as md").
 * Returns { source, warnings }.
 */
export function chipScoreToMidi(ir, { source = "", pcm = null, fileName, from, structure = true } = {}) {
  const { ir: gm, said } = gmReading(ir, { pcm, names: instrumentNames(source) });
  const { bytes, notes } = exportMidi(gm);
  const parsed = parseMidi(bytes);
  // Its tracks are the chip's channels, each one voice: a lane a track.
  const a = analyzeMidi(parsed, { mono: true });
  const read = midiToMmlisp(parsed, { ...defaultMidiOptions(a, "midi"), structure, fileName, from }, a);
  return {
    source: read.source,
    warnings: [
      "the instruments and drums are guesses from the chip's channels — rename them in the score",
      ...said,
      ...notes.filter((n) => !/no GM program|own writes are left out/.test(n)),
      ...read.warnings,
    ],
  };
}

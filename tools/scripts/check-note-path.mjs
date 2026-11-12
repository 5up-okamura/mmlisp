// The note path is one for every voice (live/src/player/ir-player-levels.js
// _playNote): on every machine, every channel — its melodic ones, and its
// sample ones on a sample (a rhythm channel its sound) — plays one phrase and
// the path's own calls are held to one list — where each note closes and how
// (_closeNote: the gate rule, _noteGate), where its :keyon retriggers fall
// (_noteRetriggers), and that a muted track's note keys nothing but only
// silences its voice (_silence) while its notes still close. A voice that
// took a path of its own would part from the list on its channel.
import assert from "node:assert/strict";
import { compileMMLisp } from "../../live/src/lang/mmlisp2ir.js";
import { fileURLToPath } from "node:url";
import { readImportSources } from "../../drv/tools/mmb-build.mjs";
import { bakedChipSamples } from "../../drv/tools/wav.mjs";
import { IRPlayer } from "../../live/src/player/ir-player.js";
import { TARGETS, targetProfile } from "../../live/src/machine/targets.js";
import { newScoreSource } from "../../live/src/app/new-score.js";
import { CORE_OF_KIND } from "../../live/src/player/ir-player-shared.js";

// At :tempo 120 a quarter is 0.5 s: a full gate (the next note closes it), a
// half gate (its own end), a full gate, a hold (the rest ends it), a rest,
// and a half note rolled by :keyon on the eighths, which the track's end
// closes. One pitch: a rhythm sound has none.
const PHRASE = ":len 4 c :gate* 0.5 c :gate* 1 c :gate 0 c _ :gate* 1 (macro :step 1/8 :keyon [0 1 1 1]) :len 2 c";
// A sample channel's score sits beside drv/tests' wavs, which its :file reads.
const SAMPLE_SCORE = fileURLToPath(new URL("../../drv/tests/note-path.mmlisp", import.meta.url));
const RHYTHM = new Set(["rhythm", "opll-rhythm", "midi-drums"]); // a sound or a kit role by name
const CLOSES = [
  [0.5, "next"], [0.75, "gate"], [1.5, "next"], [2.0, ""], [3.5, ""],
];
const RETRIGS = [2.75, 3.0, 3.25];
const NOTES = [0, 0.5, 1.0, 1.5, 2.5];

const how = (h) => (h?.next ? "next" : h?.gate ? "gate" : h?.host ? "host" : "");
const near = (a, b) => Math.abs(a - b) <= 1 / 60 + 1e-6; // a frame-clocked machine's frames

// A machine's melodic channels (those of File > New's score), or its
// sample ones (its channel table's: a DDA is another name of a wave channel,
// a MIDI drum track a kit role),
// each on the phrase.
function score(name, samples) {
  const channels = targetProfile(name).channels;
  const sounds = new Map([...newScoreSource(name).matchAll(/^\((rhythm\d) (\S+)$/gm)].map((m) => [m[1], m[2]]));
  const heads = samples
    ? Object.keys(channels).filter((h) => channels[h].part?.kind === "sample")
    : [...newScoreSource(name).matchAll(/^\(([a-z0-9-]+)\b/gm)].map((m) => m[1])
      .filter((h) => ["fm", "psg", "none"].includes(CORE_OF_KIND[channels[h]?.part?.kind]));
  if (!heads.length) return null;
  const voice = (h) => (!samples ? "" : RHYTHM.has(channels[h].part.name) ? ` ${sounds.get(h) ?? "kick"}` : " blip");
  return `(def-score :target ${name})\n${samples ? '(def-pcm blip :file "blip.wav")\n' : ""}`
    + heads.map((h, i) => `(${h}${voice(h)}${i ? "" : " :tempo 120"} ${PHRASE})`).join("\n");
}

function run(name, samples, muted) {
  const src = score(name, samples);
  if (!src) return [];
  const path = samples ? SAMPLE_SCORE : "note-path.mmlisp";
  const { ir, diagnostics } = compileMMLisp(src, path, { imports: readImportSources(path, src) });
  const errors = diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(errors.map((d) => d.message), [], `${name}: the phrase compiles on every ${samples ? "sample" : "melodic"} channel`);
  const p = new IRPlayer(() => {});
  p.loadJSON(ir);
  // The samples as Live bakes them: the chip's own RAM, or frames.
  const { adpcm, frames } = bakedChipSamples(ir, targetProfile(name));
  p.setAdpcmBank(adpcm);
  p.setFrameBank(frames);
  if (muted) ir.tracks.forEach((_, ti) => p.muteTrack(ti, true));
  const seen = new Map(ir.tracks.map((t, ti) => [ti, { head: t.scoreChannel ?? t.channel, closes: [], retrigs: [], silences: [] }]));
  let base = null;
  const close = p._closeNote.bind(p);
  p._closeNote = (ti, t, h = {}) => {
    if (p._open[ti]) seen.get(ti)?.closes.push([t - base, how(h)]);
    return close(ti, t, h);
  };
  const retrigs = p._noteRetriggers.bind(p);
  p._noteRetriggers = (ti, retrigger, keyOff) => retrigs(ti, (t, closed) => {
    seen.get(ti)?.retrigs.push(t - base);
    return retrigger(t, closed);
  }, keyOff);
  const silence = p._silence.bind(p);
  p._silence = (site, t) => {
    if (p._noteScope) seen.get(p._noteScope.ti)?.silences.push(t - base);
    return silence(site, t);
  };
  // The capture's clock starts its tracks at its BASE (captureRegisterLog).
  const reset = p._resetRunState.bind(p);
  p._resetRunState = () => { reset(); base = p._audioContext?.currentTime ?? 0; };
  p.captureRegisterLog();
  return [...seen.values()];
}

let channels = 0;
for (const name of Object.keys(TARGETS)) {
  for (const [samples, muted] of [[false, false], [false, true], [true, false], [true, true]]) {
    for (const s of run(name, samples, muted)) {
      const at = `${name} ${s.head}${muted ? " (muted)" : ""}`;
      assert.equal(s.closes.length, CLOSES.length, `${at}: its notes close ${CLOSES.length} times: ${JSON.stringify(s.closes)}`);
      s.closes.forEach(([t, h], i) => {
        assert.ok(near(t, CLOSES[i][0]), `${at}: close ${i + 1} at ${CLOSES[i][0]} s, not ${t.toFixed(4)}`);
        assert.equal(h, CLOSES[i][1], `${at}: close ${i + 1} by "${CLOSES[i][1]}", not "${h}"`);
      });
      if (muted) {
        assert.deepEqual(s.retrigs, [], `${at}: a muted note retriggers nothing`);
        assert.equal(s.silences.length, NOTES.length, `${at}: each of its notes silences its voice`);
        s.silences.forEach((t, i) => assert.ok(near(t, NOTES[i]), `${at}: silence ${i + 1} at ${NOTES[i]} s, not ${t.toFixed(4)}`));
      } else {
        // (a MIDI channel's sound is the output's: its notes have no voice to retrigger)
        const want = name === "midi" ? [] : RETRIGS;
        assert.equal(s.retrigs.length, want.length, `${at}: ${want.length} retriggers: ${JSON.stringify(s.retrigs)}`);
        s.retrigs.forEach((t, i) => assert.ok(near(t, want[i]), `${at}: retrigger ${i + 1} at ${want[i]} s, not ${t.toFixed(4)}`));
        assert.deepEqual(s.silences, [], `${at}: a heard note silences nothing`);
      }
      if (!muted) channels++;
    }
  }
}
console.log(`check:note-path ok — ${channels} channels on ${Object.keys(TARGETS).length} machines close, retrigger and mute by one path`);

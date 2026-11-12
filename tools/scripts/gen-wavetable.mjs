#!/usr/bin/env node
// presets/wavetable/set.mmlisp, computed: every wave here is a formula, a sum
// of sines or a shape, so where it came from is on record and a change to one
// is a change to its numbers. No wave is taken from a chip's or a game's data.
// A role is a macro over them (wave-piano), which is what a score names.
//
//   node scripts/gen-wavetable.mjs           write the set
//   node scripts/gen-wavetable.mjs --check   fail if it is not what this writes

import { readFileSync, writeFileSync } from "node:fs";
import { formatMMLisp } from "../../live/src/lang/mmlisp-formatter.js";
import { parse } from "../../live/src/lang/mmlisp-parser.js";

const N = 32;
const TAU = Math.PI * 2;
const clip = (v) => Math.max(-128, Math.min(127, Math.round(v)));

// Harmonic → level: a sum of sines, brought to full scale.
const additive = (partials) => {
  const raw = Array.from({ length: N }, (_, i) =>
    Object.entries(partials).reduce((sum, [h, a]) => sum + a * Math.sin((TAU * h * i) / N), 0));
  const peak = Math.max(...raw.map(Math.abs));
  return raw.map((v) => clip((127 * v) / peak));
};
const pulse = (high) => Array.from({ length: N }, (_, i) => (i < high ? 127 : -128));

// Named by the roles the ROM voices have (language.md §19), so a score's names
// stay when it moves from an FM channel to a wave channel.
const WAVES = [
  ["sine", "A sine.", additive({ 1: 1 })],
  ["triangle", "A triangle.", Array.from({ length: N }, (_, i) => clip(127 * (1 - Math.abs(((((i + 8) / N) % 1) * 4) - 2))))],
  ["saw", "A saw, up to a drop.", Array.from({ length: N }, (_, i) => clip(-128 + (255 * i) / (N - 1)))],
  ["square", "A square: 1:1.", pulse(16)],
  ["pulse25", "A pulse: 1:3.", pulse(8)],
  ["pulse12", "A pulse: 1:7.", pulse(4)],
  ["organ", "Drawbars: the octaves and the third harmonic.", additive({ 1: 1, 2: 0.7, 3: 0.5, 4: 0.3, 6: 0.2, 8: 0.15 })],
  ["flute", "Nearly a sine, its second harmonic breathy.", additive({ 1: 1, 2: 0.25, 3: 0.1 })],
  ["clarinet", "Odd harmonics, as a closed pipe has.", additive({ 1: 1, 3: 0.75, 5: 0.5, 7: 0.25, 9: 0.12 })],
  ["oboe", "A weak fundamental under a peak at the third.", additive({ 1: 0.4, 2: 0.6, 3: 1, 4: 0.7, 5: 0.4, 6: 0.25 })],
  ["violin", "Saw-like, with a body's rise at the fifth.", additive({ 1: 1, 2: 0.8, 3: 0.7, 4: 0.5, 5: 0.55, 6: 0.35, 7: 0.3, 8: 0.2 })],
  ["trumpet", "A bright peak at the third.", additive({ 1: 0.6, 2: 0.9, 3: 1, 4: 0.8, 5: 0.6, 6: 0.4, 7: 0.25, 8: 0.15 })],
  ["horn", "Round: falling fast from the fundamental.", additive({ 1: 1, 2: 0.6, 3: 0.3, 4: 0.15 })],
  ["piano", "Falling harmonics, as a struck string's first moment.", additive({ 1: 1, 2: 0.5, 3: 0.3, 4: 0.15, 5: 0.1, 6: 0.06 })],
  ["vibraphone", "The fundamental and the bar's fourth harmonic.", additive({ 1: 1, 4: 0.35 })],
  ["synth-bass", "A fat low end: the fundamental and two harmonics.", additive({ 1: 1, 2: 0.8, 3: 0.5 })],
  ["acoustic-bass", "A woody low end, the upper harmonics soon gone.", additive({ 1: 1, 2: 0.5, 3: 0.2 })],
  ["guitar", "A plucked string: falling harmonics, a little nasal.", additive({ 1: 1, 2: 0.7, 3: 0.5, 4: 0.35, 5: 0.2, 7: 0.1 })],
  ["electric-guitar", "Full and even, as a pickup hears a driven string.", additive({ 1: 1, 2: 0.9, 3: 0.8, 4: 0.6, 5: 0.5, 6: 0.35, 7: 0.3 })],
  ["harpsichord", "A peak high up: a plectrum near the string's end.", additive({ 1: 0.6, 2: 0.8, 3: 1, 4: 0.9, 5: 0.7, 6: 0.6, 7: 0.4, 8: 0.3, 9: 0.2 })],
  ["synth", "A lead: a saw's run with its odd harmonics up.", additive({ 1: 1, 2: 0.5, 3: 0.6, 4: 0.25, 5: 0.35, 6: 0.15, 7: 0.2 })],
];

// Each role played: the waves it steps through, a frame a step (`_` holds), and
// its level. Most of what tells one wave from another is here: an attack on
// a brighter wave settling on the role's own, as a wave macro does on the chips.
const ROLES = [
  ["organ", "A click, then steady.", "pulse25 organ", "#sus 0 #rel -5 -10 -15"],
  ["flute", "A soft swell into the breath.", "sine _ _ _ flute", "-6 -4 -2 -1 #sus 0 #rel -4 -8 -12 -15"],
  ["clarinet", "A hollow bite, then the reed.", "square _ clarinet", "-3 -1 #sus 0 #rel -6 -12 -15"],
  ["oboe", "Bright for a moment, then nasal.", "trumpet _ oboe", "-2 -1 #sus 0 #rel -5 -10 -15"],
  ["violin", "A bow: a slow rise from the flute's wave.", "flute _ _ _ _ _ violin", "(linear -8..0 :len 10f) #sus 0 #rel (linear 0..-15 :len 15f)"],
  ["trumpet", "A brass rise, opening as it speaks.", "horn _ _ violin _ trumpet", "-5 -3 -1 #sus 0 #rel -6 -12 -15"],
  ["horn", "A round swell.", "sine _ _ horn", "-6 -4 -3 -2 -1 #sus 0 #rel -4 -8 -12 -15"],
  ["piano", "A bright strike, dying as it is held.", "trumpet _ _ violin _ _ piano", "(ease-out 0..-9 :len 45f) #sus -9 #rel (linear -9..-15 :len 6f)"],
  ["vibraphone", "A struck bar, ringing away to a sine.", "trumpet vibraphone _ _ _ _ _ _ _ _ _ _ sine", "(ease-out 0..-15 :len 90f)"],
  ["synth-bass", "A saw's snap, falling to the fat low end.", "saw _ _ square _ _ synth-bass", "(ease-out 0..-7 :len 18f) #sus -7 #rel -11 -15"],
  ["acoustic-bass", "A thumb on a string: a soft snap and a short ring.", "synth-bass _ _ acoustic-bass", "(ease-out 0..-10 :len 40f) #sus -10 #rel -13 -15"],
  ["guitar", "A pick, then a string dying away.", "saw _ violin _ guitar", "(ease-out 0..-13 :len 60f) #sus -13 #rel -15"],
  ["electric-guitar", "A hard pick into a long sustain.", "square _ electric-guitar", "(ease-out 0..-5 :len 60f) #sus -5 #rel -10 -15"],
  ["harpsichord", "A thin, bright pluck, undamped until let go.", "pulse12 _ harpsichord", "(ease-out 0..-12 :len 40f) #sus -12 #rel -15"],
  ["synth", "A quick edge, then the lead held level.", "pulse25 _ _ synth", "-2 -1 #sus 0 #rel -5 -10 -15"],
];

const head = `; Waves for the wave channels: 32 steps of -128..127, which every machine with
; them takes. Written by tools/scripts/gen-wavetable.mjs, from formulas; change
; them there. See README.md.
`;
const text = formatMMLisp([head, ...ROLES.map(([name, about, waves, level]) =>
  `; ${about}\n(def wave-${name} (macro :wave [${waves}] :vel+ [${level}]))\n`), ...WAVES.map(([name, about, steps]) =>
  `; ${about}\n(def-wave ${name}\n  :wave [\n    ${steps.slice(0, 16).join(" ")}\n    ${steps.slice(16).join(" ")}\n  ]\n)\n`)].join("\n"), parse);

const path = new URL("../../presets/wavetable/set.mmlisp", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== text) {
    console.error("presets/wavetable/set.mmlisp is not what gen-wavetable.mjs writes");
    process.exit(1);
  }
  console.log(`wavetable: ${WAVES.length} waves, ${ROLES.length} roles as generated`);
} else {
  writeFileSync(path, text);
  console.log(`wrote ${WAVES.length} waves, ${ROLES.length} roles`);
}

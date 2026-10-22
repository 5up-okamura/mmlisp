// ---------------------------------------------------------------------------
// Target profiles: what one machine's sound hardware is, for the toolchain.
//
// Three layers (docs/language.md §19):
//   parts   chips/parts.js — one kind of sound and the language it brings:
//           its words, its :mode symbols, its rules
//   chips   chips/ym2612.js … — a clock, the parts, the encoders, the VGM
//           header block
//   targets targets/md.js … — the chips, the channel table (score name →
//           chip, part, physical voice), and the readings of another
//           machine's words
//
// The compiler asks a target three things: what part a channel is, whether
// a word is the machine's, and what the parts' rules say. The Mega Drive
// (`md`) is the default and the only target with a driver of its own
// (MMLispDRV); the others are delivered as VGM (docs/roadmap.md).
// ---------------------------------------------------------------------------

import md from "./targets/md.js";
import pc88 from "./targets/pc88.js";

function profile(def) {
  const heads = Object.keys(def.channels);
  const parts = [...new Set(heads.map((h) => def.channels[h].part))];
  return {
    ...def,
    channelNames: heads,
    parts,
    // A target previews when the IR player has every one of its chips.
    preview: Object.values(def.chips).every((c) => c.preview),
    partOf: (head) => def.channels[head]?.part ?? null,
    chipOf: (head) => def.chips[def.channels[head]?.chip] ?? null,
    headsOf: (partName) => heads.filter((h) => def.channels[h].part.name === partName),
    hasPart: (partName) => parts.some((p) => p.name === partName),
    /** The physical voice `head` plays on, as a key two heads can be compared by. */
    voiceKey(head) {
      const c = def.channels[head];
      return c ? `${c.chip}:${c.part.unit ?? c.part.name}:${c.voice}` : null;
    },
    hasWord: (word) => parts.some((p) => p.words(word) || p.songWords?.(word)),
    /** The chip whose part `partName` is, or null: its clock and encoders. */
    chipFor(partName) {
      const head = heads.find((h) => def.channels[h].part.name === partName);
      return head ? def.chips[def.channels[head].chip] : null;
    },
  };
}

export const TARGETS = { md: profile(md), pc88: profile(pc88) };
export const DEFAULT_TARGET = "md";

/** The profile for `name` (a score's `:target`), or the Mega Drive's. */
export function targetProfile(name) {
  return TARGETS[name ?? DEFAULT_TARGET] ?? TARGETS[DEFAULT_TARGET];
}

// Every part some target has: a word one of them claims is a target's own,
// and a target without it does not have the word.
const ALL_PARTS = [...new Set(Object.values(TARGETS).flatMap((t) => t.parts))];

/** The parts that claim `word`, or [] when it is the portable core's. */
export function partsWithWord(word) {
  return ALL_PARTS.filter((p) => p.words(word) || p.songWords?.(word));
}

/** Every channel name some target has. */
export const ALL_CHANNEL_NAMES = new Set(Object.values(TARGETS).flatMap((t) => t.channelNames));

/** What a diagnostic calls the parts that read a def-score `key`. */
export function partsWithSetting(key) {
  return [...new Set(ALL_PARTS.filter((p) => p.settings?.includes(key)).map((p) => p.label))].join(" / ");
}

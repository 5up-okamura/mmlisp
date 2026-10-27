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
import x68k from "./targets/x68k.js";
import msx from "./targets/msx.js";
import pce from "./targets/pce.js";
import fc from "./targets/fc.js";

const SCOPE_BASE = { fm: 0, tone: 6, noise: 6, sample: 10, wave: 10 };

function profile(def) {
  // A register write names its chip by the worklet's port (chips/ `vgm.ports`:
  // the YM's 0 and 1, the SN76489's 2 …): two chips of one target on one port
  // would play each other's writes.
  const portOwner = new Map();
  for (const chip of Object.values(def.chips))
    for (const port of Object.keys(chip.vgm?.ports ?? {})) {
      if (portOwner.has(port))
        throw new Error(`targets/${def.name}: the ${portOwner.get(port)} and the ${chip.chip} both write port ${port}`);
      portOwner.set(port, chip.chip);
    }
  const heads = Object.keys(def.channels);
  const parts = [...new Set(heads.map((h) => def.channels[h].part))];
  return {
    ...def,
    channelNames: heads,
    parts,
    // How far the toolchain has the target: every chip encoded (the register
    // log, the VGM), every chip emulated (Play, the WAV).
    encodes: Object.values(def.chips).every((c) => c.encoder),
    plays: Object.values(def.chips).every((c) => c.encoder && c.emulator),
    partOf: (head) => def.channels[head]?.part ?? null,
    chipOf: (head) => def.chips[def.channels[head]?.chip] ?? null,
    headsOf: (partName) => heads.filter((h) => def.channels[h].part.name === partName),
    headsOfKind: (kind) => heads.filter((h) => def.channels[h].part.kind === kind),
    hasPart: (partName) => parts.some((p) => p.name === partName),
    /** The physical voice `head` plays on, as a key two heads can be compared by. */
    voiceKey(head) {
      const c = def.channels[head];
      return c ? `${c.chip}:${c.part.unit ?? c.part.name}:${c.voice}` : null;
    },
    hasWord: (word) => parts.some((p) => p.words(word) || p.songWords?.(word)),
    /**
     * The oscilloscope lane `head` sounds on, in the synths' layout
     * (synth-*.js SCOPE_LANES): FM channel n at n, the PSG's channel n at
     * 6 + n, sample voice n (or wave channel n) at 10 + n — or the channel table's `scope` where
     * a synth puts it elsewhere. A part of several sounds (the ROM rhythm)
     * has its first sound's lane, the rest after it.
     */
    scopeLane(head) {
      const c = def.channels[head];
      if (!c) return null;
      return c.scope ?? SCOPE_BASE[c.part.kind] + c.voice;
    },
    /** The chip of the first part of `kind` (fm, tone, noise, sample), or null. */
    chipForKind(kind) {
      const head = heads.find((h) => def.channels[h].part.kind === kind);
      return head ? def.chips[def.channels[head].chip] : null;
    },
    /** The chip whose part `partName` is, or null: its clock and encoders. */
    chipFor(partName) {
      const head = heads.find((h) => def.channels[h].part.name === partName);
      return head ? def.chips[def.channels[head].chip] : null;
    },
  };
}

export const TARGETS = { md: profile(md), pc88: profile(pc88), x68k: profile(x68k), msx: profile(msx), pce: profile(pce), fc: profile(fc) };
export const DEFAULT_TARGET = "md";

/** Why `target` cannot `play` or `encode` yet, or null when it can. */
export function notYet(target, what) {
  if (what === "play" ? target.plays : target.encodes) return null;
  const missing = Object.values(target.chips)
    .filter((c) => !c.encoder || (what === "play" && !c.emulator))
    .map((c) => `the ${c.chip.toUpperCase()}'s ${c.encoder ? "emulator" : "register encoder"}`);
  return `the ${target.system} (:target ${target.name}) compiles, but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not built yet`;
}

// The tone lanes: the IR player's (and the page's) channels with a pitch
// and a level and nothing else to them — the PSG's three tones at 0-2, its
// noise at 3 (the SSG's is a tone channel's mixer, the encoder's to map),
// the wave channels from 4 — or where the part puts its channel
// (`toneLane`: the PC Engine's two pitched noises, after its waves).
const TONE_LANE_BASE = { tone: 0, noise: 3, wave: 4 };

/** The tone lane of a channel table entry, or null for a part with none (FM, a sample). */
export function toneLaneOf(c) {
  if (c?.part.toneLane) return c.part.toneLane(c);
  const base = TONE_LANE_BASE[c?.part.kind];
  return base == null ? null : c.part.kind === "noise" ? base : base + c.voice;
}

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

/** How many tone lanes the most of any target has: the PSG's four at least. */
export const TONE_LANES = Math.max(4, ...Object.values(TARGETS).flatMap((t) =>
  Object.values(t.channels).map((c) => (toneLaneOf(c) ?? -1) + 1)));

/** Every channel name some target has. */
export const ALL_CHANNEL_NAMES = new Set(Object.values(TARGETS).flatMap((t) => t.channelNames));

/** What a diagnostic calls the parts that read a def-score `key`. */
export function partsWithSetting(key) {
  return [...new Set(ALL_PARTS.filter((p) => p.settings?.includes(key)).map((p) => p.label))].join(" / ");
}

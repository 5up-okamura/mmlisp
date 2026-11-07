// File > New: an empty score for a target, read off its channel table — every
// track it plays on, each a loop to write into, and the preset sets its parts
// can sound. Names that only say another way of playing a channel are listed in
// a comment, so a new machine needs nothing here.
import { TARGETS, assetMark, builtinNames } from "./targets.js";

const TEMPO = 120;
const track = (head, opening) => `(${[head, ...opening].join(" ")}\n  #top\n  (go top)\n)`;

// A kit's track starts on a sound of its own, in the kit's order: the chip's, so
// nothing to import, and a note there would otherwise need a name first.
function soundOf(target, head) {
  const part = target.partOf(head);
  return part.kit ? [Object.keys(part.kit)[target.headsOf(part.name).indexOf(head)]] : [];
}

// What `target`'s channels are to a new score: `tracks` written out, `dac` the
// channels a sample part takes over (`claims`), `voices` that part's voices past
// the first, which a track makes the song's (it writes the first), `others` the
// names of a physical channel already written or a kit takes (a score may have
// only one of them; a kit's sounds are its own tracks), `carts` the expansion chips of a
// target that lists them.
function channelsOf(target) {
  const parts = target.channelNames.map((head) => ({ head, ...target.channels[head] }));
  const claimed = parts.filter((p) => p.part.claims).map((p) => p.part.claims);
  const takenOver = (p) => claimed.some((c) => c.kind === p.part.kind && c.voice === p.voice);
  const cart = (p) => target.listsExpansions && target.chips[p.chip].optional;
  const shared = (p) => (seen.has(target.voiceKey(p.head)) && !p.part.kit) || target.parts.some((part) => part.takes?.(p));
  const tracks = [], dac = [], voices = [], others = [], carts = new Map(), seen = new Set();
  for (const p of parts) {
    if (takenOver(p)) dac.push(p.head);
    else if (p.part.claims && p.voice > 0) voices.push(p.head);
    else if (shared(p)) others.push(p.head);
    else if (cart(p)) carts.set(p.chip, [...(carts.get(p.chip) ?? []), p.head]);
    else {
      seen.add(target.voiceKey(p.head));
      tracks.push(p.head);
    }
  }
  return { tracks, dac, voices, others, carts };
}

// The preset sets the machine plays whole, where a written track can play them:
// imported, not assigned, so completion offers their names; only what a track
// plays is baked, so they cost the song nothing. rx5 has every role a ROM
// rhythm's track starts on, so it stands in until the user brings the ROM.
function importsOf(target, tracks) {
  const written = (kind) => tracks.some((h) => target.partOf(h).kind === kind && !target.partOf(h).kit);
  return [["fm", "gm", "fm"], ["fm", "fm-roles", "fm"], ["fm", "waveforms", "fm"], ["wave", "wavetable", "wave"], ["pcm", "rx5", "sample"]]
    .filter(([asset, , kind]) => assetMark(target, asset) === null && written(kind))
    .map(([, set]) => `(import "presets/${set}/set.mmlisp")`);
}

/**
 * One line of what the machine named `name` has, for File > New's list: its
 * parts and how many channels of each, by the parts' labels (less the
 * machine's name, and a part's qualifier in parentheses), the cartridges
 * after a `+` by their chips. A part played on channels an earlier part has
 * is another mode of them, in parentheses after it: `wave ×6 (noise, DDA)`
 * is six channels. `OPN FM ×6 · SN76489 tone ×3 · SN76489 noise · DAC ×3`;
 * a kit's sounds are its channels.
 */
export function machineSummary(name) {
  const target = TARGETS[name];
  const labelOf = (part) => {
    const own = part.label.startsWith(`${target.system} `) ? part.label.slice(target.system.length + 1) : part.label;
    return own.replace(/ \(.*\)$/, "");
  };
  const parts = new Map(), owner = new Map(), carts = []; // label → { n, modes }; voice key → label
  for (const part of target.parts) {
    const heads = target.headsOf(part.name);
    const chip = target.channels[heads[0]].chip;
    if (target.chips[chip].optional) {
      if (!carts.includes(chip)) carts.push(chip);
      continue;
    }
    const label = labelOf(part);
    const keys = [...new Set(heads.map((h) => target.voiceKey(h)))];
    const host = part.kit ? null : owner.get(keys[0]);
    if (host && host !== label && keys.every((k) => owner.has(k))) {
      const modes = parts.get(host).modes;
      const chip = `${host.split(" ")[0]} `; // SSG tone's SSG noise is its noise
      const mode = label.startsWith(chip) ? label.slice(chip.length) : label;
      if (!modes.includes(mode)) modes.push(mode);
      continue;
    }
    const at = parts.get(label) ?? { n: 0, modes: [] };
    at.n += part.kit ? heads.length : keys.length;
    parts.set(label, at);
    for (const k of keys) if (!owner.has(k)) owner.set(k, label);
  }
  const own = [...parts].map(([label, { n, modes }]) =>
    `${n > 1 ? `${label} ×${n}` : label}${modes.length ? ` (${modes.join(", ")})` : ""}`).join(" · ");
  return carts.length ? `${own} + ${carts.map((c) => c.toUpperCase()).join(", ")}` : own;
}

/** The source of an empty score for the target named `name`. */
export function newScoreSource(name) {
  const target = TARGETS[name];
  const { tracks, dac, voices, others, carts } = channelsOf(target);
  const imports = importsOf(target, tracks);
  // The OPLL's voices read as 4-op are a stand-in: the score imports fm-roles
  // over them (importsOf), so the comment does not call them the machine's.
  // A MIDI channel's 128 programs are said in one line, not named one by one.
  const builtin = builtinNames(target).filter((d) => d.from !== "ROM 4-op" && d.from !== "GM").map((d) => d.name);
  return [
    ...(imports.length ? ["; Preset voices, samples and waves: Tools > Library (⌘K) auditions them; typing a name offers it.", ...imports, ""] : []),
    `(def-score :title "" :composer "" :author "" :target ${name})`,
    "",
    tracks.map((head, i) => track(head, [...soundOf(target, head), ...(i === 0 ? [`:tempo ${TEMPO}`] : [])])).join("\n"),
    ...(dac.length || others.length || carts.size || builtin.length ? [""] : []),
    ...(builtin.length ? [`; Built in, no import: ${builtin.join(" ")}`] : []),
    ...(builtinNames(target).some((d) => d.from === "GM") ? ["; Built in too: the GM programs by name (gm-piano … gm-gunshot) and the roles (piano, flute …); :program N for any"] : []),
    ...(dac.length ? [`; ${dac.join(", ")} is the DAC while the score plays PCM${voices.length ? `; more voices: ${voices.join(" ")}` : ""}`] : []),
    ...(others.length ? [`; Sharing a channel with a track above: ${others.join(" ")}`] : []),
    ...[...carts.values()].map((heads) => `; Cartridge, on when a track is named: ${heads.join(" ")}`),
    "",
  ].join("\n");
}

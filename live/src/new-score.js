// File > New: an empty score for a target, read off its channel table — every
// track it plays on, each a loop to write into, and the preset sets its parts
// can sound. Names that only say another way of playing a channel are listed in
// a comment, so a new machine needs nothing here.
import { TARGETS, assetMark } from "./targets.js";

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
  return [["fm", "gm", "fm"], ["fm", "waveforms", "fm"], ["wave", "wavetable", "wave"], ["pcm", "rx5", "sample"]]
    .filter(([asset, , kind]) => assetMark(target, asset) === null && written(kind))
    .map(([, set]) => `(import "presets/${set}/set.mmlisp")`);
}

/** The source of an empty score for the target named `name`. */
export function newScoreSource(name) {
  const target = TARGETS[name];
  const { tracks, dac, voices, others, carts } = channelsOf(target);
  const imports = importsOf(target, tracks);
  return [
    ...(imports.length ? ["; Preset voices and samples: Tools > Library (⌘K) auditions them; typing a name offers it.", ...imports, ""] : []),
    `(def-score :title "" :composer "" :author "" :target ${name})`,
    "",
    tracks.map((head, i) => track(head, [...soundOf(target, head), ...(i === 0 ? [`:tempo ${TEMPO}`] : [])])).join("\n"),
    ...(dac.length || others.length || carts.size ? [""] : []),
    ...(dac.length ? [`; ${dac.join(", ")} is the DAC while the score plays PCM${voices.length ? `; more voices: ${voices.join(" ")}` : ""}`] : []),
    ...(others.length ? [`; Sharing a channel with a track above: ${others.join(" ")}`] : []),
    ...[...carts.values()].map((heads) => `; Cartridge, on when a track is named: ${heads.join(" ")}`),
    "",
  ].join("\n");
}

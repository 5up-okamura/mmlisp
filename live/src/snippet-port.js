// A snippet on the score's machine. Snippets are written for the Mega Drive's
// channel names; this rewrites a snippet's tracks onto another target's
// channel table — the way File > New reads a machine off its table — so the
// Library can play, insert and open it there. Whether the result is any good
// is the compiler's to say: a port is offered on a machine when it compiles
// clean there (tools `npm run gen:snippet-targets`).
//
// A track keeps its KIND of sound (an FM part stays on FM, a sample on a
// sample channel) when the kind is what the snippet shows: a voice, an
// operator's TL, a noise mode, a loop point. When it only shows the language —
// a tuplet, a def, a delay, a curve — any melodic channel will do, and the
// snippet's mode says so (PORT_MODE). Noise and sample tracks keep their kind
// either way: a drum is a drum.
import { parse } from "./mmlisp-parser.js";
import { TARGETS } from "./targets.js";
import { channelForms } from "./edit-tools.js";

const SOURCE = TARGETS.md;
const MELODIC = ["fm", "tone", "wave"];

// The snippets whose kind of sound is the point. Everything else shows the
// language and plays on any melodic channel. Listed, not guessed.
const KIND_DIRS = new Set(["voices", "fm3-csm"]);
const KIND_FILES = new Set([
  "effects/rotary", "effects/room", "effects/sub-octave",
  "curves/easing-filter", "noise-curves/perlin-timbre",
  "techniques/noise-drums", "techniques/noise-bass", "techniques/value-machine",
]);

/** 'kind' (keep each track's kind of sound) or 'any' (any melodic channel). */
export function portMode(path) {
  const rel = String(path).replace(/^snippets\//, "").replace(/\.mmlisp$/, "");
  return KIND_DIRS.has(rel.split("/")[0]) || KIND_FILES.has(rel) ? "kind" : "any";
}

// A channel that plays a physical voice an earlier channel already names —
// another way of playing it, as File > New reads the table (new-score.js).
function isAlias(target, head) {
  const key = target.voiceKey(head);
  return target.channelNames.slice(0, target.channelNames.indexOf(head)).some((h) => target.voiceKey(h) === key);
}

// A target's channels of one kind that a written track can take, its own
// chips before a cartridge's: a kit's sounds are not tracks to write into,
// nor is another way of playing a channel.
function candidates(target, kind) {
  const heads = target.headsOfKind(kind).filter((h) => !target.partOf(h).kit && !isAlias(target, h));
  const optional = (h) => !!target.chipOf(h)?.optional;
  return [...heads.filter((h) => !optional(h)), ...heads.filter(optional)];
}

// A head's place in the source machine's order of its kind: fm1 is FM's
// first, sqr3 tone's third.
const indexOf = (head, kind) => candidates(SOURCE, kind).indexOf(head);

/**
 * The snippet's text on `targetName`.
 * @param {string} text  the snippet, Mega Drive channel names
 * @param {string} targetName
 * @param {'kind'|'any'} mode
 * @param {Set<string>} fmVoices  FM voice names the snippet can see (its own and its imports')
 * @param {Map<string,string>} [imports]  its imports' texts: one left unused is taken out
 * @returns {{text: string, map: Record<string,string>, dropped: string[]} | {error: string}}
 */
export function portSnippet(text, targetName, mode = "any", fmVoices = new Set(), imports = null) {
  const target = TARGETS[targetName];
  if (!target) return { error: `no machine ${targetName}` };
  let forms;
  try {
    forms = channelForms(text);
  } catch (e) {
    return { error: `the snippet does not parse: ${e.message}` };
  }
  // A snippet that names its machine is that machine's.
  const own = /\(def-score[^)]*:target\s+(\w+)/.exec(text)?.[1];
  if (own) return own === targetName ? { text, map: {}, dropped: [] } : { error: `written for ${own}` };

  const heads = [...new Set(forms.map((f) => f.channel))];
  const map = {};
  const taken = new Set();
  // First the heads the target has as they are, of the same kind: fm1 stays
  // fm1 on every machine with an fm1, so the port changes only what it must.
  for (const h of heads) {
    const kind = SOURCE.partOf(h)?.kind;
    if (target.partOf(h)?.kind === kind && !target.partOf(h).kit) {
      map[h] = h;
      taken.add(h);
    }
  }
  // Then the rest, in their order: the same kind first, then — when the
  // snippet does not care — another melodic kind.
  const rest = heads.filter((h) => !(h in map))
    .sort((a, b) => indexOf(a, SOURCE.partOf(a).kind) - indexOf(b, SOURCE.partOf(b).kind));
  for (const h of rest) {
    const kind = SOURCE.partOf(h)?.kind;
    if (!kind) return { error: `${h} is not a channel` };
    // A channel that is another way of playing one (fm3-1 … fm3-csm: FM3's
    // operators, CSM) is that machine's; it ports only where it exists.
    if (isAlias(SOURCE, h)) return { error: `${h} is the ${SOURCE.system}'s own` };
    const kinds = mode === "any" && MELODIC.includes(kind) ? [kind, ...MELODIC.filter((k) => k !== kind)] : [kind];
    const free = kinds.flatMap((k) => candidates(target, k)).find((c) => !taken.has(c));
    if (!free) return { error: `${target.system} has no channel for ${h}` };
    map[h] = free;
    taken.add(free);
  }

  // Rewrite each form's head; on a track moved off FM, take out the FM
  // voices it names — the voice was for the sound, not for what the snippet
  // shows, and the channel it plays on now cannot sound one.
  const changes = [];
  const dropped = new Set();
  for (const f of forms) {
    const to = map[f.channel];
    if (to !== f.channel) {
      const headFrom = f.from + 1;
      changes.push({ from: headFrom, to: headFrom + f.channel.length, insert: to });
    }
    if (target.partOf(to).kind === "fm" || SOURCE.partOf(f.channel).kind !== "fm") continue;
    const walk = (it) => {
      if (it.node.kind === "atom" && fmVoices.has(it.node.value)) {
        dropped.add(it.node.value);
        // The voice and the space after it — or before it, at a line's end.
        const after = /[ \t]/.test(text[it.to] ?? "");
        const from = !after && /[ \t]/.test(text[it.from - 1] ?? "") ? it.from - 1 : it.from;
        changes.push({ from, to: after ? it.to + 1 : it.to, insert: "" });
      }
    };
    f.items.forEach(walk);
  }
  changes.sort((a, b) => a.from - b.from);
  let out = "";
  let at = 0;
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  out += text.slice(at);
  out = ownModes(out, target);
  if (dropped.size && imports) out = pruneImports(out, imports);
  return { text: out, map, dropped: [...dropped] };
}

// A Mega Drive mode the target reads as its own words (pc88's SSG takes
// `:mode white0` as `:noise-rate 9`) is written in them: the port reads as
// that machine's score, and compiles without the reading's warning. A mode
// with no reading, or one inside a macro's steps, stays for the compiler to say.
function ownModes(text, target) {
  for (const readings of Object.values(target.readsAs?.modes ?? {}))
    for (const [sym, r] of Object.entries(readings))
      if (r.write) text = text.replace(new RegExp(`:mode\\s+${sym}(?![\\w-])`, "g"), r.as);
  return text;
}

// An (import "…") nothing in the text names any more — the voices it was for
// left out above — goes too. `imports`: path → text, as the compiler reads them.
function pruneImports(text, imports) {
  const used = new Set();
  const walk = (n) => {
    if (n?.kind === "atom") used.add(n.value);
    if (n?.kind === "list") n.items.forEach(walk);
  };
  let roots;
  try { roots = parse(text); } catch { return text; }
  roots.filter((n) => !(n?.kind === "list" && n.items[0]?.value === "import")).forEach(walk);
  return text.replace(/^[ \t]*\(import\s+"([^"]+)"[^)\n]*\)[ \t]*\n?/gm, (line, path) => {
    const src = imports.get(path) ?? [...imports].find(([k]) => k.endsWith(path))?.[1];
    if (src == null) return line;
    let defs;
    try { defs = parse(src).filter((n) => n?.kind === "list" && /^def/.test(n.items[0]?.value ?? "")); } catch { return line; }
    return defs.some((n) => used.has(n.items[1]?.value)) ? line : "";
  });
}

/** The FM voice names texts define: def-fm, the score's own and its imports'. */
export function fmVoiceNames(texts) {
  const names = new Set();
  for (const t of texts) {
    let roots;
    try { roots = parse(t); } catch { continue; }
    for (const n of roots)
      if (n?.kind === "list" && n.items[0]?.value === "def-fm" && typeof n.items[1]?.value === "string") names.add(n.items[1].value);
  }
  return names;
}

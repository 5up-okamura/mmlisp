// A score's defs collected: def-score, def-se, a sample def and its
// effects and extends, every other def by its head.

import { SAMPLE_EFFECTS } from "../../audio/sample-fx.js";
import { CURVE_NAMES, LOOP_CURVE_NAMES, readConstNumber } from "./curves.js";
import { pushDiag, nodeSrc, describeNodeToken, atomValue, parseIntLike } from "./diag.js";
import { isLanguageKeyword } from "./keywords.js";
import { lengthTokenSeconds, parseRangeToken, rejectNoteName } from "./length.js";
import { isReservedHead } from "../mmlisp-eval.js";
import { TARGETS } from "../../machine/targets.js";

// `:fx [(name …) (name …)]` → the IR's resolved chain (docs/ir.md §2.2):
// `{type, …params}` with every param filled in, times in seconds (at the
// score's opening tempo, like the range points) and levels in dB. The table
// the params are checked against is sample-fx.js's, the same one that runs
// them.
export function resolveSampleEffects(node, bpm, diagnostics, src) {
  const err = (code, msg, at) =>
    pushDiag(diagnostics, "error", code, `def-pcm :fx ${msg}`, at ? nodeSrc(at) : src, "global");
  if (node?.kind !== "list" || node.bracket !== "[]") {
    err("E_SAMPLE_FX", `takes a [...] of effects, got ${describeNodeToken(node)}`, node);
    return [];
  }
  const chain = [];
  for (const item of node.items) {
    if (item.kind === "comment") continue;
    const items = item.kind === "list" ? item.items.filter((n) => n.kind !== "comment") : null;
    const type = items && item.bracket === "()" ? atomValue(items[0]) : null;
    const spec = type ? SAMPLE_EFFECTS[type] : null;
    if (!spec) {
      err("E_SAMPLE_FX_UNKNOWN",
        `has no effect ${describeNodeToken(item)} (known: ${Object.keys(SAMPLE_EFFECTS).join(", ")})`, item);
      continue;
    }
    const raw = {};
    let k = 1;
    if (spec.pos && k < items.length && !atomValue(items[k])?.startsWith(":")) {
      raw[spec.pos] = items[k++];
    }
    for (; k < items.length; k += 2) {
      const key = atomValue(items[k]);
      const name = key?.startsWith(":") ? key.slice(1) : null;
      if (!name || !spec.params[name]) {
        err("E_SAMPLE_FX_PARAM", `(${type}) has no parameter ${describeNodeToken(items[k])}`, items[k]);
        continue;
      }
      if (k + 1 >= items.length) {
        err("E_SAMPLE_FX_PARAM", `(${type}) ${key} has no value`, items[k]);
        continue;
      }
      raw[name] = items[k + 1];
    }
    const fx = { type };
    let ok = true;
    for (const [name, p] of Object.entries(spec.params)) {
      const at = raw[name];
      if (at === undefined) {
        if (p.required) {
          err("E_SAMPLE_FX_PARAM", `(${type}) needs :${name}`, item);
          ok = false;
        } else fx[name] = p.def;
        continue;
      }
      const tok = atomValue(at);
      let v = null;
      if (p.kind === "time") {
        v = lengthTokenSeconds(tok, bpm);
        // Only a span has to be positive (`positive`); an attack, a release or
        // an :at of 0 is instant / the start.
        if (v !== null && !(v > 0) && p.positive) v = null;
      } else if (p.kind === "curve") {
        v = CURVE_NAMES.has(tok) && !LOOP_CURVE_NAMES.has(tok) ? tok : null;
      } else {
        const n = typeof tok === "string" && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok) ? Number(tok) : null;
        v = n !== null && (p.kind !== "int" || Number.isInteger(n)) ? n : null;
        if (v !== null && ((p.min != null && v < p.min) || (p.max != null && v > p.max))) v = null;
      }
      if (v === null) {
        const want = p.kind === "time" ? (p.positive ? "a length > 0" : "a length")
          : p.kind === "curve" ? "a one-shot curve name (linear, ease-…)"
          : `${p.kind === "int" ? "an integer" : "a number"}` +
            (p.min != null && p.max != null ? ` ${p.min}..${p.max}`
              : p.min != null ? ` >= ${p.min}` : p.max != null ? ` <= ${p.max}` : "");
        err("E_SAMPLE_FX_PARAM", `(${type}) :${name} must be ${want}, got ${describeNodeToken(at)}`, at);
        ok = false;
        continue;
      }
      fx[name] = v;
    }
    if (ok) chain.push(fx);
  }
  return chain;
}

// A def-pcm's `:key value …` body. `base` is the sample it extends: the
// child takes the base's file (still read from the base's folder), slice,
// loop and effects and overrides the keys it writes (resolveSampleExtends).
export function parseSampleDef(bodyItems, base, diagnostics, src) {
  const sample = {
    extends: base,
    file: null,
    rate: null,
    offset: null,
    frames: null,
    startTok: null,
    endTok: null,
    lenTok: null,
    startSec: null,
    endSec: null,
    loopStartTok: null,
    loopEndTok: null,
    loopLenTok: null,
    loopStartSec: null,
    loopEndSec: null,
    fxNode: null,
    fx: [],
  };

  for (let ki = 0; ki + 1 < bodyItems.length; ki += 2) {
    const key = atomValue(bodyItems[ki]);
    const rawVal = atomValue(bodyItems[ki + 1]);
    if (key === ":fx") {
      // Resolved with the range points, once the score's opening tempo is known
      // (a fade `:len 8` is a musical length).
      sample.fxNode = bodyItems[ki + 1];
      continue;
    }
    if (key === ":file") {
      sample.file = rawVal;
    } else if (key === ":rate" || key === ":offset" || key === ":frames") {
      // Whole numbers: a rate in Hz, a frame position and a frame count. One
      // that does not read leaves the key at its default — say so.
      const n = parseIntLike(rawVal);
      if (n !== null && key === ":rate" && n <= 0)
        pushDiag(diagnostics, "warning", "W_SAMPLE_KEY_INVALID",
          `def-pcm :rate takes a rate in Hz above 0, not ${n}; the file's own rate is kept`,
          nodeSrc(bodyItems[ki + 1]) ?? src, null);
      else if (n !== null) sample[key.slice(1)] = n;
      else
        pushDiag(diagnostics, "warning", "W_SAMPLE_KEY_INVALID",
          `def-pcm ${key} takes a whole number, not ${rawVal ?? "a list"}; the default is kept`,
          nodeSrc(bodyItems[ki + 1]) ?? src, null);
    } else if (key === ":pcm-start") {
      sample.startTok = rawVal;
    } else if (key === ":pcm-end") {
      sample.endTok = rawVal;
      sample.lenTok = null; // the two spell one bound; the last one wins
    } else if (key === ":pcm-len") {
      sample.lenTok = rawVal;
      sample.endTok = null;
    } else if (key === ":loop-start") {
      sample.loopStartTok = rawVal;
    } else if (key === ":loop-end") {
      sample.loopEndTok = rawVal;
      sample.loopLenTok = null;
    } else if (key === ":loop-len") {
      sample.loopLenTok = rawVal;
      sample.loopEndTok = null;
    } else {
      // A key the def does not have would otherwise drop out silently.
      pushDiag(diagnostics, "error", "E_UNKNOWN_KEYWORD",
        `def-pcm has no key ${key}`, nodeSrc(bodyItems[ki]) ?? src, null);
    }
  }

  if (!sample.file && !base) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_FILE",
      "def-pcm needs :file, or a base sample to extend",
      src,
      null,
    );
  }

  // :offset / :frames slice one file into many samples (a bank). Frames, not
  // bytes — like :pcm-start/:pcm-end, which stay relative to the slice.
  if (sample.offset !== null && sample.offset < 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_SLICE",
      `def-pcm :offset must be >= 0 (got ${sample.offset})`,
      src,
      null,
    );
  }
  if (sample.frames !== null && sample.frames <= 0) {
    pushDiag(
      diagnostics,
      "error",
      "E_SAMPLE_SLICE",
      `def-pcm :frames must be > 0 (got ${sample.frames})`,
      src,
      null,
    );
  }

  return sample;
}

export function collectDefs(roots, diagnostics) {
  const defs = new Map();
  const paramDefs = new Map(); // (def (name param…) body…) parametric snippets
  const typedDefs = new Map();
  const sampleDefs = new Map();
  const waveDefs = new Map();
  // (def-se name [:prio N] [:tempo T] (channel body…)…) — a sound effect: its
  // parts are tracks the host starts by the effect's number, not the song.
  const seDefs = new Map();
  const vals = new Map(); // (def-val name init) runtime value slots
  // (def-score :title "…" :composer "…" :author "…" :pcm-voices N) — the score's settings.
  const fileMeta = { title: null, composer: null, author: null, pcmVoices: null, target: null };
  const imports = []; // (import "path") — [{path, src}]
  const mods = []; // (def-mod …) forms, read once the defs are known (parseModDef)
  const remaining = [];

  for (const root of roots) {
    if (root.kind !== "list" || root.items.length < 2) {
      remaining.push(root);
      continue;
    }
    const head = atomValue(root.items[0]);

    // (import "path") — compile-time merge of another file's defs (§9.2).
    // The host resolves the path to source text (relative to the importing file)
    // before compileMMLisp; here we only record it. Only the string-literal form
    // is an import; anything else keeps flowing to the unknown-form checks.
    if (head === "import") {
      const pathNode = root.items[1];
      if (pathNode?.kind !== "string" || typeof pathNode.value !== "string") {
        pushDiag(
          diagnostics,
          "error",
          "E_IMPORT_PATH",
          "import path must be a string literal, e.g. (import \"voices/brass.mmlisp\")",
          nodeSrc(root),
          null,
        );
        continue;
      }
      const at = root.items.findIndex((n) => atomValue(n) === ":fx");
      // `:over`: this import's defs replace same-named ones from the imports
      // written before it (mergeImportsStrict) instead of conflicting.
      const over = root.items.slice(2).some((n) => atomValue(n) === ":over");
      imports.push({ path: pathNode.value, src: nodeSrc(root), fxNode: at > 1 ? root.items[at + 1] : null, over });
      continue;
    }

    // (def-val name init A..B) — declare a runtime value slot (§8). init is
    // the default; A..B (or :from/:to) are the ends of
    // the live control (the Dynamic Parameters sliders), not a bound on the
    // slot. Slots are indexed in declaration order.
    if (head === "def-val") {
      const name = atomValue(root.items[1]);
      if (!name || name.startsWith("$")) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEFVAL_NAME",
          "def-val name must be a plain symbol (no $ prefix)",
          nodeSrc(root),
          null,
        );
        continue;
      }
      // `:name` writes the slot (§8), so a name the language already spells
      // as a keyword — or the built-in `$time` — would be two things at once.
      if (isLanguageKeyword(name)) {
        pushDiag(diagnostics, "error", "E_DEFVAL_NAME",
          `def-val ${name}: :${name} is already a keyword, so the value could not be written`,
          nodeSrc(root), null);
        continue;
      }
      // Optional positional init (item[2]); absent when options start there
      // (e.g. `(def-val x :from 0 :to -127)`), then init defaults to `from`.
      const initValue = readConstNumber(root.items[2], null, diagnostics, "global", nodeSrc(root));
      if (initValue === undefined) continue;
      const initPos = initValue === null ? null : initValue;
      const initRaw = atomValue(root.items[2]) ?? (initPos === null ? null : String(initPos));
      if ((initPos !== null && !Number.isInteger(initPos)) ||
        (initPos === null && initRaw != null && !initRaw.startsWith(":") && !parseRangeToken(initRaw))) {
        pushDiag(diagnostics, "error", "E_DEFVAL_INIT",
          `def-val ${name}: init must be an integer, not ${initRaw}`, nodeSrc(root), null);
        continue;
      }
      let from;
      let to;
      let step = 1; // slider granularity (control resolution)
      let unit = "frame"; // time unit when this slot feeds :len/:step
      let isPublic = false; // :public — a slider and the host's to write
      let k = initPos === null ? 2 : 3;
      // Positional range sugar: `(def-val amp 24 0..127)` ≡ `:from 0 :to 127`.
      const range = parseRangeToken(atomValue(root.items[k]));
      if (range) {
        from = range.from;
        to = range.to;
        k += 1;
      }
      for (; k < root.items.length; k += 2) {
        const key = atomValue(root.items[k]);
        if (key === ":public") {
          isPublic = true;
          k -= 1; // a flag: no value follows
          continue;
        }
        const raw = atomValue(root.items[k + 1]);
        const bad = (why) => pushDiag(diagnostics, "error", "E_DEFVAL_OPTION",
          `def-val ${name}: ${key} ${raw ?? ""} — ${why}`, nodeSrc(root), null);
        if (key === ":unit") {
          if (raw === "frame" || raw === "tick") unit = raw;
          else bad("must be frame or tick");
          continue;
        }
        if (!new Set([":from", ":to", ":step"]).has(key)) { bad("unknown option"); continue; }
        const v = readConstNumber(root.items[k + 1], null, diagnostics, "global", nodeSrc(root));
        if (v === undefined) continue;
        if (v === null || !Number.isInteger(v)) { bad("must be an integer"); continue; }
        if (key === ":from") from = v;
        else if (key === ":to") to = v;
        else if (key === ":step") { if (v > 0) step = v; else bad("must be > 0"); }
      }
      // `:from`/`:to` are order-free directional endpoints (from = the start,
      // so a slider runs from → to).
      let min;
      let max;
      let reversed = false;
      if (from !== undefined || to !== undefined) {
        const a = from ?? 0;
        const b = to ?? 0;
        min = Math.min(a, b);
        max = Math.max(a, b);
        reversed = a > b;
      } else {
        min = 0;
        max = 127;
      }
      // `:from`/`:to` bound the live slider, not the slot, so `init` is kept
      // as written (§8). An init outside the slider's travel is a score bug —
      // said here, where it was authored, instead of folded in silently at
      // playback. A slot is an i16 on the driver; an init that cannot fit one
      // has no playable meaning.
      const init = initPos ?? from ?? min;
      if (init < -32768 || init > 32767) {
        pushDiag(diagnostics, "error", "E_DEFVAL_INIT",
          `def-val ${name}: init ${init} does not fit a 16-bit value slot`,
          nodeSrc(root), null);
        continue;
      }
      if (init < min || init > max)
        pushDiag(diagnostics, "warning", "W_DEFVAL_INIT_RANGE",
          `def-val ${name}: init ${init} is outside the slider range ${min}..${max}`,
          nodeSrc(root), null);
      if (!vals.has(name))
        vals.set(name, {
          name,
          slot: vals.size,
          init,
          min,
          max,
          step,
          reversed,
          unit,
          public: isPublic,
        });
      continue;
    }

    if (head === "def-mod") {
      mods.push(root);
      continue;
    }

    if (head === "def-score") {
      parseScoreDef(root, fileMeta, diagnostics);
      continue;
    }

    if (head === "def-se") {
      const se = parseSeDef(root, diagnostics);
      if (se) seDefs.set(se.name, se);
      continue;
    }

    // (def-fm name [base] :alg 4 …) / (def-pcm name [base] :file "…" …)
    // — named data, like def-val. A leading name after the def's own is the
    // voice / sample it extends. Voices resolve in resolveVoices, samples in
    // resolveSampleExtends, once every def (imports included) is known.
    if (head === "def-fm" || head === "def-pcm") {
      const items = root.items.filter((n) => n.kind !== "comment");
      const name = atomValue(items[1]);
      if (name && items[1].kind === "atom" && rejectNoteName(head, name, root, diagnostics)) continue;
      if (!name || items[1].kind !== "atom" || isReservedHead(name)) {
        pushDiag(diagnostics, "error", name ? "E_DEF_RESERVED" : "E_DEF_NAME",
          name ? `'${name}' is a reserved eval builtin and cannot be a def name`
            : `${head} name must be a symbol`,
          nodeSrc(root), null);
        continue;
      }
      const baseTok = atomValue(items[2]);
      const base = baseTok && items[2].kind === "atom" && !baseTok.startsWith(":") ? baseTok : null;
      const body = items.slice(base ? 3 : 2);
      if (head === "def-fm")
        typedDefs.set(name, { tag: "voice", extends: base, items: body, src: nodeSrc(root) });
      else
        sampleDefs.set(name, {
          tag: "sample",
          ...parseSampleDef(body, base, diagnostics, nodeSrc(root)),
          src: nodeSrc(root),
        });
      continue;
    }

    // (def-wave name :wave [v …]) — a wavetable channel's wave, named data
    // like a def-fm voice; resolveWaves reads its values once every def is
    // known.
    if (head === "def-wave") {
      const items = root.items.filter((n) => n.kind !== "comment");
      const name = atomValue(items[1]);
      if (name && items[1].kind === "atom" && rejectNoteName(head, name, root, diagnostics)) continue;
      if (!name || items[1].kind !== "atom" || isReservedHead(name) || name.startsWith(":")) {
        pushDiag(diagnostics, "error", name && isReservedHead(name) ? "E_DEF_RESERVED" : "E_DEF_NAME",
          name && isReservedHead(name) ? `'${name}' is a reserved eval builtin and cannot be a def name`
            : `${head} name must be a symbol`,
          nodeSrc(root), null);
        continue;
      }
      waveDefs.set(name, { items: items.slice(2), src: nodeSrc(root) });
      continue;
    }

    if (head === "def") {
      // Parametric snippet def: (def (name param…) body…). Token substitution
      // only — no computation; params shadow note/length tokens inside the body.
      const nameNode = root.items[1];
      if (nameNode?.kind === "list") {
        const sig = nameNode.items.filter((n) => n.kind !== "comment");
        const pname = atomValue(sig[0]);
        if (!pname) {
          pushDiag(
            diagnostics,
            "error",
            "E_DEF_NAME",
            "parametric def name must be a symbol",
            nodeSrc(root),
            null,
          );
          continue;
        }
        if (rejectNoteName(head, pname, root, diagnostics)) continue;
        if (isReservedHead(pname)) {
          pushDiag(
            diagnostics,
            "error",
            "E_DEF_RESERVED",
            `'${pname}' is a reserved eval builtin and cannot be a def name`,
            nodeSrc(root),
            null,
          );
          continue;
        }
        const params = sig
          .slice(1)
          .map((n) => atomValue(n))
          .filter(Boolean);
        const body = root.items.slice(2).filter((n) => n.kind !== "comment");
        paramDefs.set(pname, { params, body, src: nodeSrc(root) });
        continue;
      }
      const name = atomValue(root.items[1]);
      if (!name) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEF_NAME",
          "def name must be a symbol",
          nodeSrc(root),
          null,
        );
        continue;
      }
      if (rejectNoteName(head, name, root, diagnostics)) continue;
      if (isReservedHead(name)) {
        pushDiag(
          diagnostics,
          "error",
          "E_DEF_RESERVED",
          `'${name}' is a reserved eval builtin and cannot be a def name`,
          nodeSrc(root),
          null,
        );
        continue;
      }
      // Anything else is a snippet: expanded where its name is written.
      defs.set(
        name,
        root.items.slice(2).filter((n) => n.kind !== "comment"),
      );
      continue;
    }

    remaining.push(root);
  }

  // `:public` slots first, each group in declaration order: the indices the
  // host writes do not move when the score adds a value of its own.
  const ordered = [...vals.values()].sort((a, b) => b.public - a.public || a.slot - b.slot);
  vals.clear();
  ordered.forEach((v, i) => vals.set(v.name, { ...v, slot: i }));
  if (vals.size > 16)
    pushDiag(diagnostics, "error", "E_DEFVAL_COUNT",
      `${vals.size} def-val slots; the driver holds 16`, null, null);
  return { defs, paramDefs, typedDefs, sampleDefs, waveDefs, seDefs, vals, fileMeta, imports, mods, remaining };
}

// The channels a sound effect may play on — every one a song may but CH3.
const SE_CHANNELS = new Set([
  "fm1", "fm2", "fm4", "fm5", "fm6", "sqr1", "sqr2", "sqr3", "noise",
  "pcm1", "pcm2", "pcm3",
]);
// CH3 is not an effect's: its operator mode and CSM are chip-wide, and the
// song's CH3 parts could not play on under an effect (driver.md §2.5).
const SE_CH3 = new Set(["fm3", "fm3-1", "fm3-2", "fm3-3", "fm3-4", "fm3-csm", "fm3-csm-rate"]);
// What an effect may not write, by IR target: the source keyword to name.
export const SE_FORBIDDEN_TARGETS = { MASTER: ":master", LFO_RATE: ":lfo-rate", LFO_FREQ: ":lfo-freq", LFO_PMD: ":lfo-pmd",
  LFO_AMD: ":lfo-amd", LFO_WAVE: ":lfo-wave", LFO_SYNC: ":lfo-sync", NOISE_RATE: ":noise-rate",
  ENV_RATE: ":env-rate" };

// (def-se name [:prio N] [:tempo T] (channel body…)…). The head options are
// the effect's: :prio its default priority (0-255, the host may pass its
// own), :tempo the clock its parts run on (default 120) — its own, so an
// effect sounds the same in every song. Each part is a channel form, one per
// channel, written on the channel it takes from the song.
// (def-score :title "…" :composer "…" :author "…" :pcm-voices N :target T) — the
// whole score's settings (language.md §1). Several forms combine; a key given
// twice is an error, as is one it does not know.
function parseScoreDef(root, fileMeta, diagnostics) {
  const items = root.items.filter((n) => n.kind !== "comment");
  const err = (msg, at) =>
    pushDiag(diagnostics, "error", "E_SCORE_OPTION", `def-score: ${msg}`, nodeSrc(at ?? root), "global");
  for (let k = 1; k < items.length; k += 2) {
    const key = atomValue(items[k]);
    const v = items[k + 1];
    const field = { ":title": "title", ":composer": "composer", ":author": "author", ":pcm-voices": "pcmVoices",
      ":target": "target" }[key];
    if (!field) {
      err(`unknown option ${key ?? describeNodeToken(items[k])} (takes :title :composer :author :pcm-voices :target)`, items[k]);
      continue;
    }
    if (!v) {
      err(`${key} needs a value`, items[k]);
      continue;
    }
    if (fileMeta[field] !== null) {
      err(`${key} is given twice`, items[k]);
      continue;
    }
    if (field === "pcmVoices") {
      // How many PCM voices the driver plays: it picks the engine image and
      // with it the DAC rate (driver.md §5).
      const r = readConstNumber(v, null, diagnostics, "global", nodeSrc(v));
      const n = r == null || !Number.isInteger(r) ? null : r;
      if (n === null || n < 0 || n > 3)
        pushDiag(diagnostics, "error", "E_PCM_VOICES",
          `def-score :pcm-voices takes 0-3 (got ${atomValue(v) ?? "a list"})`, nodeSrc(v), "global");
      else fileMeta.pcmVoices = n;
    } else if (field === "target") {
      // The machine the score is for (targets.js): a symbol, md or pc88.
      const name = v.kind === "atom" ? v.value : null;
      if (name && Object.hasOwn(TARGETS, name)) fileMeta.target = name;
      else err(`:target takes ${Object.keys(TARGETS).join(" or ")}, not ${atomValue(v) ?? "a list"}`, v);
    } else if (v.kind === "string") fileMeta[field] = v.value;
    else err(`${key} takes a string`, v);
  }
}

function parseSeDef(root, diagnostics) {
  const items = root.items.filter((n) => n.kind !== "comment");
  const name = atomValue(items[1]);
  if (!name || items[1].kind !== "atom" || name.startsWith(":") || isReservedHead(name)) {
    pushDiag(diagnostics, "error", name && isReservedHead(name) ? "E_DEF_RESERVED" : "E_DEF_NAME",
      name && isReservedHead(name) ? `'${name}' is a reserved eval builtin and cannot be a def name`
        : "def-se name must be a symbol", nodeSrc(root), null);
    return null;
  }
  const se = { name, prio: 0, tempo: 120, parts: [], src: nodeSrc(root) };
  let i = 2;
  for (; i + 1 < items.length && items[i].kind === "atom"; i += 2) {
    const key = atomValue(items[i]);
    const v = readConstNumber(items[i + 1], null, diagnostics, "global", nodeSrc(items[i + 1]));
    if (v === undefined) continue;
    if (key === ":prio" && Number.isInteger(v) && v >= 0 && v <= 255) se.prio = v;
    else if (key === ":tempo" && v !== null && v > 0) se.tempo = v;
    else {
      pushDiag(diagnostics, "error", "E_SE_OPTION",
        key === ":prio" ? `def-se :prio takes 0-255, not ${atomValue(items[i + 1]) ?? "a list"}`
          : key === ":tempo" ? `def-se :tempo takes a BPM, not ${atomValue(items[i + 1]) ?? "a list"}`
            : `def-se takes :prio and :tempo before its parts, not ${key}`,
        nodeSrc(items[i]), null);
    }
  }
  const seen = new Set();
  for (const part of items.slice(i)) {
    const head = part.kind === "list" ? atomValue(part.items[0]) : null;
    if (head && SE_CH3.has(head)) {
      pushDiag(diagnostics, "error", "E_SE_PART",
        `def-se ${name}: an effect cannot play on CH3 (${head}); put it on fm1, fm2 or fm4–fm6`,
        nodeSrc(part), null);
      continue;
    }
    if (!head || !SE_CHANNELS.has(head)) {
      pushDiag(diagnostics, "error", "E_SE_PART",
        `a def-se part is a channel form, e.g. (fm1 …), not ${head ? `(${head} …)` : "that"}`,
        nodeSrc(part), null);
      continue;
    }
    if (seen.has(head)) {
      pushDiag(diagnostics, "error", "E_SE_PART",
        `def-se ${name} has two parts on ${head}; an effect plays one part a channel`,
        nodeSrc(part), null);
      continue;
    }
    seen.add(head);
    se.parts.push(part);
  }
  if (!se.parts.length) {
    pushDiag(diagnostics, "error", "E_SE_PART", `def-se ${name} has no parts`, nodeSrc(root), null);
    return null;
  }
  return se;
}

// `(def-pcm name base …)`: the child takes the base's file (still read from the
// base's folder), slice, loop and effects — the import's chain included — and
// overrides the keys it writes. Runs once imports are merged, so a base may
// come from an imported kit.
export function resolveSampleExtends(sampleDefs, diagnostics) {
  const done = new Set();
  const resolve = (name, seen) => {
    const own = sampleDefs.get(name);
    if (!own?.extends || done.has(name)) return own;
    if (seen.has(name)) {
      pushDiag(diagnostics, "error", "E_SAMPLE_EXTENDS",
        `sample '${name}' extends itself`, own.src, null);
      return null;
    }
    seen.add(name);
    const base = sampleDefs.has(own.extends) ? resolve(own.extends, seen) : null;
    done.add(name);
    if (!base) {
      if (!sampleDefs.has(own.extends))
        pushDiag(diagnostics, "error", "E_SAMPLE_EXTENDS",
          `'${own.extends}' is not a sample`, own.src, null);
      return null;
    }
    const child = { ...base, src: own.src, extends: null };
    for (const k of ["rate", "offset", "frames", "startTok", "loopStartTok", "fxNode"])
      if (own[k] !== null) child[k] = own[k];
    if (own.file !== null) {
      child.file = own.file;
      child.baseDir = own.baseDir;
    }
    if (own.endTok !== null || own.lenTok !== null) {
      child.endTok = own.endTok;
      child.lenTok = own.lenTok;
    }
    if (own.loopEndTok !== null || own.loopLenTok !== null) {
      child.loopEndTok = own.loopEndTok;
      child.loopLenTok = own.loopLenTok;
    }
    sampleDefs.set(name, child);
    return child;
  };
  for (const name of [...sampleDefs.keys()]) resolve(name, new Set());
}

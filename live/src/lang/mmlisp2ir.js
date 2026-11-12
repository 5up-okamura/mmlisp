/**
 * MMLisp → IR compiler (tools/scripts/mmlisp2ir.js is a thin wrapper around it).
 * No Node.js dependencies; input is a MMLisp source string.
 *
 * API:
 *   compileMMLisp(src: string, filename?: string)
 *     → { ir: object, diagnostics: array, sourceMap: array }
 *
 * Errors in diagnostics have: { severity, code, message, line, column, track }
 */

import { hoistVoiceChanges } from "./voice-hoist.js";
import { DEFAULT_TARGET as DEFAULT_TARGET_NAME, targetProfile, partsWithSetting, ALL_CHANNEL_NAMES } from "../machine/targets.js";
import { opllRomVoices } from "../machine/chips/ym2413.js";
import { parse } from "./mmlisp-parser.js";
import { WAVE } from "../ir/ranges.js";
import { expandLoops, FRAME_HZ_NTSC, FRAME_HZ_PAL } from "../ir/timing.js";
import { resetDrawStreams, buildTempoSweepFromCurve } from "./compile/curves.js";
import { collectDefs, resolveSampleExtends, parseSampleDef, resolveSampleEffects, SE_FORBIDDEN_TARGETS } from "./compile/defs.js";
import { nodeSrc, atomValue, parseNumberLike, pushDiag, parseIntLike } from "./compile/diag.js";
import { expandRoots } from "./compile/expand.js";
import { resolveImports, dirnamePosix, normalizePathSeparators, overlayDefs, IMPORT_DEF_KINDS, isAbsolutePath, resolveSamplePath } from "./compile/imports.js";
import { writesVelSens, targetDiag, SONG_TARGETS, keywordOf } from "./compile/keywords.js";
import { expandTrackDelays, flattenPriorityLayers, shareChannelLayers, warnSongWrites, warnSharedChannels, convertCountedJumps, validateTrack } from "./compile/layers.js";
import { setCompileFrameHz, lengthTokenSeconds, WHOLE_TICKS, isNoteStreamToken, PPQN } from "./compile/length.js";
import { parseModDef, applyMods, rejectInlineStochasticSweeps, warnInlineSweepWaits } from "./compile/macros.js";
import { checkPartNotes } from "./compile/notes.js";
import { compileChannelBody } from "./compile/track.js";
import { createInitFmKwMap, resolveVoices, resolveWaves } from "./compile/voices.js";

function buildSourceMap(tracks) {
  const lineToTick = new Map();
  for (const track of tracks) {
    for (const ev of track.events ?? []) {
      const line = ev.src?.line;
      if (line == null) continue;
      const cur = lineToTick.get(line);
      if (cur === undefined || ev.tick < cur) lineToTick.set(line, ev.tick);
    }
  }
  return [...lineToTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, tick]) => ({ line, tick }));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortObject(value[key]);
    return out;
  }
  return value;
}

/**
 * Compile MMLisp source string to IR.
 * @param {string} src - MMLisp source text
 * @param {string} [filename] - filename for metadata / source map
 * @param {object} [options]
 * @param {Map<string,string>} [options.imports] - resolved (import "path")
 *   sources, keyed by the literal path string. Provided by the host, which does
 *   the async file I/O (recursing through nested imports via collectImports)
 *   before this synchronous compile. Absent paths surface E_IMPORT_NOT_FOUND.
 * @param {boolean} [options.voiceStamps] - keep each NOTE_ON's voice as
 *   `_voice` and each voice change's writes as `_voiceSet` (ir.md §5.1,
 *   §5.6), for an export that names them (midi-plan.js).
 * @returns {{ ir: object, diagnostics: array, sourceMap: array }}
 */
export function compileMMLisp(src, filename = "untitled.mmlisp", options = {}) {
  // `options.frameHz` picks the video standard the score is baked for: 60 for
  // NTSC (the default, and what the editor previews) or 50 for PAL. It is
  // compile-wide, so it is installed here rather than threaded — see
  // `compileFrameHz`. Restored in `finally` so a throw cannot leave the next
  // compile on the wrong clock.
  const wantHz = options.frameHz === FRAME_HZ_PAL ? FRAME_HZ_PAL : FRAME_HZ_NTSC;
  const prevHz = setCompileFrameHz(wantHz);
  try {
    // Tempo is song-wide, but each track converts its lengths (an `Nf` note,
    // a `125ms` gate) at the tempo in force as it goes — and a track sees only
    // its own :tempo writes. A song that changes tempo after tick 0 is compiled
    // twice: the first pass finds every track's tempo changes, the second
    // converts each length at the tempo the song has at its tick (§4).
    const first = compileScore(src, filename, options, wantHz, null);
    const tempoAt = songTempoMap(first.ir, first.openingBpm);
    const { openingBpm: _o, ...result } = tempoAt
      ? compileScore(src, filename, options, wantHz, tempoAt)
      : first;
    return result;
  } finally {
    setCompileFrameHz(prevHz);
  }
}

// The song's tempo at a tick, from every track's TEMPO_SET / TEMPO_SWEEP
// (a sweep counts at its end tempo from its start, as a track's own does),
// last writer winning at a tick in track order — or null when nothing changes
// the tempo after tick 0 and the song opens at the tempo the first pass read
// ahead (`opening`: a tempo written as an expression, or in a let, is not).
function songTempoMap(ir, opening) {
  const changes = [];
  (ir?.tracks ?? []).forEach((tr, ti) =>
    !tr.se && (tr.events ?? []).forEach((ev, ei) => {
      const bpm =
        ev.cmd === "TEMPO_SET" ? Number(ev.args?.bpm)
          : ev.cmd === "TEMPO_SWEEP" ? Number(ev.args?.to ?? ev.args?.from) : NaN;
      if (bpm > 0) changes.push({ tick: ev.tick ?? 0, ti, ei, bpm });
    }),
  );
  changes.sort((a, b) => a.tick - b.tick || a.ti - b.ti || a.ei - b.ei);
  const atZero = changes.filter((c) => c.tick === 0).at(-1)?.bpm ?? 120;
  if (!changes.some((c) => c.tick > 0) && atZero === opening) return null;
  return (tick) => {
    let bpm = null;
    for (const c of changes) {
      if (c.tick > tick) break;
      bpm = c.bpm;
    }
    return bpm;
  };
}

function compileScore(src, filename, options, frameHz, tempoAt) {
  const diagnostics = [];
  resetDrawStreams(); // every compile draws from the top (makeEvalCtx)
  const parsed = parse(src);
  const {
    defs,
    paramDefs,
    typedDefs,
    sampleDefs,
    waveDefs,
    seDefs,
    vals,
    fileMeta,
    imports,
    mods: modForms,
    remaining,
  } = collectDefs(parsed, diagnostics);
  // Fold imported defs in *under* this file's own — imports are
  // overridable defaults (local wins); two imports defining the same name is
  // E_IMPORT_CONFLICT. def-val slots and tracks are not imported (defs only).
  if (imports.length > 0) {
    const imported = resolveImports(
      imports,
      options.imports,
      diagnostics,
      dirnamePosix(normalizePathSeparators(filename)),
    );
    const local = { defs, paramDefs, typedDefs, sampleDefs, waveDefs, seDefs };
    overlayDefs(imported, local, filename); // local wins; `imported` = the union
    for (const kind of IMPORT_DEF_KINDS) {
      local[kind].clear();
      for (const [name, def] of imported[kind]) local[kind].set(name, def);
    }
  }
  if (!typedDefs.has("init-fm")) {
    typedDefs.set("init-fm", {
      tag: "voice",
      extends: null,
      items: [],
      kwMap: createInitFmKwMap(targetProfile(fileMeta.target)),
      src: null,
    });
  }
  // The OPLL's fifteen ROM voices are built in on every target, as init-fm
  // is: the chip's own on its channels, a 4-op reading elsewhere
  // (chips/ym2413.js). A score's own def of the name is that def.
  for (const [name, kwMap] of opllRomVoices(targetProfile(fileMeta.target).parts.find((p) => p.kind === "fm")))
    if (!typedDefs.has(name)) typedDefs.set(name, { tag: "voice", extends: null, items: [], kwMap, src: null });
  // A MIDI channel's instruments by name: gm-* and the roles, their programs.
  for (const part of targetProfile(fileMeta.target).parts.filter((p) => p.programNames))
    for (const name of part.programNames)
      if (!typedDefs.has(name)) typedDefs.set(name, { tag: "voice", extends: null, items: [], kwMap: new Map(), src: null });
  resolveVoices(typedDefs, defs, paramDefs, diagnostics,
    writesVelSens(parsed, defs, paramDefs, typedDefs, seDefs), targetProfile(fileMeta.target));
  typedDefs.waveNames = waveDefs; // beside the voices, for a track's bare name
  const waves = resolveWaves(waveDefs, typedDefs, defs, paramDefs, diagnostics);
  resolveSampleExtends(sampleDefs, diagnostics);
  // A target with a ROM rhythm kit names its sounds by the kit roles
  // (targets.js): a def of that name is that sound there, and one the score
  // does not define is built in, as init-fm is — an empty def (its "needs
  // :file" diagnostic goes nowhere: the ROM sound is all it is). A copy
  // either way: an import's defs are its cached bundle's, shared by every
  // score.
  const rhythmKit = Object.assign({}, ...targetProfile(fileMeta.target).parts.map((p) => p.kit ?? {}));
  for (const [name, sound] of Object.entries(rhythmKit))
    sampleDefs.set(name, {
      ...(sampleDefs.get(name) ?? { tag: "sample", ...parseSampleDef([], null, [], null), src: null }),
      rhythm: sound,
    });
  typedDefs.sampleNames = sampleDefs; // for a let name shadowing a sample
  const roots = expandRoots(remaining, defs, paramDefs, diagnostics);

  // 1 file = 1 score. There is no (score …) wrapper — the post-expand
  // root list *is* the score body: def/track forms interleave freely in source
  // order. File metadata comes from (def-score …).
  const fileSrc = roots.length > 0 ? nodeSrc(roots[0]) : { line: 1, column: 1 };

  // The tempo active at tick 0 seeds every track's currentTempo (tempo is
  // score-global) and the Nf frame conversion. Prescan the leading `:key value`
  // run of each track form for its `:tempo` — a bare BPM number or a curve
  // (its :from, default 120). Tempo is last-writer-wins at a tick, in track
  // order (§5), so the LAST track's leading tempo is the one that plays.
  let scoreInitialBpm = null;
  for (const node of roots) {
    if (node?.kind !== "list" || node.items.length === 0) continue;
    // The leading run: `:key value` pairs, and the voice / sample names bound
    // among them (they take no time).
    for (let i = 1; i + 1 < node.items.length; i += 2) {
      const key = atomValue(node.items[i]);
      if (typedDefs.has(key) || sampleDefs.has(key) || waveDefs.has(key)) {
        i--;
        continue;
      }
      if (typeof key !== "string" || !key.startsWith(":")) break;
      if (key !== ":tempo") continue;
      const valueNode = node.items[i + 1];
      const bpm = parseNumberLike(atomValue(valueNode));
      if (bpm !== null && bpm > 0) {
        scoreInitialBpm = bpm;
      } else {
        // Curve form: seed from its :from without emitting diagnostics here —
        // the body compiler re-parses it and reports errors once.
        const swept = buildTempoSweepFromCurve(valueNode, 0, 120, [], null, null);
        if (swept) scoreInitialBpm = swept.event.args.from;
      }
      break;
    }
  }

  // The second pass knows the tempo the song really opens at (one written as
  // an expression or inside a let escapes the read-ahead above).
  if (tempoAt) scoreInitialBpm = tempoAt(0) ?? scoreInitialBpm;

  // A def is parsed before any track, so a musical length inside one has no
  // tempo yet. Resolve the loop tokens here, at the tempo the score opens with.
  // The unit is SECONDS in the sample's own time — what a wave editor shows —
  // and the exporter maps them per baked blob, so a loop stays where it was set
  // however the note transposes (docs/language.md §16).
  // One resolve per :fx form: an import's chain is shared by every sample
  // of the kit, and an :extend shares its base's, so each is checked once.
  const fxResolved = new Map();
  for (const sample of sampleDefs.values()) {
    const bpm = scoreInitialBpm ?? 120;
    const fx = (node) => {
      if (!fxResolved.has(node))
        fxResolved.set(node, resolveSampleEffects(node, bpm, diagnostics, sample.src ?? fileSrc));
      return fxResolved.get(node);
    };
    // The import's chain first, then the def's own.
    sample.fx = [
      ...(sample.importFx ?? []).flatMap(fx),
      ...(sample.fxNode ? fx(sample.fxNode) : []),
    ];
    const sec = (tok, key) => {
      if (tok == null) return null;
      const v = lengthTokenSeconds(tok, bpm);
      if (v === null || !(v >= 0)) {
        pushDiag(
          diagnostics,
          "error",
          "E_SAMPLE_RANGE",
          `def-pcm ${key} is not a length: ${tok}`,
          sample.src ?? fileSrc,
          "global",
        );
        return null;
      }
      return v;
    };
    const rangeErr = (msg) => pushDiag(diagnostics, "error", "E_SAMPLE_RANGE",
      `def-pcm ${msg}`, sample.src ?? fileSrc, "global");
    const start = sec(sample.startTok, ":pcm-start");
    const end = sec(sample.endTok, ":pcm-end");
    const len = sec(sample.lenTok, ":pcm-len");
    if (start !== null || end !== null || len !== null) {
      sample.startSec = start ?? 0;
      // :pcm-end and :pcm-len both set the far bound; neither given means "to
      // the end of the sample", which the exporter fills in.
      sample.endSec = end ?? (len === null ? null : sample.startSec + len);
      if (sample.endSec !== null && sample.endSec <= sample.startSec) {
        rangeErr(`range ends at or before it starts (${sample.startSec}s -> ${sample.endSec}s)`);
        sample.startSec = null;
        sample.endSec = null;
      }
    }
    // The loop sits inside the range: pcm-start ≤ loop-start < loop-end ≤
    // pcm-end. A loop point left out follows the range (null), which the
    // exporter fills in per note.
    const ls = sec(sample.loopStartTok, ":loop-start");
    const le = sec(sample.loopEndTok, ":loop-end");
    const ll = sec(sample.loopLenTok, ":loop-len");
    if (ls !== null || le !== null || ll !== null) {
      const rs = sample.startSec ?? 0, re = sample.endSec;
      const from = ls ?? rs;
      const to = le ?? (ll === null ? null : from + ll);
      if (to !== null && to <= from) {
        rangeErr(`loop ends at or before it starts (${from}s -> ${to}s)`);
      } else if (from < rs || (re !== null && (from >= re || (to !== null && to > re)))) {
        const sec2 = (x) => (x === null ? "end" : `${x}s`);
        rangeErr(`loop (${sec2(from)} -> ${sec2(to)}) is outside its range (${sec2(rs)} -> ${sec2(re)})`);
      } else {
        sample.loopStartSec = ls;
        sample.loopEndSec = to;
      }
    }
  }

  // Lists with a channel name as the form head are tracks: the target's
  // channels (targets/).
  const target = targetProfile(fileMeta.target);
  const CHANNEL_NAMES = target.channelNames;

  const channelHeads = new Set();
  for (const node of roots) {
    if (!node || node.kind !== "list" || node.items.length === 0) continue;
    const head = atomValue(node.items[0]);
    if (head) channelHeads.add(head);
  }

  const hasCsmMode =
    channelHeads.has("fm3-csm") || channelHeads.has("fm3-csm-rate");
  const hasFm3OpTracks =
    channelHeads.has("fm3-1") ||
    channelHeads.has("fm3-2") ||
    channelHeads.has("fm3-3") ||
    channelHeads.has("fm3-4");
  // CSM with the operators as tracks (language.md §15): a note-less
  // (fm3-csm voice) beside fm3-1..fm3-4 — each operator's F-number and level
  // is its track's, a formant — and the buzz from an fm3-csm-rate track, the
  // one rate source there.
  const hasCsmOps = channelHeads.has("fm3-csm") && hasFm3OpTracks;
  if (hasCsmMode && channelHeads.has("fm3")) {
    pushDiag(diagnostics, "error", "E_FM3_MODE_CONFLICT",
      "fm3-csm/fm3-csm-rate cannot be mixed with fm3 in the same score", fileSrc, "global");
  }
  if (hasCsmMode && hasFm3OpTracks && !hasCsmOps) {
    pushDiag(diagnostics, "error", "E_FM3_MODE_CONFLICT",
      "fm3-1..fm3-4 beside fm3-csm-rate need a note-less (fm3-csm voice) track for the shared patch",
      fileSrc, "global");
  }
  if (hasCsmOps && !channelHeads.has("fm3-csm-rate")) {
    pushDiag(diagnostics, "error", "E_CSM_RATE_MISSING",
      "fm3-csm beside fm3-1..fm3-4 takes its rate from an fm3-csm-rate track; the score has none",
      fileSrc, "global");
  }

  // A part that reads :pcm-voices (the Mega Drive's DAC soft mix) plays as
  // many voices as its engine image, a whole-song choice — one image plays
  // 1, 2 or 3 voices at 14.4 / 10.1 / 6.7 kHz. The score states it, or it is
  // the highest of the part's voices a track uses. Any other target has none.
  // An effect's channels count here too: its PCM needs the voices, and fm6 is
  // the DAC for an effect as for the song.
  const allHeads = new Set(channelHeads);
  for (const se of seDefs.values())
    for (const part of se.parts) allHeads.add(atomValue(part.items[0]));
  const countsVoices = (part) => part?.settings?.includes(":pcm-voices");
  let pcmUsed = 0;
  for (const head of allHeads)
    if (countsVoices(target.partOf(head))) pcmUsed = Math.max(pcmUsed, target.channels[head].voice + 1);
  const pcmVoices = target.parts.some(countsVoices) ? fileMeta.pcmVoices ?? pcmUsed : 0;

  // What the target has, and what it does not: its parts' rules
  // (chips/parts.js `checkScore`), then the rules every target shares. The
  // line between a warning and an error is docs/roadmap.md's pc88 item.
  const scorePush = (severity, code, message) => pushDiag(diagnostics, severity, code, message, fileSrc, "global");
  for (const part of target.parts) part.checkScore?.({ target, allHeads, pcmUsed, pcmVoices, push: scorePush });
  // A def-score setting only a part this target lacks reads.
  for (const [key, value] of [[":pcm-voices", fileMeta.pcmVoices]])
    if (value !== null && !target.parts.some((p) => p.settings?.includes(key)))
      targetDiag(diagnostics, "warning",
        `${key} is the ${partsWithSetting(key)}'s setting; ${target.name} has no such choice, so it is ignored`,
        fileSrc, "global");
  // Two names on one physical voice in different parts are one channel two
  // ways (the SSG's noise is a tone channel's mixer): a score has one.
  const byVoice = new Map();
  for (const head of allHeads) {
    const key = target.voiceKey(head);
    if (!key) continue;
    if (!byVoice.has(key)) byVoice.set(key, []);
    byVoice.get(key).push(head);
  }
  for (const heads of byVoice.values()) {
    const parts = new Set(heads.map((h) => target.partOf(h)));
    if (parts.size < 2) continue;
    // Parts that rank among themselves share it (shareChannelLayers).
    if ([...parts].every((p) => p.sharePrio != null)) continue;
    const by = heads.find((h) => target.partOf(h).shareHint) ?? heads[1];
    const other = heads.find((h) => target.partOf(h) !== target.partOf(by));
    const hint = target.partOf(by).shareHint?.(other);
    targetDiag(diagnostics, "error",
      `on ${target.name} ${by} and ${other} are one channel, so a score has one or the other${hint ? ` — ${hint}` : ""}`,
      fileSrc, "global");
  }
  // Sound effects are started by a game through the target's driver.
  if (!target.driver && seDefs.size > 0)
    targetDiag(diagnostics, "error",
      `def-se is a sound effect a game starts through the Mega Drive's driver; the ${target.system}'s score (:target ${target.name}) is a VGM and has none`,
      [...seDefs.values()][0].src ?? fileSrc, "global");

  // A track's compile state — all of it sticky, persisting across
  // consecutive forms of the same channel. `tempoAt` is the song's tempo map
  // (second pass), which an effect's parts do not follow: they run at their
  // own tempo whatever the song does.
  const makeTrackState = (head, bpm, initialBpm, tempoAt) => ({
    tick: 0,
    head,
    target, // the machine (targets/): what its channels have
    part: target.partOf(head), // what the channel is (chips/parts.js)
    fmClock: target.chipForKind("fm")?.clock, // the CSM rate's Timer A runs on it
    defaultLength: Math.round(WHOLE_TICKS / 8),
    defaultOct: 4,
    voiceKeyShift: 0, // the current voice's `:key` − 60
    defaultGate: null,
    // The tempo lengths convert at: the song's at this tick when the
    // song-wide map is known (second pass), else this track's own.
    ownTempo: bpm,
    get currentTempo() {
      return (tempoAt && tempoAt(this.tick)) ?? this.ownTempo;
    },
    set currentTempo(v) {
      this.ownTempo = v;
    },
    initialBpm,
    isFm3OpTrack: /^fm3-[1-4]$/.test(head),
    fm3OpIndex: /^fm3-[1-4]$/.test(head)
      ? parseInt(head.slice(4), 10)
      : null,
    isCsmTrack: head === "fm3-csm",
    isCsmRateTrack: head === "fm3-csm-rate",
    isPcmTrack: target.partOf(head)?.kind === "sample",
    pcmSampleName: null, // bound by a bare sample name in the body
    pcmMode: "shot",
    sampleDefs,
    waves, // the def-waves, by name in waves.index (resolveWaves)
    hasInlineCsmRate: false,
    hasCsmOn: false,
    defaultVel: 15, // per-note velocity, KEY-ON scoped, 0-15
    noteAnalysis: options.noteAnalysis, // optional WeakMap, never serialized
    activeMacros: {}, // the macros in force, { target: spec, ... } for all targets
    delayTicks: 0, // (delay …) tap spacing in ticks (0 = off)
    delaySpec: null, // (delay …) relative spec {mode,type,…} or null

    glide: 0, // glide duration in ticks (0 = disabled)
    glideFrom: null, // one-shot start pitch override for glide
    lastNotePitch: null, // previous note's pitch for glide calculation
    glideRamp: null, // where the last glide has the pitch (cents) / CSM rate (period): rampAt
    pitchSticky: 0, // the score's `:pitch` offset, null once it is a runtime value
    shuffleSteps: null, // per-track grid warp, null = straight (§5.2)
    shuffleBase: Math.round(WHOLE_TICKS / 16),
    shuffle: null, // the warp in force: makeShuffle(shuffleSteps, shuffleBase)
    shufflePhase: 0, // written ticks since the warp's origin, mod its cycle
    shuffleDebt: 0, // ticks a squeezed note borrowed from what follows
    currentLoopId: null, // id of innermost counted (x N ...) loop, for (break)
  });

  const hasCompanionCsmRateTrack = channelHeads.has("fm3-csm-rate");
  let hasInlineCsmRate = false;
  // A stream that ends in `(go label)` never reaches its end: its CSM_OFF
  // would be unreachable on the driver and, in the preview — which runs a
  // track's events to their end before it loops — turn CSM off every pass.
  const endsInLoop = (events) => {
    const last = events[events.length - 1];
    return !!last && last.cmd === "JUMP" && last.args?.repeat == null;
  };
  const trackByKey = new Map();
  const trackOrder = [];
  const loopCounter = { count: 0 };

  for (const node of roots) {
    if (!node || node.kind === "comment") continue;
    if (node.kind !== "list") {
      // A token on its own at the top level. A def written there holds
      // channel forms (language.md §9) — a note or a keyword belongs in a
      // track, and a name that reached here unexpanded is no def.
      const tok = node.kind === "atom" ? node.value : `"${node.value}"`;
      pushDiag(diagnostics, "error", "E_UNKNOWN_TOPLEVEL_FORM",
        isNoteStreamToken(tok) || tok.startsWith(":")
          ? `'${tok}' is outside any track; a def written at the top level holds channel forms, (def intro (fm1 …) (fm2 …))`
          : `unknown top-level name '${tok}'; expected a channel form or a def`,
        nodeSrc(node), null);
      continue;
    }
    if (node.items.length === 0) continue;

    const head = atomValue(node.items[0]);
    if (head && !CHANNEL_NAMES.includes(head) && ALL_CHANNEL_NAMES.has(head)) {
      // Another machine's channel (targets/).
      targetDiag(diagnostics, "error", `${head} is not a channel of the ${target.system}`,
        nodeSrc(node.items[0]), null);
      continue;
    }
    if (!head || !CHANNEL_NAMES.includes(head)) {
      // Defs were already collected, so any other top-level list head (usually
      // a channel-name typo) is an error — a silently-vanished track is worse
      // than a diagnostic.
      pushDiag(
        diagnostics,
        "error",
        "E_UNKNOWN_TOPLEVEL_FORM",
        `unknown top-level form head '${head ?? ""}'; expected a channel name or def`,
        nodeSrc(node.items[0]),
        null,
      );
      continue;
    }

    // `:prio` is the one head option: it picks the layer (the timeline) the
    // form belongs to, so it must be read before the body. Everything else in
    // the form is body (language.md §5).
    // :prio layers forms on the same channel. Same prio appends (one
    // timeline); different prio values are independent parallel timelines on the
    // same physical channel, resolved by priority at the flatten post-pass.
    // Lower number = higher priority; default 8 (headroom on both sides).
    let i = 1;
    let prio = 8;
    if (atomValue(node.items[i]) === ":prio" && i + 1 < node.items.length) {
      const v = parseIntLike(atomValue(node.items[i + 1]));
      if (v !== null && v >= 0) prio = v;
      else
        pushDiag(diagnostics, "error", "E_PRIO_INVALID",
          `:prio takes a non-negative integer, not ${atomValue(node.items[i + 1]) ?? "a list"}`,
          nodeSrc(node.items[i]), head);
      i += 2;
    }
    const bodyItems = node.items.slice(i);
    const trackKey = `${head}:${prio}`;

    if (!trackByKey.has(trackKey)) {
      // All state is sticky and persists across consecutive forms of the same channel
      const trackState = makeTrackState(head, scoreInitialBpm ?? 120, scoreInitialBpm, tempoAt);

      const trackData = {
        id: trackOrder.length,
        // Original score channel name (e.g. "fm3-1", "pcm1"), preserved for the
        // UI to label and address per-sounding-channel. `channel` below collapses
        // FM3 variants to the shared hardware channel for the driver.
        scoreChannel: head,
        channel:
          head === "fm3-csm" ||
          head === "fm3-csm-rate" ||
          /^fm3-[1-4]$/.test(head)
            ? "fm3"
            : head,
        events: [],
      };

      // What the part starts every track with (the SN76489 noise's white0).
      // No src: nothing in the score wrote it, and a src (the whole track
      // form) would light the form up as the playhead, and lasting, on a
      // track with no notes.
      for (const args of trackState.part?.init ?? [])
        trackData.events.push({ tick: 0, cmd: "PARAM_SET", args: { ...args } });

      trackByKey.set(trackKey, { trackData, trackState, head, prio });
      trackOrder.push(trackKey);
    }

    const { trackData, trackState } = trackByKey.get(trackKey);
    // A pcm track's sample is checked where a note needs it (the note path),
    // once per track and sample — a body can still bind one before its notes.
    compileChannelBody(
      bodyItems,
      trackState,
      trackData.events,
      diagnostics,
      trackKey,
      typedDefs,
      loopCounter,
      vals,
    );

    // Surface bar markers (| … |) for the editor — inspection metadata only.
    if (trackState.bars?.length) trackData.bars = trackState.bars;

    // The form that ends the fm3-csm stream so far: its CSM_OFF goes there
    // once every form is in (below), not at the end of each form.
    if (trackState.isCsmTrack) trackByKey.get(trackKey).lastSrc = nodeSrc(node);
    if (trackState.isCsmTrack && trackState.hasInlineCsmRate) {
      hasInlineCsmRate = true;
    }
  }

  // CSM_OFF once, at the end of the fm3-csm stream (language.md §15): forms
  // of the channel append — a section's, a syllable's — so the mode stays on
  // from one to the next.
  for (const key of trackOrder) {
    const { trackData, trackState, lastSrc } = trackByKey.get(key);
    if (trackState.isCsmTrack && trackState.hasCsmOn && !endsInLoop(trackData.events))
      trackData.events.push({ tick: trackState.tick, cmd: "CSM_OFF", args: {}, src: lastSrc });
  }

  // Beside fm3-1..fm3-4 the rate track owns CSM: it turns the mode on at tick
  // 0 — Timer A held until its first rate — and off at its end, so the voice
  // sounds exactly while it plays (the note-less fm3-csm track ends at tick 0).
  if (hasCsmOps) {
    for (const key of trackOrder) {
      const { trackData, trackState } = trackByKey.get(key);
      if (!trackState.isCsmRateTrack) continue;
      const src = trackData.events[0]?.src;
      trackData.events.unshift(
        { tick: 0, cmd: "CSM_ON", args: {}, src },
        { tick: 0, cmd: "CSM_RATE", args: { run: false }, src },
      );
      if (!endsInLoop(trackData.events))
        trackData.events.push({ tick: trackState.tick, cmd: "CSM_OFF", args: {}, src });
    }
  }

  if (hasInlineCsmRate && hasCompanionCsmRateTrack) {
    pushDiag(
      diagnostics,
      "error",
      "E_CSM_RATE_SOURCE_CONFLICT",
      "inline :csm-rate and fm3-csm-rate companion track are mutually exclusive per score",
      fileSrc,
      "global",
    );
  }

  // Expand :delay echoes per prio-layer (each layer is its own linear timeline),
  // then merge layers that share a physical channel (same head) into one track.
  // def-mod: after the echoes exist, before the layers merge (applyMods).
  const mods = expandRoots(modForms, defs, paramDefs, diagnostics)
    .map((root) => parseModDef(root, CHANNEL_NAMES, typedDefs, sampleDefs, diagnostics))
    .filter(Boolean);
  for (const key of trackOrder) {
    const { trackData, head } = trackByKey.get(key);
    expandTrackDelays(trackData);
    if (mods.length) trackData.events = applyMods(trackData.events, head, mods);
  }

  const layersByHead = new Map();
  for (const key of trackOrder) {
    const entry = trackByKey.get(key);
    const arr = layersByHead.get(entry.head) ?? [];
    arr.push({ prio: entry.prio, trackData: entry.trackData });
    layersByHead.set(entry.head, arr);
  }

  // A part's rules for its notes, on every layer before flattening.
  const partShared = new Map();
  for (const key of trackOrder) {
    const { trackData, trackState } = trackByKey.get(key);
    const { part } = trackState;
    if (part && !partShared.has(part)) partShared.set(part, {});
    checkPartNotes(trackData.events, trackState, sampleDefs, diagnostics, key, partShared.get(part));
  }

  // Channels that share one wave memory (chips/parts.js `waveRam`: the SCC's
  // wave4 and wave5) play whichever wave was written last: said once when
  // their tracks name different ones.
  const waveRams = new Map();
  for (const key of trackOrder) {
    const { trackData, trackState } = trackByKey.get(key);
    const c = target.channels[trackState.head];
    if (!c?.part.waveRam) continue;
    const ram = `${c.chip}:${c.part.waveRam(c.voice)}`;
    const used = waveRams.get(ram) ?? { heads: new Set(), waves: new Set() };
    used.heads.add(trackState.head);
    for (const ev of trackData.events) {
      if (ev.cmd === "PARAM_SET" && ev.args?.target === "WAVE") used.waves.add(ev.args.value);
      for (const w of ev.cmd === "NOTE_ON" ? ev.args?.wave?.steps ?? [] : []) if (w != null) used.waves.add(w);
    }
    waveRams.set(ram, used);
  }
  for (const { heads, waves: named } of waveRams.values())
    if (heads.size > 1 && named.size > 1)
      targetDiag(diagnostics, "warning",
        `${[...heads].join(" and ")} share one wave memory, so the wave named last plays on both`, fileSrc, "global");

  const tracks = [];
  for (const [head, layers] of layersByHead) {
    tracks.push(
      layers.length === 1
        ? layers[0].trackData
        : flattenPriorityLayers(head, layers, diagnostics),
    );
  }
  // One channel under several names of parts that share it by rank
  // (`sharePrio`): their notes layered across the names. A name's :prio is
  // its highest layer's.
  const sharing = new Map();
  for (const tr of tracks) {
    const part = target.partOf(tr.channel);
    const key = target.voiceKey(tr.channel);
    if (part?.sharePrio == null || !key) continue;
    if (!sharing.has(key)) sharing.set(key, []);
    sharing.get(key).push({ prio: Math.min(...layersByHead.get(tr.channel).map((l) => l.prio)), rank: part.sharePrio, trackData: tr });
  }
  for (const layers of sharing.values())
    if (layers.length > 1) shareChannelLayers(layers.map((l) => l.trackData.channel), layers, diagnostics);

  // A part's rule over what its channels play together (chips/parts.js
  // `checkTracks`: the OPLL's one user voice), on each track's loops
  // written out, with the voices the score names.
  for (const part of target.parts) {
    if (!part.checkTracks) continue;
    const heads = new Set(target.channelNames.filter((h) => target.partOf(h) === part));
    const own = tracks.filter((t) => heads.has(t.channel));
    const named = [...typedDefs].filter(([, td]) => td.tag === "voice" && td.kwMap).map(([name, td]) => ({ name, kwMap: td.kwMap }));
    part.checkTracks({
      tracks: own.map((t) => ({ head: t.channel, events: expandLoops(t.events ?? []) })),
      named,
      push: (severity, code, message) => pushDiag(diagnostics, severity, code, message, fileSrc, "global"),
    });
  }

  // A song-wide word only a cartridge's parts have (an optional chip: the
  // 5B's :noise-rate, the FDS's :lfo-*), in a score that names none of its
  // channels: it would move nothing, and start the chip.
  const playedChips = new Set(tracks.map((t) => target.channels[t.channel]?.chip));
  const songWritten = new Set(tracks.flatMap((t) => (t.events ?? [])
    .filter((e) => /^PARAM_/.test(e.cmd) && SONG_TARGETS.has(e.args?.target)).map((e) => e.args.target)));
  for (const word of songWritten) {
    const owners = target.channelNames.filter((h) => target.partOf(h).songWords?.(word));
    const chips = new Set(owners.map((h) => target.channels[h].chip));
    if (!owners.length || [...chips].some((c) => !target.chips[c].optional || playedChips.has(c))) continue;
    const hint = target.hints?.[word];
    targetDiag(diagnostics, "error",
      `${keywordOf(word)} is the ${[...new Set(owners.map((h) => target.partOf(h).label))].join(" / ")}'s, a cartridge the score names no channel of (${owners.join(", ")})${hint ? ` — ${hint}` : ""}`,
      fileSrc, "global");
  }

  // Sound effects (def-se), after the song's tracks: each part is a track of
  // its own on the channel it names — never merged into the song's timeline
  // there, since it takes the channel from the song rather than joining it —
  // on the effect's own clock, and marked with the effect's number (its
  // place among the def-se forms, imports first), which is how the host
  // starts it. The same set in every song gives the same numbers.
  let seIndex = 0;
  for (const se of seDefs.values()) {
    const parts = expandRoots(se.parts, defs, paramDefs, diagnostics);
    for (const node of parts) {
      const head = atomValue(node.items[0]);
      const trackState = makeTrackState(head, se.tempo, se.tempo, null);
      const trackData = {
        id: 0,
        scoreChannel: head,
        channel: head,
        se: { name: se.name, index: seIndex, prio: se.prio },
        events: [{ tick: 0, cmd: "TEMPO_SET", args: { bpm: se.tempo }, src: se.src }],
      };
      for (const args of trackState.part?.init ?? [])
        trackData.events.push({ tick: 0, cmd: "PARAM_SET", args: { ...args }, src: se.src });
      compileChannelBody(node.items.slice(1), trackState, trackData.events, diagnostics,
        `se:${se.name}:${head}`, typedDefs, loopCounter, vals);
      // :master, :lfo-rate and the def-val slots are the song's, not a
      // channel's — the game's fader, the chip's one LFO, the score's values —
      // and an effect's end would leave them as it set them. An effect does
      // not write them (language.md §9.3).
      const valNames = new Map([...vals.values()].map((v) => [`VAL${v.slot}`, `:${v.name}`]));
      for (const ev of trackData.events) {
        // A tempo sweep drives the song's clock; an effect's tempo is fixed.
        if (ev.cmd === "TEMPO_SWEEP") pushDiag(diagnostics, "error", "E_SE_PART",
          `def-se ${se.name}: a :tempo sweep moves the song's clock; an effect keeps a fixed tempo`,
          ev.src ?? se.src, null);
        const t = SE_FORBIDDEN_TARGETS[ev.args?.target] ?? valNames.get(ev.args?.target);
        if (t) pushDiag(diagnostics, "error", "E_SE_PART",
          `def-se ${se.name}: ${t} is the song's, not an effect's`, ev.src ?? se.src, null);
      }
      if (trackState.isCsmTrack && trackState.hasCsmOn)
        trackData.events.push({ tick: trackState.tick, cmd: "CSM_OFF", args: {}, src: se.src });
      expandTrackDelays(trackData);
      tracks.push(trackData);
    }
    seIndex++;
  }

  // A note's voice is the compiler's alone (a def-mod :voice), but for an
  // export that names it (midi-plan.js's program change): `voiceStamps`.
  tracks.forEach((t, idx) => {
    t.id = idx;
    if (!options.voiceStamps) for (const ev of t.events) { delete ev._voice; delete ev._voiceSet; }
  });
  warnSongWrites(tracks.filter((t) => !t.se), diagnostics, frameHz);
  warnSharedChannels(tracks.filter((t) => !t.se), target, diagnostics);

  for (const track of tracks) convertCountedJumps(track);
  // A (break) that no counted loop claimed does nothing — an infinite loop has
  // no final pass to exit. Drop it and say so; a score that carries one (a
  // mucom import whose `[` never closed) still plays.
  for (const track of tracks) {
    const stray = (track.events ?? []).filter(
      (ev) => ev.cmd === "LOOP_BREAK" && ev.args?.id == null,
    );
    for (const ev of stray)
      pushDiag(diagnostics, "warning", "W_BREAK_OUTSIDE_LOOP",
        "(break) is outside a counted loop — (x N …) or #label … (go label N) — and does nothing; dropped",
        ev.src ?? { line: 1, column: 1 }, track.scoreChannel ?? track.channel ?? null);
    if (stray.length) track.events = track.events.filter((ev) => !stray.includes(ev));
  }
  for (const track of tracks) validateTrack(track, diagnostics);
  // On the driver's machine, voice changes move into the silence before
  // their note (voice-hoist.js), so a voice's ~36 writes do not share the
  // note's frame on the driver's wire. A VGM target has no wire: a voice is
  // written at its note. `options.voiceHoist`: false turns it off; an
  // object sets its windows.
  if (options.voiceHoist !== false && target.driver)
    hoistVoiceChanges(tracks, { ppqn: PPQN, ...(options.voiceHoist ?? {}) });

  // Tempo and LFO rate are written on tracks (body `:tempo` / `:lfo-rate`
  // emit their own tick-0 events); the only derived init event is FM3 op mode.
  if (tracks.length > 0 && hasFm3OpTracks) {
    tracks[0].events.unshift({
      tick: 0,
      cmd: "FM3_MODE",
      args: { mode: hasCsmOps ? "csm-op" : "op" },
      src: fileSrc,
    });
  }

  // Beside fm3-1..fm3-4 the (fm3 …) track — or, in CSM, the (fm3-csm …)
  // track — is the shared patch alone: the channel's F-number is operator 4's
  // there, so a note on it would fight fm3-4 for pitch and key.
  if (tracks.some((t) => !t.se && /^fm3-[1-4]$/.test(t.scoreChannel))) {
    for (const t of tracks) {
      if (t.se || (t.scoreChannel !== "fm3" && t.scoreChannel !== "fm3-csm")) continue;
      const note = t.events.find((ev) => ev.cmd === "NOTE_ON");
      if (note)
        pushDiag(diagnostics, "error", "E_FM3_MODE_CONFLICT",
          `(${t.scoreChannel} …) beside fm3-1..fm3-4 is the shared patch only: it takes no notes` +
            (t.scoreChannel === "fm3-csm" ? " (the buzz is the fm3-csm-rate track's)" : ""),
          note.src ?? fileSrc, t.scoreChannel);
    }
  }

  // An imported def knows its own directory; a def written here depends on the
  // score's path being known.
  const sampleBaseDir = (sample) =>
    sample?.baseDir ?? dirnamePosix(normalizePathSeparators(filename));
  for (const [name, sample] of sampleDefs.entries()) {
    if (!sample?.file) continue;
    if (isAbsolutePath(sample.file)) continue;
    if (sampleBaseDir(sample)) continue;
    pushDiag(
      diagnostics,
      "warning",
      "W_SAMPLE_BASE_UNKNOWN",
      `sample path is relative but source base directory is unknown: ${name}`,
      sample.src ?? { line: 1, column: 1 },
      "global",
    );
  }

  const ir = sortObject({
    version: 1,
    ppqn: PPQN,
    metadata: {
      title: fileMeta.title || filename,
      composer: fileMeta.composer ?? "",
      author: fileMeta.author ?? "",
      source: filename,
      pcmVoices,
      // The frame clock every `Nf`, macro step and sweep length in this IR was
      // resolved against (driver.md §3.3). The exporter reads it so a score can
      // never be compiled for one standard and baked for the other.
      frameHz,
      vals: [...vals.values()].map((v) => ({
        name: v.name,
        slot: v.slot,
        init: v.init,
        min: v.min,
        max: v.max,
        step: v.step,
        reversed: v.reversed,
        unit: v.unit,
        public: v.public,
      })),
      ...(target.name !== DEFAULT_TARGET_NAME ? { target: target.name } : {}),
      // The def-waves (ir.md): a PARAM_SET WAVE's value is the index.
      ...(waves.length ? { waves: waves.map((w) => ({ name: w.name, len: w.data.length, bits: WAVE.bits, data: w.data })) } : {}),
      samples: [...sampleDefs.entries()].map(([name, sample]) => ({
        name,
        ...(sample.rhythm ? { rhythm: sample.rhythm } : {}),
        file: sample.file,
        resolvedFile: sample.file ? resolveSamplePath(sample.file, sampleBaseDir(sample)) : null,
        rate: sample.rate,
        offset: sample.offset,
        frames: sample.frames,
        startSec: sample.startSec,
        endSec: sample.endSec,
        loopStartSec: sample.loopStartSec,
        loopEndSec: sample.loopEndSec,
        fx: sample.fx,
      })),
    },
    tracks,
  });

  // sortObject copies events: associate analysis with the returned instances.
  if (options.noteAnalysis) for (const track of ir.tracks) for (const ev of track.events) {
    if (ev._edit) { options.noteAnalysis.set(ev, ev._edit); delete ev._edit; }
  }

  rejectInlineStochasticSweeps(tracks, diagnostics);
  warnInlineSweepWaits(tracks, diagnostics);
  return { ir, diagnostics, sourceMap: buildSourceMap(tracks), openingBpm: scoreInitialBpm ?? 120 };
}


// A track's body compiled to its events: every form a track writes, one
// at a time, with its tuplets.

import { VEL_FINE } from "../../ir/levels.js";
import { waveSteps } from "../../ir/ranges.js";
import { compileTimeScalar, makeEvalCtx, readConstNumber, CURVE_NAMES, parseCurveSpec, buildTempoSweepFromCurve, isConstNumberNode } from "./curves.js";
import { pushDiag, nodeSrc, atomValue, parseNumberLike, describeNodeToken, pushUnknownDiag, parseIntLike } from "./diag.js";
import { opSuffix, targetDiag, canonicalTarget, SUPPORTED_TARGETS, INLINE_TARGETS, PCM_POINT_TARGETS, namedCc, PCM_PITCH_TARGETS, pcmRejectsPitch, targetLacks, trackLacks, PARAM_SET_TARGETS, VEL_SENS_TARGETS, TARGET_SYMBOLS, macroKeyword, MACRO_TARGETS, SONG_TARGETS } from "./keywords.js";
import { isPerNoteLengthAtom, isRestAtom, isNoteAtom, resolveLengthNode, parseGateFamily, gateInvalid, framesToTicks, isOctShiftAtom, isVelShiftAtom, parseRestLength, parsePerNoteLength, parseLengthToken } from "./length.js";
import { extractMacroStep, macroTargetGroup, clearMacroTarget, parseMacroSpec, macroOpOk, applyMacroEntryToState } from "./macros.js";
import { makeShuffle, emitCsmRateEvent, isPcmModeSymbol, noteUserPitchWrites, resolveShuffleTicks, editableContext, emitEditableNote, emitCsmRateNoteHz, shufflePasses, shuffleLoopWarning, dropLoopBreaks, connectAcrossJump, restoreConnectionState, connectionState, readTapArgs, emitEchoReplay, emitEvalNote } from "./notes.js";
import { warnEnvLevel, readValue, valueCtx, writeSnap, writeVelSens, writeLfoTable, writePcmPoint, writeParam } from "./params.js";
import { emitWave, waveExpr, warnWaveLen, waveIndexOf, emitVoice } from "./voices.js";
import { makeEnv, evalScalarValue, isEvalHead, lookupBound, evalLet, evalFor, evalIf } from "../mmlisp-eval.js";
import { ALL_CHANNEL_NAMES } from "../../machine/targets.js";

// A tuplet's next share of its slot.
function tupletShare(state) {
  const t = state.tuplet;
  t.acc += t.total;
  const share = Math.floor(t.acc / t.n);
  t.acc -= share * t.n;
  return share;
}

// Forms a tuplet's body refuses (language.md, Tuplets): a note with a length of
// its own or time of its own, a loop that would replay one pass's shares, a
// jump in or out of the slot, and what hides the count of notes until it runs.
const TUPLET_REFUSED_FORMS = new Set(["note", "echo", "t", "x", "go", "break", "for", "if", "let"]);

// The notes and rests of a tuplet's body, each a share of the slot — the
// shares must be known before the first is played — or -1 when it can't be one.
function tupletNotes(items, diagnostics, trackName) {
  let n = 0, bad = false;
  const refuse = (msg, node) => {
    pushDiag(diagnostics, "error", "E_UNKNOWN_TUPLET_ELEM", msg, nodeSrc(node), trackName);
    bad = true;
  };
  for (let k = 0; k < items.length; k++) {
    const it = items[k], v = atomValue(it);
    if (it.kind === "list") {
      const head = atomValue(it.items[0]);
      if (TUPLET_REFUSED_FORMS.has(head)) refuse(`(${head} …) cannot go in a tuplet`, it);
      continue;
    }
    if (/^:len[+*-]?$/.test(v)) refuse(`${v}: a tuplet divides the :len it starts with`, it);
    else if (/^:shuffle(-base)?$/.test(v)) refuse(`${v}: the grid has to hold through a tuplet's slot — set it before the tuplet`, it);
    else if (v?.startsWith("#")) refuse(`${v}: a tuplet is one slot, with no label inside`, it);
    else if (!v?.startsWith(":") && parseNumberLike(v) !== null) refuse(`${v}: a tuplet takes notes and rests`, it);
    else if (isPerNoteLengthAtom(v) || (isRestAtom(v) && v !== "_")) refuse(`${v}: a tuplet's notes and rests take no length — each is an equal share of the :len slot`, it);
    if (v?.startsWith(":")) k++; // its value is not a note
    else if (v === "_" || isNoteAtom(v)) n++;
  }
  return bad ? -1 : n;
}

/**
 * The channel body compiler.
 * Processes notes, rests, inline modifiers, and structural forms directly
 * from an indexed item list. All state (oct, len, gate, vol) is sticky:
 * modifications persist in trackState across items and across channel forms.
 */
export function compileChannelBody(
  items,
  trackState,
  events,
  diagnostics,
  trackName,
  typedDefs,
  loopCounter,
  vals,
  env = null,
) {
  // Lexical env for compile-time eval: each `let` (§7.2) extends it for the
  // body it wraps.
  const evalEnv = env ?? makeEnv(null);
  const labelsHere = new Map(); // #label id -> its index in these items
  let i = 0;
  while (i < items.length) {
    const node = items[i];
    if (!node) {
      i++;
      continue;
    }

    // Skip comments
    if (node.kind === "comment") {
      i++;
      continue;
    }

    // ── Atom items ───────────────────────────────────────────────────────
    if (node.kind === "atom") {
      const val = node.value;

      // Label marker: #name
      if (val.startsWith("#")) {
        const id = val.slice(1);
        if (!id) {
          pushDiag(
            diagnostics,
            "error",
            "E_LABEL_EMPTY",
            "label name must not be empty",
            nodeSrc(node),
            trackName,
          );
        } else {
          labelsHere.set(id, i);
          (trackState.labelPhase ??= new Map()).set(id, { phase: trackState.shufflePhase, shuffle: trackState.shuffle });
          events.push({
            tick: trackState.tick,
            cmd: "MARKER",
            args: { id },
            src: nodeSrc(node),
          });
        }
        i++;
        continue;
      }

      // Bar marker: | — an inspection aid, not a musical event. Records the
      // running tick and a 1-based ordinal so the editor can show a region's
      // span (difference between consecutive bars) and which bar a `|` is. No
      // meter/time-signature concept — songs may change meter freely. Emits
      // nothing to the event stream, so the driver is unaffected.
      if (val === "|") {
        const bars = (trackState.bars ??= []);
        bars.push({
          ordinal: bars.length + 1,
          tick: trackState.tick,
          line: node.line,
          column: node.column,
        });
        i++;
        continue;
      }

      // Inline keyword modifier: :oct N, :len N, :gate N, :vol N, :tl1 30, etc.
      if (val.startsWith(":")) {
        i++;
        // A keyword that exists, on a channel that has no such thing.
        const wrongChannel = (kw, channels) =>
          pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET",
            `${kw} is only for ${channels}, not ${String(trackName).split(":")[0]}`,
            nodeSrc(node), trackName);
        if (i < items.length) {
          const rawVal = atomValue(items[i]);
          switch (val) {
            case ":oct":
            case ":oct+": {
              // absolute / +add against the running octave base
              const { op } = opSuffix(val);
              const raw = compileTimeScalar(
                items[i], rawVal, op, evalEnv, val, diagnostics, trackName, nodeSrc(node), typedDefs,
              );
              if (raw !== null && !Number.isNaN(raw)) {
                const cur = trackState.defaultOct;
                trackState.defaultOct = Math.max(0, Math.round(op === "+" ? cur + raw : raw));
              }
              break;
            }
            case ":len":
              trackState.defaultLength = resolveLengthNode(
                items[i],
                trackState.defaultLength,
                trackState,
                makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs),
                evalEnv,
              );
              break;
            case ":gate":
            case ":gate*":
            case ":gate-": {
              // `(ticks/frames …)` are absolute times → only meaningful for
              // `:gate`; ratios/cuts (`:gate*`/`:gate-`) keep the token parser.
              if (val === ":gate" && items[i]?.kind === "list") {
                const t = resolveLengthNode(
                  items[i],
                  0,
                  trackState,
                  makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs),
                  evalEnv,
                );
                trackState.defaultGate = { type: "ticks", value: t };
                break;
              }
              let g;
              if (items[i]?.kind === "list" && val === ":gate-") {
                // a length expression: `(ticks 12)`, `(* 2 8)` (§7.4)
                const t = resolveLengthNode(items[i], 0, trackState,
                  makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs), evalEnv);
                g = t > 0 ? { type: "cut", value: t } : null;
              } else if (items[i]?.kind === "list") {
                const f = readConstNumber(items[i], evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs);
                if (f === undefined) break;
                g = f !== null && f >= 0 && f <= 1 ? { type: "ratio", value: f } : null;
              } else g = parseGateFamily(val, rawVal, trackState.currentTempo);
              if (g !== null) trackState.defaultGate = g;
              else gateInvalid(diagnostics, val, rawVal ?? "an expression out of range", nodeSrc(node), trackName);
              break;
            }
            case ":shuffle":
            case ":shuffle-base": {
              // The grid warp (§5.2): `R` (1..99, 50 = straight) is a pair's
              // first share; `[w1 … wN]` a cycle of N steps in those
              // proportions; `none` (or 0) is straight. A change restarts the
              // cycle here.
              if (val === ":shuffle") {
                const bad = (what) => pushDiag(diagnostics, "error", "E_SHUFFLE_INVALID",
                  `:shuffle takes 1..99, a list of step weights [w1 … wN] or none, not ${what}`,
                  nodeSrc(node), trackName);
                const vec = items[i]?.kind === "list" && items[i].bracket === "[]";
                let steps;
                if (rawVal === "none") steps = null;
                else if (vec) {
                  steps = [];
                  for (const it of items[i].items.filter((n) => n.kind !== "comment")) {
                    const w = evalScalarValue(it, evalEnv, makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs));
                    if (w === null) { steps = undefined; break; }
                    if (!(w > 0)) { bad(`a step of ${w}`); steps = undefined; break; }
                    steps.push(w);
                  }
                  if (steps === undefined) break;
                  if (!steps.length) { bad("[]"); break; }
                } else {
                  const n = readConstNumber(items[i], evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs);
                  if (n === undefined) break;
                  if (n === null || n < 0 || n >= 100) { bad(rawVal ?? "that"); break; }
                  steps = n === 0 ? null : [n, 100 - n];
                }
                trackState.shuffleSteps = steps && steps.some((w) => w !== steps[0]) ? steps : null;
              } else {
                const b = resolveLengthNode(
                  items[i],
                  trackState.shuffleBase,
                  trackState,
                  makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs),
                  evalEnv,
                );
                if (!(b > 0)) {
                  pushDiag(diagnostics, "error", "E_SHUFFLE_INVALID",
                    `:shuffle-base takes a length above 0, not ${rawVal ?? "that"}`, nodeSrc(node), trackName);
                  break;
                }
                trackState.shuffleBase = b;
              }
              trackState.shuffle = trackState.shuffleSteps && trackState.shuffleBase > 0
                ? makeShuffle(trackState.shuffleSteps, trackState.shuffleBase) : null;
              trackState.shufflePhase = 0;
              trackState.shuffleDebt = 0;
              break;
            }
            case ":vel":
            case ":vel+":
            case ":vel*": {
              // per-note velocity (KEY-ON scoped, sticky): absolute / +add /
              // *multiply against the running vel base (default 15).
              const { op } = opSuffix(val);
              const raw = compileTimeScalar(
                items[i], rawVal, op, evalEnv, val, diagnostics, trackName, nodeSrc(node), typedDefs, true,
              );
              warnEnvLevel(trackState, val, diagnostics, nodeSrc(node), trackName);
              if (raw !== null && !Number.isNaN(raw)) {
                const cur = trackState.defaultVel ?? 15;
                const next =
                  op === "+" ? cur + raw : op === "*" ? cur * raw : raw;
                // On the driver's grid: eighths of a step (language.md §6).
                trackState.defaultVel = Math.max(0, Math.min(15, Math.round(next * VEL_FINE) / VEL_FINE));
              }
              break;
            }
            case ":csm-rate": {
              if (!trackState.isCsmTrack) {
                wrongChannel(val, "fm3-csm");
                break;
              }
              const valueNode = items[i];
              // A number, or an expression (§7.1: `(hz a3)`, `(* 2 110)`) —
              // a curve head is the swept form below.
              const isExpr = valueNode?.kind === "list" && valueNode.bracket === "()" &&
                !CURVE_NAMES.has(atomValue(valueNode.items?.[0]));
              const hz = isExpr
                ? evalScalarValue(valueNode, evalEnv, makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs))
                : parseNumberLike(rawVal);
              if (isExpr && hz === null) break; // diagnostic already pushed
              if (hz !== null) {
                emitCsmRateEvent(
                  trackState,
                  events,
                  diagnostics,
                  nodeSrc(node),
                  trackName,
                  { hz },
                  true,
                );
                break;
              }

              if (
                valueNode?.kind === "list" &&
                valueNode.bracket === "()" &&
                valueNode.items?.length > 0
              ) {
                const curveSpec = parseCurveSpec(
                  valueNode,
                  diagnostics,
                  nodeSrc(node),
                  trackName,
                  true,
                  null,
                  evalEnv,
                );
                if (!curveSpec) break;

                const from = parseNumberLike(String(curveSpec.from ?? ""));
                const to = parseNumberLike(String(curveSpec.to ?? ""));
                // CSM_RATE's `len` is ticks: an `Nf` / `Nms` length converts at
                // the tempo in force.
                const len =
                  Number.isFinite(Number(curveSpec.frames)) &&
                  Number(curveSpec.frames) > 0
                    ? curveSpec.lenFrames
                      ? framesToTicks(Number(curveSpec.frames), trackState.currentTempo)
                      : Number(curveSpec.frames)
                    : null;

                if (
                  from !== null &&
                  to !== null &&
                  Number.isFinite(from) &&
                  Number.isFinite(to) &&
                  len !== null &&
                  len > 0
                ) {
                  emitCsmRateEvent(
                    trackState,
                    events,
                    diagnostics,
                    nodeSrc(node),
                    trackName,
                    {
                      from,
                      to,
                      len,
                      curve: curveSpec.curve,
                      params: curveSpec.params,
                    },
                    true,
                  );
                } else {
                  pushDiag(
                    diagnostics,
                    "error",
                    "E_CSM_RATE_INVALID",
                    "invalid :csm-rate curve; expected (<curve> :from N :to M :len L)",
                    nodeSrc(node),
                    trackName,
                  );
                }
              }
              break;
            }
            case ":tempo": {
              const valueNode = items[i];
              // A number is TEMPO_SET; a curve is a TEMPO_SWEEP below.
              const v = readValue(valueNode, evalEnv,
                valueCtx(null, vals, diagnostics, trackName, nodeSrc(node), typedDefs));
              if (!v) break;
              if (v.kind !== "scalar" && v.kind !== "signal") {
                pushDiag(diagnostics, "error", "E_TEMPO_INVALID",
                  ":tempo takes a BPM number or a curve", nodeSrc(node), trackName);
                break;
              }
              const bpm = v.kind === "scalar" ? v.value : null;
              if (bpm !== null && !(bpm > 0)) {
                pushDiag(diagnostics, "error", "E_TEMPO_INVALID",
                  `:tempo must be above 0 BPM, not ${bpm}`, nodeSrc(node), trackName);
                break;
              }
              if (bpm !== null && bpm > 0) {
                // At tick 0 the song's tempo is the last track's leading one
                // (last writer wins, §5): convert this track's lengths at the
                // tempo that plays, not at the one it wrote.
                trackState.currentTempo =
                  trackState.tick === 0 && trackState.initialBpm != null ? trackState.initialBpm : bpm;
                events.push({
                  tick: trackState.tick,
                  cmd: "TEMPO_SET",
                  args: { bpm },
                  src: nodeSrc(node),
                });
                break;
              }

              const swept = buildTempoSweepFromCurve(
                valueNode,
                trackState.tick,
                trackState.currentTempo,
                diagnostics,
                nodeSrc(node),
                trackName,
                evalEnv,
              );
              if (swept) {
                trackState.currentTempo = swept.toBpm;
                events.push(swept.event);
              }
              break;
            }
            case ":wave": {
              // A wave expression (language.md §19): folded, an anonymous wave
              // the track names as it would a def-wave; with a $slot, the tree
              // the IR player runs as the slot moves. A bare name is the
              // def-wave itself, as written alone in the body.
              const { part, target: machine } = trackState;
              if (!part?.words("WAVE")) {
                wrongChannel(val, machine.headsOfKind("wave").join(", ") || "a wave channel");
                break;
              }
              const valueNode = items[i];
              if (valueNode?.kind === "atom" && trackState.waves?.index.has(valueNode.value)) {
                emitWave(trackState, events, nodeSrc(node), valueNode.value, diagnostics, trackName);
                break;
              }
              trackState.editWaveName = null;
              const r = waveExpr(valueNode, {
                waveOf: (name, at) => trackState.waves?.dataOf(name, at) ?? null,
                vals, runtime: true, diagnostics, trackName,
              });
              if (!r) break;
              if (r.n != null) {
                pushDiag(diagnostics, "error", "E_WAVE_VALUE", `:wave takes a wave, not the number ${r.n}`, nodeSrc(valueNode), trackName);
                break;
              }
              // (One with a $slot: the longest wave its tree reads.)
              const longest = (t) => Math.max(t.data?.length ?? 0, ...(t.args ?? []).map(longest));
              const steps = r.data ?? (r.tree ? { length: longest(r.tree) } : null);
              if (steps) warnWaveLen(trackState, ":wave", steps, nodeSrc(valueNode), diagnostics, trackName);
              const args = r.tree
                ? { target: "WAVE", expr: r.tree }
                : { target: "WAVE", value: waveIndexOf(trackState.waves, `${trackState.head}@${valueNode.line}:${valueNode.column}`, waveSteps(r.data)) };
              events.push({ tick: trackState.tick, cmd: "PARAM_SET", args, src: nodeSrc(node) });
              break;
            }
            case ":mode": {
              // The part's symbols (chips/parts.js), else the target's reading
              // of another machine's (targets/), else the part's error.
              // A channel may have its own (the OPM's fm8: its noise).
              const { part, target: machine } = trackState;
              if (!part) break; // a channel the machine has not: said where the track is read
              const own = machine.channels?.[trackState.head];
              const modes = own?.modes ?? part.modes;
              const modeError = own?.modes ? own.modeError : part.modeError;
              const reading = machine.readsAs?.modes?.[part.name]?.[rawVal];
              if (part.kind === "sample") {
                if (isPcmModeSymbol(rawVal)) trackState.pcmMode = rawVal;
                else
                  pushDiag(diagnostics, "error", "E_PCM_MODE_INVALID",
                    "pcm :mode must be shot, loop or gate", nodeSrc(node), trackName);
              } else if (modes && Object.hasOwn(modes, rawVal)) {
                const [target, value] = modes[rawVal];
                events.push({ tick: trackState.tick, cmd: "PARAM_SET",
                  args: { target, value }, src: nodeSrc(node) });
              } else if (reading?.write) {
                targetDiag(diagnostics, "warning",
                  `${trackState.head} :mode ${rawVal} is not a mode the ${machine.system} has; it reads as ${reading.as}`,
                  nodeSrc(node), trackName);
                const [target, value] = reading.write;
                events.push({ tick: trackState.tick, cmd: "PARAM_SET",
                  args: { target, value }, src: nodeSrc(node) });
              } else if (reading) {
                targetDiag(diagnostics, "error",
                  `${trackState.head} :mode ${rawVal} has no ${machine.name} sound: ${reading.none}`,
                  nodeSrc(node), trackName);
              } else if (modeError) {
                pushDiag(diagnostics, "error", modeError.code, modeError.message,
                  nodeSrc(node), trackName);
              } else {
                wrongChannel(val, machine.channelNames.filter((h) =>
                  machine.partOf(h).kind === "sample" || Object.keys(machine.channels[h].modes ?? machine.partOf(h).modes ?? {}).length).join(", "));
              }
              break;
            }
            default: {
              // Inline hardware param write: :tl1 30, :tl1+ 5, :tl1 $x, ...
              // Absolute literal → PARAM_SET; curve → PARAM_SWEEP; +/* operator
              // or $value → runtime PARAM_ADD/PARAM_MUL/PARAM_FROM_VAL.
              const { stem, op } = opSuffix(val);
              // A def-val's own name writes its slot: score-global, like
              // :tempo, whichever track carries it (§8).
              const valDef = vals?.get(stem.slice(1));
              const target = valDef ? `VAL${valDef.slot}` : canonicalTarget(stem);
              if (!valDef && !SUPPORTED_TARGETS.has(target) && !INLINE_TARGETS.has(target) &&
                  !PCM_POINT_TARGETS.has(target)) {
                // Unrecognized `:keyword` — a typo or a stray track-header option
                // used mid-body. Fail loudly instead of dropping it silently.
                pushDiag(
                  diagnostics,
                  "error",
                  "E_UNKNOWN_KEYWORD",
                  namedCc(target) ?? `unknown inline keyword: ${val}`,
                  nodeSrc(node),
                  trackName,
                );
                break;
              }
              if (
                PCM_PITCH_TARGETS.has(target) &&
                pcmRejectsPitch(
                  trackState,
                  val,
                  diagnostics,
                  nodeSrc(node),
                  trackName,
                  target,
                )
              )
                break;
              const lacks = !valDef && targetLacks(target, val, trackState.target);
              if (lacks) {
                targetDiag(diagnostics, "error", lacks, nodeSrc(node), trackName);
                break;
              }
              const chLacks = !valDef && trackLacks(target, val, trackState);
              if (chLacks) {
                pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET", chLacks, nodeSrc(node), trackName);
                break;
              }
              if (!valDef && !PARAM_SET_TARGETS.has(target)) {
                // A known macro keyword (:semi/:keyon) with no absolute-write
                // meaning — valid in a (macro …) but not as an inline write.
                pushDiag(
                  diagnostics,
                  "error",
                  "E_UNSUPPORTED_TARGET",
                  `${val} is macro-only; not an inline parameter write`,
                  nodeSrc(node),
                  trackName,
                );
                break;
              }
              const push = (cmd, args) =>
                events.push({
                  tick: trackState.tick,
                  cmd,
                  args,
                  src: nodeSrc(node),
                });
              if (target === "SNAP") {
                writeSnap(val, op, items[i], evalEnv, vals, push, diagnostics, nodeSrc(node),
                  trackName, typedDefs);
                break;
              }
              if (target === "LFO_SYNC") {
                // A switch, state: on or off, no number, curve, $value or `+`.
                const word = items[i]?.kind === "atom" ? items[i].value : null;
                if (!op && (word === "on" || word === "off")) push("PARAM_SET", { target, value: word === "on" ? 1 : 0 });
                else pushDiag(diagnostics, "error", "E_PARAM_VALUE",
                  `:lfo-sync takes on or off, not ${op ? `'${op}'` : `'${describeNodeToken(items[i])}'`}`, nodeSrc(node), trackName);
                break;
              }
              if (VEL_SENS_TARGETS.has(target)) {
                writeVelSens(target, val, op, items[i], evalEnv, vals, push, diagnostics,
                  nodeSrc(node), trackName, typedDefs);
                break;
              }
              if (!op && rawVal === "none" && TARGET_SYMBOLS[target]?.none === undefined) {
                // Stop a running inline PARAM_SWEEP, freezing the value.
                push("PARAM_SWEEP_STOP", { target });
                break;
              }
              if (target === "LFO_WAVE" && (trackState.target.parts.some((p) => p.lfoTable) ||
                  (items[i]?.kind === "list" && items[i].bracket === "[]"))) {
                writeLfoTable(val, op, items[i], trackState.target, push, diagnostics, nodeSrc(node), trackName);
                break;
              }
              if (PCM_POINT_TARGETS.has(target)) {
                writePcmPoint(target, val, op, items[i], trackState, push,
                  diagnostics, nodeSrc(node), trackName, evalEnv);
                break;
              }
              const writtenFrom = events.length;
              writeParam(target, op, val, readValue(items[i], evalEnv, valueCtx(target, vals, diagnostics, trackName, nodeSrc(node), typedDefs)), push,
                evalEnv, vals, diagnostics, trackName, nodeSrc(node));
              if (target === "NOTE_PITCH")
                noteUserPitchWrites(trackState, events.slice(writtenFrom));
              if (target === "SSG_ENV")
                trackState.ssgEnv = (events.at(-1)?.args?.value ?? -1) >= 0;
              if (target === "VOL") warnEnvLevel(trackState, val, diagnostics, nodeSrc(node), trackName);
              break;
            }
          }
          i++;
        }
        continue;
      }

      // Octave and velocity shifts: > < o± v±
      if (val === ">" || val === "<" || isOctShiftAtom(val)) {
        const delta = val === ">" ? 1 : val === "<" ? -1
          : (val[1] === "+" ? 1 : -1) * (val.length > 2 ? parseInt(val.slice(2), 10) : 1);
        trackState.defaultOct = Math.max(0, trackState.defaultOct + delta);
        i++;
        continue;
      }
      if (isVelShiftAtom(val)) {
        const delta = (val[1] === "+" ? 1 : -1) * (val.length > 2 ? parseInt(val.slice(2), 10) : 1);
        trackState.defaultVel = Math.max(0, Math.min(15, trackState.defaultVel + delta));
        i++;
        continue;
      }

      // Slur/tie connector: X ~ Y. Marks the next real note as connected to the
      // previous one — same pitch ties (extends), different pitch slurs (a
      // legato NOTE_ON: new pitch, no re-key). The flag attaches to the next
      // real note, skipping state tokens (`c ~ > d`). The connected note keeps
      // its own length, so `~` consumes none.
      if (val === "~") {
        trackState.pendingLegato = true;
        i++;
        continue;
      }

      // Rest atom: "_", "_4", "_4.", "_14t", "_16f"
      if (isRestAtom(val)) {
        const nominal = trackState.tuplet ? tupletShare(trackState) : parseRestLength(val, trackState.defaultLength, trackState.currentTempo);
        const ticks = resolveShuffleTicks(
          nominal,
          trackState, diagnostics, nodeSrc(node), trackName,
        );
        // A rest on the rate source rests the CSM buzz (language.md §15): Timer
        // A stops, CSM stays on, and the next rate (or, with an inline
        // :csm-rate, the next fm3-csm note) starts it again.
        if (
          !trackState.csmStopped &&
          (trackState.isCsmRateTrack ? trackState.glideRamp : trackState.isCsmTrack && trackState.hasInlineCsmRate)
        ) {
          events.push({ tick: trackState.tick, cmd: "CSM_RATE", args: { run: false }, src: nodeSrc(node) });
          trackState.csmStopped = true;
        }
        events.push({
          tick: trackState.tick,
          cmd: "REST",
          args: { length: ticks },
          src: nodeSrc(node),
          ...(trackState.noteAnalysis ? { _edit: editableContext(trackState, nominal) } : {}),
        });
        trackState.tick += ticks;
        trackState.tiedHead = null; // a rest ends the tied group
        trackState.pcmTiedHead = null;
        i++;
        continue;
      }

      // Per-note length atom: c4, e8., f+12t, b-6f, a1/2
      if (isPerNoteLengthAtom(val)) {
        const { noteName, lengthStr } = parsePerNoteLength(val);
        emitEditableNote(trackState, noteName,
          parseLengthToken(lengthStr, trackState.defaultLength, trackState.currentTempo),
          events, diagnostics, nodeSrc(node), trackName);
        i++;
        continue;
      }

      // Bare note: c, d, e, f, g, a, b (with optional + or -)
      if (isNoteAtom(val)) {
        emitEditableNote(trackState, val, trackState.tuplet ? tupletShare(trackState) : trackState.defaultLength,
          events, diagnostics, nodeSrc(node), trackName);
        i++;
        continue;
      }

      // Bare identifier: a sample binds on a pcm track, as a voice does on FM
      if (trackState.isPcmTrack && trackState.sampleDefs?.has(val)) {
        trackState.pcmSampleName = val;
        i++;
        continue;
      }

      // Bare identifier: a def-wave (the wave the channel plays from here). A
      // wave and a voice can share a name: the channel's part says which it is.
      if (typedDefs?.waveNames?.has(val) && (!typedDefs.has(val) || trackState.part?.kind === "wave")) {
        emitWave(trackState, events, nodeSrc(node), val, diagnostics, trackName);
        i++;
        continue;
      }

      // Bare identifier: a def-fm voice (a voice switch)
      if (typedDefs?.has(val)) {
        emitVoice(typedDefs.get(val), trackState.tick, events, nodeSrc(node), trackState, val, diagnostics, trackName);
        trackState.voiceName = val; // what a def-mod :voice matches

        i++;
        continue;
      }

      // Unknown atom: report as error (except fm3-csm-rate numeric shorthand).
      if (trackState.isCsmRateTrack) {
        const rawHz = parseNumberLike(val);
        if (rawHz !== null) {
          const ticks = resolveShuffleTicks(
            trackState.defaultLength,
            trackState, diagnostics, nodeSrc(node), trackName,
          );
          emitCsmRateNoteHz(
            trackState,
            events,
            diagnostics,
            nodeSrc(node),
            trackName,
            rawHz,
          );
          trackState.tick += ticks;
          i++;
          continue;
        }
      }
      pushUnknownDiag(
        diagnostics,
        "E_UNKNOWN_ATOM",
        "Unknown token",
        node,
        trackName,
      );
      i++;
      continue;
    }

    // ── List items ───────────────────────────────────────────────────────
    if (node.kind === "list") {
      if (node.items.length === 0) {
        pushUnknownDiag(
          diagnostics,
          "E_UNKNOWN_LIST",
          "Unknown list form",
          node,
          trackName,
        );
        i++;
        continue;
      }
      const head = atomValue(node.items[0]);
      if (!head) {
        pushUnknownDiag(
          diagnostics,
          "E_UNKNOWN_LIST",
          "Unknown list form",
          node,
          trackName,
        );
        i++;
        continue;
      }

      // Tuplet: (t elem …) divides one current :len slot among its notes and
      // rests using Bresenham distribution (remainders spread evenly). The
      // body is an ordinary channel body but for where its notes get a length.
      if (head === "t") {
        const elems = node.items.slice(1).filter((ev) => ev?.kind !== "comment");
        const n = tupletNotes(elems, diagnostics, trackName);
        if (n === 0) {
          pushDiag(diagnostics, "error", "E_TUPLET_EMPTY", "(t …) needs at least one note or rest", nodeSrc(node), trackName);
          i++;
          continue;
        }
        if (n > 0) {
          trackState.tuplet = { total: trackState.defaultLength, n, acc: 0 };
          compileChannelBody(elems, trackState, events, diagnostics, trackName, typedDefs, loopCounter, vals, evalEnv);
          trackState.tuplet = null;
        } else trackState.tick += trackState.defaultLength; // refused: the rest of the score stays in place
        i++;
        continue;
      }

      // Repeat loop: (x N ...) counts N times; (x ...) loops forever
      // (break) inside the body emits LOOP_BREAK linked to this loop's id
      if (head === "x") {
        const countNode = node.items[1];
        const countValue = isConstNumberNode(countNode, evalEnv)
          ? readConstNumber(countNode, evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs)
          : null;
        const maybeCount = countValue == null ? (countValue === undefined ? 1 : null) : Math.round(countValue);
        const bodyStart = maybeCount !== null ? 2 : 1;
        // "(x N)" has a space and parens, so no `#name` can spell it (§13).
        const loopId = `(x ${loopCounter.count++})`;
        const savedLoopId = trackState.currentLoopId;
        // Only counted loops support (break); inside an infinite (x …) it still
        // binds to the innermost COUNTED loop around it (§13).
        trackState.currentLoopId = maybeCount !== null ? loopId : savedLoopId;
        const loopSrc = nodeSrc(node.items[0]);
        const compileBody = () =>
          compileChannelBody(
            node.items.slice(bodyStart),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            evalEnv,
          );
        if (maybeCount !== null) {
          const phaseIn = trackState.shufflePhase;
          const shuffleIn = trackState.shuffle;
          events.push({ tick: trackState.tick, cmd: "LOOP_BEGIN", args: { id: loopId }, src: loopSrc });
          const bodyIdx = events.length;
          compileBody();
          // The loop whose pass is the last one: what follows goes on from it.
          let lastId = loopId;
          let lastCount = maybeCount;
          let lastIn = phaseIn;
          const k = maybeCount > 1 ? shufflePasses(trackState, phaseIn, shuffleIn, events, bodyIdx) : 1;
          if (k === null) shuffleLoopWarning(diagnostics, "(x …) body", loopSrc, trackName);
          if (k > 1) {
            // A body that leaves the shuffle cycle elsewhere plays its next
            // pass on other steps, and the IR holds one body: write the loop
            // k passes to a turn (each compiled again where the last left),
            // and the passes left over after it as a loop of one. The (break)
            // is kept only where the loop's last pass meets it.
            const diagLen = diagnostics.length;
            const turns = Math.floor(maybeCount / k);
            const left = maybeCount % k;
            const firstPasses = turns > 0 ? k : left;
            const passEnds = [events.length];
            for (let n = 1; n < firstPasses; n++) {
              compileBody();
              passEnds.push(events.length);
            }
            const keepInFirst = turns === 0 || left === 0;
            dropLoopBreaks(events, bodyIdx, keepInFirst ? passEnds.at(-2) ?? bodyIdx : events.length, loopId);
            if (!keepInFirst) {
              trackState.loopBreaks?.delete(loopId);
              trackState.loopBreakPhase?.delete(loopId);
            }
            connectAcrossJump(trackState, events, bodyIdx);
            events.push({
              tick: trackState.tick,
              cmd: "LOOP_END",
              args: { id: loopId, repeat: turns > 0 ? turns : 1 },
              src: loopSrc,
            });
            lastCount = turns > 0 ? turns : 1;
            lastIn = trackState.shufflePhase;
            if (turns > 0 && left > 0) {
              lastId = `(x ${loopCounter.count++})`;
              trackState.currentLoopId = lastId;
              lastIn = trackState.shufflePhase;
              lastCount = 1;
              events.push({ tick: trackState.tick, cmd: "LOOP_BEGIN", args: { id: lastId }, src: loopSrc });
              const leftIdx = events.length;
              let lastStart = leftIdx;
              for (let n = 0; n < left; n++) {
                lastStart = events.length;
                compileBody();
              }
              dropLoopBreaks(events, leftIdx, lastStart, lastId);
              events.push({ tick: trackState.tick, cmd: "LOOP_END", args: { id: lastId, repeat: 1 }, src: loopSrc });
            }
            diagnostics.length = diagLen; // the copies repeat the first pass's
          } else {
            // A `~` ending the body also connects it to the body's head on the
            // passes that loop back.
            connectAcrossJump(trackState, events, bodyIdx);
            events.push({
              tick: trackState.tick,
              cmd: "LOOP_END",
              args: { id: loopId, repeat: maybeCount },
              src: loopSrc,
            });
          }
          trackState.currentLoopId = savedLoopId;
          // With a (break) the last pass never reaches the tail: the loop is
          // left from the break, so the next note connects to what was sounding
          // there (a ~ / glide / tie from the tail would reach a note the
          // player never came from).
          const brk = trackState.loopBreaks?.get(lastId);
          if (brk) {
            restoreConnectionState(trackState, brk);
            trackState.loopBreaks.delete(lastId);
          }
          // The shuffle cycle goes on from where the last pass leaves — from
          // its (break), when it has one. A loop written k passes to a turn
          // comes back each turn; one played as written moves on a pass's
          // shift each pass — or none, when the body sets the shuffle (every
          // pass plays as the first).
          const sh = trackState.shuffle;
          if (sh) {
            const out = trackState.loopBreakPhase?.get(lastId);
            const shift = trackState.shufflePhase - lastIn;
            const phase = sh !== shuffleIn ? out ?? trackState.shufflePhase
              : out != null ? out + shift * (lastCount - 1) : lastIn + shift * lastCount;
            trackState.shufflePhase = ((phase % sh.cycle) + sh.cycle) % sh.cycle;
          }
          trackState.loopBreakPhase?.delete(lastId);
        } else {
          const phaseIn = trackState.shufflePhase;
          const shuffleIn = trackState.shuffle;
          events.push({ tick: trackState.tick, cmd: "MARKER", args: { id: loopId }, src: loopSrc });
          const bodyIdx = events.length;
          compileBody();
          // Off the cycle on the next pass: loop as many passes at a time as
          // it takes to come back.
          const k = shufflePasses(trackState, phaseIn, shuffleIn, events, bodyIdx);
          if (k === null) shuffleLoopWarning(diagnostics, "(x …) body", loopSrc, trackName);
          if (k > 1) {
            const diagLen = diagnostics.length;
            for (let n = 1; n < k; n++) compileBody();
            diagnostics.length = diagLen;
          }
          trackState.currentLoopId = savedLoopId;
          events.push({ tick: trackState.tick, cmd: "JUMP", args: { to: loopId }, src: loopSrc });
        }
        i++;
        continue;
      }

      // Jump: (go label) infinite, (go label N) repeats the #label..go section
      // N times then falls through (same loop as (x N …); see convertCountedJumps).
      if (head === "go") {
        const label = atomValue(node.items[1]);
        if (!label) {
          pushDiag(
            diagnostics,
            "error",
            "E_GO_NO_LABEL",
            "go requires a label",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        if (node.items.length < 2 || node.items.length > 3) {
          pushDiag(
            diagnostics,
            "error",
            "E_GO_ARITY",
            "go takes a label and an optional repeat count: (go label [N])",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        let repeat = null;
        if (node.items.length === 3) {
          const r = readConstNumber(node.items[2], evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs);
          repeat = r == null || !Number.isInteger(r) ? null : r;
          if (repeat === null || repeat < 1) {
            pushDiag(
              diagnostics,
              "error",
              "E_GO_COUNT",
              "go repeat count must be a positive integer",
              nodeSrc(node.items[0]),
              trackName,
            );
            i++;
            continue;
          }
        }
        // A section that leaves the shuffle cycle elsewhere: an endless one
        // written in these items loops as many passes at a time as it takes
        // to come back, as (x …) does; any other cannot be copied here, so it
        // is flagged.
        const target0 = events.findIndex((e) => e.cmd === "MARKER" && e.args?.id === label);
        const atLabel = trackState.labelPhase?.get(label);
        if (atLabel && atLabel.shuffle === trackState.shuffle && atLabel.phase !== trackState.shufflePhase) {
          const at = labelsHere.get(label);
          const k = target0 >= 0 ? shufflePasses(trackState, atLabel.phase, atLabel.shuffle, events, target0 + 1) : null;
          if (repeat === null && at != null && k !== null) {
            const diagLen = diagnostics.length;
            for (let n = 1; n < k; n++)
              compileChannelBody(items.slice(at + 1, i), trackState, events, diagnostics,
                trackName, typedDefs, loopCounter, vals, evalEnv);
            diagnostics.length = diagLen;
          } else shuffleLoopWarning(diagnostics, `#${label} section`, nodeSrc(node.items[0]), trackName);
        }
        // A `~` before the jump connects to the label's first note.
        const target = events.findIndex(
          (e) => e.cmd === "MARKER" && e.args?.id === label,
        );
        if (target >= 0) connectAcrossJump(trackState, events, target + 1);
        events.push({
          tick: trackState.tick,
          cmd: "JUMP",
          args: repeat !== null ? { to: label, repeat } : { to: label },
          src: nodeSrc(node.items[0]),
        });
        i++;
        continue;
      }

      // Loop break: (break) — on the final pass of the innermost counted loop,
      // exit here. Id is the current (x …) loop, or null inside a
      // `#label …(go label N)` loop where convertCountedJumps assigns it after
      // the forms merge.
      if (head === "break") {
        if (node.items.length !== 1) {
          pushDiag(
            diagnostics,
            "error",
            "E_BREAK_ARITY",
            "break takes no arguments: (break)",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        // The last pass leaves the loop HERE, so what follows the loop is
        // connected to this point, not to the body's tail (see (x N …)).
        if (trackState.currentLoopId) {
          (trackState.loopBreaks ??= new Map()).set(
            trackState.currentLoopId,
            connectionState(trackState),
          );
          (trackState.loopBreakPhase ??= new Map()).set(
            trackState.currentLoopId,
            trackState.shufflePhase,
          );
        }
        events.push({
          tick: trackState.tick,
          cmd: "LOOP_BREAK",
          args: { id: trackState.currentLoopId ?? null },
          src: nodeSrc(node),
        });
        i++;
        continue;
      }

      // Trigger: (trig N) — a music→game sync point. Emits TRIG with an
      // explicit id N (0..63); the driver writes it into the track's
      // 68k-readable status byte (opcodes.md §0x42) for the game to read.
      if (head === "trig") {
        if (node.items.length !== 2) {
          pushDiag(
            diagnostics,
            "error",
            "E_TRIG_ARITY",
            "trig takes one id: (trig N), N = 0..63",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        const t = readConstNumber(node.items[1], evalEnv, diagnostics, trackName, nodeSrc(node), typedDefs);
        const code = t == null || !Number.isInteger(t) ? null : t;
        if (code === null || code < 0 || code > 63) {
          pushDiag(
            diagnostics,
            "error",
            "E_TRIG_RANGE",
            "trig id must be an integer 0..63 (MB_TSTAT is 6 bits)",
            nodeSrc(node.items[0]),
            trackName,
          );
          i++;
          continue;
        }
        events.push({
          tick: trackState.tick,
          cmd: "TRIG",
          args: { code },
          src: nodeSrc(node),
        });
        i++;
        continue;
      }

      // Echo: (echo [N] :vel+|:vel* V [:back B]) — replays the note B back
      // (B=1 = the last) as taps that lengthen the phrase. mucom `\=n1,n2` ≡
      // (echo 1 :vel+ -n2 :back n1).
      // Delay: (delay [N] :vel+|:vel* V :time T) — sticky; every following
      // note gets taps overlaid at +k·T (expandTrackDelays); (delay none) and
      // (delay :vel none) clear it. Both read V the same way (readTapArgs).
      if (head === "echo" || head === "delay") {
        const items = node.items.filter((n) => n.kind !== "comment");
        const isDelay = head === "delay";
        if (isDelay && (atomValue(items[1]) === "none" ||
          (/^:vel[+*]?$/.test(atomValue(items[1]) ?? "") && atomValue(items[2]) === "none"))) {
          trackState.delaySpec = null;
          trackState.delayTicks = 0;
          i++;
          continue;
        }
        const tap = readTapArgs(head, items, evalEnv,
          makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs), diagnostics, trackName, nodeSrc(node));
        if (tap && isDelay) {
          const time = tap.opts[":time"], timeNode = tap.optNodes[":time"];
          // a length token, or a length expression — `(ticks 48)`, `(* 2 8)` (§7.4)
          const ticks = timeNode?.kind === "list"
            ? resolveLengthNode(timeNode, 0, trackState, makeEvalCtx(diagnostics, trackName, nodeSrc(node), typedDefs), evalEnv)
            : time == null ? null : parseLengthToken(time, null, trackState.currentTempo);
          if (ticks > 0) {
            trackState.delaySpec = tap.spec;
            trackState.delayTicks = ticks;
          } else {
            pushDiag(diagnostics, "error", "E_DELAY_ARGS",
              "(delay …) needs :time T, the spacing of its taps", nodeSrc(items[0]), trackName);
          }
        } else if (tap) {
          const back = Math.max(1, parseIntLike(tap.opts[":back"]) ?? 1);
          // Echo replays a note already written; before the first one it has
          // nothing to play — likely meant as (delay …), which is sticky.
          if (!trackState.recentNotes?.length)
            pushDiag(diagnostics, "warning", "W_ECHO_NO_NOTE",
              "(echo …) replays a note written before it, and there is none yet; " +
                "for an echo on every following note, write (delay … :time T)",
              nodeSrc(items[0]), trackName);
          emitEchoReplay(trackState, events, tap.spec, back, nodeSrc(node));
        }
        i++;
        continue;
      }

      // Glide: (glide <time>) portamento from the previous note;
      // (glide <from-pitch> <time>) sets an explicit start pitch; (glide none) off.
      if (head === "glide") {
        if (
          pcmRejectsPitch(
            trackState,
            "(glide …)",
            diagnostics,
            nodeSrc(node),
            trackName,
          )
        ) {
          i++;
          continue;
        }
        const items = node.items;
        const has2 = items.length >= 3;
        if (has2) trackState.glideFrom = atomValue(items[1]);
        const tv = atomValue(items[has2 ? 2 : 1]);
        // `none` disables glide (off-unification: none = clear a feature).
        const t =
          tv === "none"
            ? 0
            : parseLengthToken(tv, null, trackState.currentTempo);
        if (t !== null) trackState.glide = Math.max(0, t);
        else
          pushDiag(diagnostics, "warning", "W_GLIDE_INVALID",
            `(glide …) takes a length or none, not ${tv ?? "nothing"}; the glide is unchanged`,
            nodeSrc(items[has2 ? 2 : 1] ?? node), trackName);
        i++;
        continue;
      }

      // Macro: (macro :target spec [:target spec …] [:step clk]) inline envelope;
      // (macro none) clears all, (macro :vel none) clears one; bare def names and
      // def references may be mixed in. Runtime within-note envelope.
      if (head === "macro") {
        // A named macro is a snippet, so `(macro pluck :pan …)` arrives as a
        // `(macro …)` nested in this one: it applies first, with its own
        // :step, as it would written on its own.
        const applyMacroForm = (form) => {
        const rest = form.items.slice(1).filter((n) => n.kind !== "comment");
        if (rest.length === 1 && atomValue(rest[0]) === "none") {
          trackState.activeMacros = {};
          return;
        }
        let j = 0;
        // :step is position-free — one per macro applies to every target.
        const macroStep = extractMacroStep(rest, diagnostics, trackName);
        while (j < rest.length) {
          const sym = atomValue(rest[j]);
          const group = macroTargetGroup(rest[j]);
          if (sym === ":step") {
            j += j + 1 < rest.length ? 2 : 1; // consumed above
          } else if (group || sym?.startsWith(":")) {
            if (j + 1 < rest.length) {
              const isClear = atomValue(rest[j + 1]) === "none";
              // Target group [:tl1 :tl2 ...] applies the one spec (or clear)
              // to every keyword — sugar for writing the pair per target.
              for (const groupSym of group ?? [sym]) {
                let { target, op } = macroKeyword(groupSym);
                // A `:mode` macro on a part whose modes are its mixer's (the
                // SSG's) steps the mixer.
                if (target === "NOISE_MODE" && trackState.part?.modes?.tone?.[0] === "SSG_MIX") target = "SSG_MIX";
                else if (target === "SSG_MIX") target = null; // reached by :mode alone
                // A keyword that names no target is a typo, as it is inline
                // (E_UNKNOWN_KEYWORD) — never a macro that silently drops.
                if (!MACRO_TARGETS.has(target)) {
                  pushDiag(diagnostics, "error", "E_MACRO_TARGET",
                    namedCc(target) ?? `${groupSym} is not a macro target (language.md §10 lists them)`,
                    nodeSrc(rest[j]), trackName);
                  continue;
                }
                // A macro runs from a note's key-on; the song's own values
                // are not a note's. A looping sweep moves them over time.
                if (SONG_TARGETS.has(target) && !trackState.part?.songMacros?.(target)) {
                  pushDiag(diagnostics, "error", "E_MACRO_TARGET",
                    `${groupSym} is the song's, not a note's, so it takes no macro — sweep it instead (${groupSym} (sin …))`,
                    nodeSrc(rest[j]), trackName);
                  continue;
                }
                const lacks = targetLacks(target, groupSym, trackState.target);
                if (lacks) {
                  targetDiag(diagnostics, "error", lacks, nodeSrc(rest[j]), trackName);
                  continue;
                }
                const chLacks = trackLacks(target, groupSym, trackState);
                if (chLacks) {
                  pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET", chLacks, nodeSrc(rest[j]), trackName);
                  continue;
                }
                if (isClear) {
                  clearMacroTarget(trackState, target);
                  continue;
                }
                const spec = parseMacroSpec(
                  rest[j + 1],
                  target,
                  diagnostics,
                  trackName,
                  !op,
                  evalEnv,
                  macroStep,
                  op === "*",
                  trackState.part?.modes,
                  trackState.waves,
                );
                if (spec && macroStep) spec.step = macroStep;
                if (target === "WAVE")
                  for (const ix of new Set(spec?.steps ?? []))
                    if (trackState.waves?.[ix]) warnWaveLen(trackState, trackState.waves[ix].name, trackState.waves[ix].data, nodeSrc(rest[j + 1]), diagnostics, trackName);
                if (
                  spec &&
                  op &&
                  !macroOpOk(target, op, groupSym, diagnostics, trackName)
                ) {
                  // +/* misused — diagnostic pushed; drop this entry.
                } else {
                  if (spec && op) spec.op = op;
                  applyMacroEntryToState(trackState, target, spec, {
                    diagnostics,
                    src: nodeSrc(node),
                    trackName,
                    keyword: groupSym,
                  });
                }
              }
              j += 2;
            } else j++;
          } else if (rest[j].kind === "list" && atomValue(rest[j].items?.[0]) === "macro") {
            applyMacroForm(rest[j]);
            j++;
          } else {
            pushDiag(diagnostics, "error", "E_MACRO_VALUE_INVALID",
              `${sym ?? "(…)"} is not a :target, a target group or a named macro`,
              nodeSrc(rest[j]), trackName);
            j++;
          }
        }
        };
        applyMacroForm(node);
        i++;
        continue;
      }

      // Param set: (param-set :target value ...)
      if (head === "param-set") {
        let j = 1;
        while (j + 1 < node.items.length) {
          const targetNode = node.items[j];
          const valueNode = node.items[j + 1];
          const target = canonicalTarget(atomValue(targetNode));
          // Value may be a compile-time eval form: (param-set :tl1 (+ 20 10)).
          let value;
          if (
            valueNode?.kind === "list" &&
            valueNode.bracket === "()" &&
            isEvalHead(atomValue(valueNode.items?.[0]))
          ) {
            const scalar = evalScalarValue(
              valueNode,
              evalEnv,
              makeEvalCtx(diagnostics, trackName, nodeSrc(targetNode), typedDefs),
            );
            value = scalar === null ? 0 : Math.round(scalar);
          } else {
            const bound = lookupBound(evalEnv, atomValue(valueNode));
            value =
              typeof bound === "number"
                ? Math.round(bound)
                : parseIntLike(atomValue(valueNode)) ?? 0;
          }
          const lacks = targetLacks(target, atomValue(targetNode), trackState.target);
          const chLacks = lacks ? null : trackLacks(target, atomValue(targetNode), trackState);
          if (lacks) {
            targetDiag(diagnostics, "error", lacks, nodeSrc(targetNode), trackName);
          } else if (chLacks) {
            pushDiag(diagnostics, "error", "E_UNSUPPORTED_TARGET", chLacks, nodeSrc(targetNode), trackName);
          } else if (!PARAM_SET_TARGETS.has(target)) {
            pushDiag(
              diagnostics,
              "error",
              "E_UNSUPPORTED_TARGET",
              `Unsupported param-set target: ${target}`,
              nodeSrc(targetNode),
              trackName,
            );
          } else if (VEL_SENS_TARGETS.has(target)) {
            writeVelSens(target, atomValue(targetNode), null, valueNode, evalEnv, vals,
              (cmd, args) => events.push({ tick: trackState.tick, cmd, args, src: nodeSrc(targetNode) }),
              diagnostics, nodeSrc(targetNode), trackName, typedDefs);
          } else if (PCM_POINT_TARGETS.has(target)) {
            // The same length reading and pcm-track check as the inline write.
            writePcmPoint(target, atomValue(targetNode), null, valueNode, trackState,
              (cmd, args) => events.push({ tick: trackState.tick, cmd, args, src: nodeSrc(targetNode) }),
              diagnostics, nodeSrc(targetNode), trackName, evalEnv);
          } else {
            events.push({
              tick: trackState.tick,
              cmd: "PARAM_SET",
              args: { target, value },
              src: nodeSrc(targetNode),
            });
          }
          j += 2;
        }
        i++;
        continue;
      }

      // Item-position `let` (§7): bind, then compile the body in the extended
      // env, spliced in place so sticky state behaves as if unwrapped.
      if (head === "let") {
        // A binding may carry a `$` (a runtime value, lowered where it is
        // written); with no parameter here, `$<param>` is not a self-read.
        const childEnv = evalLet(
          node,
          evalEnv,
          valueCtx(null, vals, diagnostics, trackName, nodeSrc(node), typedDefs),
        );
        if (childEnv) {
          compileChannelBody(
            node.items.slice(2).filter((n) => n.kind !== "comment"),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            childEnv,
          );
        }
        i++;
        continue;
      }

      // Item-position `for` (§7.5): the body compiled once a pass, in place,
      // each pass in its own env — as if every pass were written out.
      if (head === "for") {
        const envs = evalFor(
          node,
          evalEnv,
          valueCtx(null, vals, diagnostics, trackName, nodeSrc(node), typedDefs),
        );
        for (const passEnv of envs ?? []) {
          compileChannelBody(
            node.items.slice(2).filter((n) => n.kind !== "comment"),
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            passEnv,
          );
        }
        i++;
        continue;
      }

      // Item-position `if` (§7.6): the chosen branch compiled in place, as if
      // it alone were written; no else and a false test write nothing.
      if (head === "if") {
        const branch = evalIf(
          node,
          evalEnv,
          valueCtx(null, vals, diagnostics, trackName, nodeSrc(node), typedDefs),
        );
        if (branch?.length) {
          compileChannelBody(
            branch,
            trackState,
            events,
            diagnostics,
            trackName,
            typedDefs,
            loopCounter,
            vals,
            evalEnv,
          );
        }
        i++;
        continue;
      }

      // `(note expr [len])` (§7.3): a computed absolute-pitch NOTE_ON.
      if (head === "note") {
        emitEvalNote(node, trackState, events, diagnostics, trackName, typedDefs, evalEnv);
        i++;
        continue;
      }

      if (head && ALL_CHANNEL_NAMES.has(head)) {
        // A def that holds channel forms is a section: written at the top
        // level, not in a track (language.md §9).
        pushDiag(diagnostics, "error", "E_UNKNOWN_LIST",
          `(${head} …) is a channel form, not a track's item; a def that holds channel forms is written at the top level`,
          nodeSrc(node.items[0]), trackName);
        i++;
        continue;
      }
      pushUnknownDiag(
        diagnostics,
        "E_UNKNOWN_LIST",
        "Unknown list form",
        node,
        trackName,
      );
      i++;
      continue;
    }

    pushUnknownDiag(
      diagnostics,
      "E_UNKNOWN_NODE",
      "Unknown channel-body node",
      node,
      trackName,
    );
    i++;
  }
}

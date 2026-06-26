// ---------------------------------------------------------------------------
// mucom88 (.muc) -> MMLisp import (best-effort: FM voices + FM/SSG notes)
//
// mucom88 targets the PC-8801 / YM2608 (OPNA): FM A-C,H-J, SSG D-F, rhythm G,
// ADPCM K. MMLisp targets the Mega Drive (YM2612 FM1-6 + SN76489 PSG). FM maps
// near 1:1; SSG -> PSG square is an approximate pitch/level map; rhythm and
// ADPCM have no target and are dropped with a warning.
//
// This converts MML *text* into MMLisp *source text*. Anything not in the
// supported subset is skipped and reported in `warnings`.
// ---------------------------------------------------------------------------

const PPQN = 96; // must match mmlisp2ir.js
const WHOLE_TICKS = PPQN * 4; // 384 MMLisp ticks per whole note
const DEFAULT_WHOLE_CLOCKS = 128; // mucom C-resolution default (clocks/whole note)

// part letter -> MMLisp channel
const FM_PARTS = { A: "fm1", B: "fm2", C: "fm3", H: "fm4", I: "fm5", J: "fm6" };
const SSG_PARTS = { D: "sqr1", E: "sqr2", F: "sqr3" };

// mucom `D` detune is an F-Number offset, not cents — its pitch shift in cents
// is note-dependent. We approximate with a single representative factor per chip
// from the empirical "units per semitone" (≈49 FM, ≈160 PSG): cents = D*100/units.
// See https://est.ceres.ne.jp/2021/09/04/mucom88-detune/
const FM_CENTS_PER_DETUNE = 100 / 49;
const PSG_CENTS_PER_DETUNE = 100 / 160;
const DROP_PARTS = { G: "rhythm", K: "ADPCM" };

/** Decode .muc bytes (usually Shift-JIS) to a string, UTF-8 fallback. */
export function decodeMucText(bytes) {
  for (const enc of ["shift-jis", "utf-8"]) {
    try {
      return new TextDecoder(enc, { fatal: false }).decode(bytes);
    } catch {
      /* try next */
    }
  }
  // Last resort: latin1-ish
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

// --- length helpers ---------------------------------------------------------

// Convert a mucom length spec to an MMLisp length token.
// Convert a mucom note length to an MMLisp length token. Durations are computed
// on mucom's CLOCK grid (wholeClocks/whole, default 128) exactly as the driver
// does — base = floor(wholeClocks/len), each dot adds floor(prev/2) — then scaled
// to MMLisp ticks. This matters because lengths whose denominator doesn't divide
// wholeClocks (l48, l96, l24, …) are truncated by mucom; emitting the ideal
// fraction instead would drift tracks apart (e.g. l48 ≈ 2.67 clocks → mucom 2).
// A clean fraction is emitted when the grid value equals MMLisp's own fraction;
// otherwise raw `Nt` ticks reproduce mucom's truncation faithfully.
//
// `num` is the fraction (4, 8, …) or null; `dots` the dot count; `pct` the raw
// %clock count or null; `wholeClocks` the active C resolution.
function lengthToken(num, dots, pct, wholeClocks) {
  const factor = WHOLE_TICKS / wholeClocks; // mucom clocks -> MMLisp ticks (128 -> 3)
  if (pct != null) {
    // % is a raw clock count.
    return `${Math.max(1, Math.round(pct * factor))}t`;
  }
  if (num != null) {
    let clocks = Math.floor(wholeClocks / num);
    let add = clocks;
    for (let d = 0; d < dots; d++) { add = Math.floor(add / 2); clocks += add; }
    const ticks = Math.max(1, Math.round(clocks * factor));
    // Prefer the readable fraction when it lands on the exact same tick count
    // MMLisp would compute for it (the common case: len divides wholeClocks).
    if (dots <= 1) {
      const frac = dots ? (WHOLE_TICKS / num) * 1.5 : WHOLE_TICKS / num;
      if (Number.isInteger(frac) && frac === ticks) return dots ? `${num}.` : `${num}`;
    }
    return `${ticks}t`;
  }
  return null;
}

// mucom `t` sets the OPNA Timer-B directly. The realtime tempo also depends on
// the clock resolution C (note clocks per whole note), since note durations are
// counted in those clocks. Derived from the driver itself (pc8801src muc88.asm):
// SETTMP converts T(BPM)->Timer-B as Timer-B = 256 - 3.46*(60000/(T*C/4)), and
// INIT sets the default C=128. Inverting: BPM = 830400 / ((256 - t) * C).
// e.g. t202 -> 120 BPM at C128, but 80 BPM at C192.
function timerBToBpm(t, wholeClocks) {
  t = Math.max(0, Math.min(255, t));
  const denom = (256 - t) * (wholeClocks || DEFAULT_WHOLE_CLOCKS);
  if (denom <= 0) return 120;
  return Math.max(1, Math.round(830400 / denom));
}

// --- MML body tokenizer -----------------------------------------------------

const NOTE_LETTERS = new Set(["a", "b", "c", "d", "e", "f", "g"]);

// Parse one part's MML body string into a nested op tree. Mutates `state`
// (octave/length/vel/wholeClocks) which carries across the part. Returns the
// top-level op list; loops are nested as { t:'loop', count, body }.
function tokenizeBody(body, state, warn, partLetter, macros, depth = 0) {
  const root = [];
  const stack = [root]; // loop nesting; top is current op list
  // A lowercase `t` (Timer-B) tempo's BPM depends on the clock resolution C in
  // effect for the notes it governs, but `C` often follows `t` — on the same
  // line (`t202C192`) or a later one (`t225` alone, then `C192 …`). So defer its
  // conversion until the next note/rest, when state.wholeClocks reflects that C.
  // Kept on `state` so it persists across the part's lines (one call per line).
  state.pendingTempos = state.pendingTempos || [];
  const finalizeTempos = () => {
    if (!state.pendingTempos.length) return;
    for (const tp of state.pendingTempos) tp.bpm = timerBToBpm(tp.timerB, state.wholeClocks);
    state.pendingTempos.length = 0;
  };
  const push = (op) => {
    if (op.t === "note" || op.t === "rest") finalizeTempos();
    stack[stack.length - 1].push(op);
  };
  const isSsg = partLetter in SSG_PARTS;
  // Loop-span state (absent for macro bodies, which are single-line -> all (x)).
  state.decisions = state.decisions || [];
  if (state.decisionIdx == null) state.decisionIdx = 0;
  state.crossStack = state.crossStack || [];
  state.lfo = state.lfo || { on: false, delay: 0, clock: 0, amp: 0, amt: 0 };
  let comment = null; // verbatim `; …` trailing comment, kept for the output line

  let i = 0;
  const n = body.length;
  const readInt = () => {
    let s = "";
    while (i < n && body[i] >= "0" && body[i] <= "9") s += body[i++];
    return s === "" ? null : parseInt(s, 10);
  };
  // A signed integer (for command args that may be negative), then a
  // comma-separated list of them (e.g. `M0,4,2,10`, `H3,4,2`).
  const readSignedInt = () => {
    let sign = 1;
    if (body[i] === "+") i++;
    else if (body[i] === "-") { sign = -1; i++; }
    const v = readInt();
    return v == null ? null : sign * v;
  };
  const readNumList = () => {
    const vals = [];
    for (;;) {
      const v = readSignedInt();
      if (v == null) break;
      vals.push(v);
      if (body[i] === ",") { i++; continue; }
      break;
    }
    return vals;
  };
  const skipSpaces = () => {
    while (i < n && /\s/.test(body[i])) i++;
  };

  while (i < n) {
    const c = body[i];

    if (/\s/.test(c)) { i++; continue; }
    if (c === "|") { i++; continue; } // visual separator
    if (c === ";") { comment = body.slice(i).trim(); break; } // keep the comment

    // Note (lowercase a-g only; uppercase letters are commands like C/D/E). A
    // bare note inherits the :len default, so we emit it bare; only notes that
    // specify a length carry one.
    if (NOTE_LETTERS.has(c)) {
      i++;
      let acc = 0, num = null, dots = 0, pct = null, hasLen = false;
      while (i < n) {
        const d = body[i];
        if (d === "+" || d === "#") { acc += 1; i++; }
        else if (d === "-") { acc -= 1; i++; }
        else if (d === "%") { i++; pct = readInt() ?? 0; hasLen = true; }
        else if (d >= "0" && d <= "9") { num = readInt(); hasLen = true; }
        else if (d === ".") { dots++; i++; hasLen = true; }
        else break;
      }
      const len = hasLen ? lengthToken(num, dots, pct, state.wholeClocks) : null;
      push({ t: "note", letter: c, acc, len });
      continue;
    }

    // Rest (lowercase 'r' only; uppercase 'R' is reverb — see deferred list)
    if (c === "r") {
      i++;
      let num = null, dots = 0, pct = null, hasLen = false;
      while (i < n) {
        const d = body[i];
        if (d === "%") { i++; pct = readInt() ?? 0; hasLen = true; }
        else if (d >= "0" && d <= "9") { num = readInt(); hasLen = true; }
        else if (d === ".") { dots++; i++; hasLen = true; }
        else break;
      }
      push({ t: "rest", len: hasLen ? lengthToken(num, dots, pct, state.wholeClocks) : null });
      continue;
    }

    // Octave: keep the author's relative up/down as MMLisp < / > ; o sets it.
    if (c === "o") { i++; const v = readInt(); if (v != null) push({ t: "octSet", n: Math.max(1, Math.min(8, v)) }); continue; }
    if (c === "<") { i++; push({ t: "octDown" }); continue; }
    if (c === ">") { i++; push({ t: "octUp" }); continue; }

    // Default length l<n>[.] or l%<clocks> -> MMLisp :len
    if (c === "l") {
      i++;
      let token = null;
      if (body[i] === "%") { i++; const p = readInt() ?? 0; token = lengthToken(null, 0, p, state.wholeClocks); }
      else {
        const num = readInt(); let dots = 0;
        while (body[i] === ".") { dots++; i++; }
        if (num != null) token = lengthToken(num, dots, null, state.wholeClocks);
      }
      if (token) push({ t: "lenSet", token });
      continue;
    }

    // `%<clocks>` (SET LIZM): set the default note length directly in clocks,
    // same as l%<clocks>. (As a note/rest suffix `%` is handled in their parsers;
    // this is the standalone command form, e.g. `%1c` = set len 1 clock, then c.)
    if (c === "%") {
      i++;
      const p = readInt();
      if (p != null) push({ t: "lenSet", token: lengthToken(null, 0, p, state.wholeClocks) });
      continue;
    }

    // Whole-note clock resolution
    if (c === "C") { i++; const v = readInt(); if (v != null && v > 0) state.wholeClocks = v; continue; }

    // Tempo: T<bpm> (collected globally); t<timer> deferred
    if (c === "T") { i++; const v = readInt(); if (v != null) push({ t: "tempo", bpm: v }); continue; }
    if (c === "t") { i++; const v = readInt(); if (v != null) { const op = { t: "tempo", timerB: v, bpm: null }; push(op); state.pendingTempos.push(op); } continue; }

    // Volume: v<0-15>, ) raise, ( lower
    if (c === "v") { i++; const v = readInt(); if (v != null) push({ t: "vel", v }); continue; }
    if (c === ")") { i++; const v = readInt() ?? 1; push({ t: "velAdj", d: v }); continue; }
    if (c === "(") { i++; const v = readInt() ?? 1; push({ t: "velAdj", d: -v }); continue; }

    // Pan: p0=off, p1=right, p2=left, p3=center
    if (c === "p") { i++; const v = readInt(); if (v != null) push({ t: "pan", v }); continue; }

    // Quantize/gate: q<n> keys off n clocks early (staccato) -> :gate- (note
    // length minus that time). Sticky like mucom's q.
    if (c === "q") { i++; const n = readInt() ?? 0; push({ t: "gateCut", n, wholeClocks: state.wholeClocks }); continue; }

    // Detune: D<n> absolute / D+<n> relative -> :pitch (value mapped 1:1)
    if (c === "D") {
      i++;
      let rel = false, sign = 1;
      if (body[i] === "+") { rel = true; i++; }
      else if (body[i] === "-") { sign = -1; i++; }
      push({ t: "detune", val: sign * (readInt() ?? 0), rel });
      continue;
    }

    // Macro call *n: keep it as a reference (defined as (def *n …)), not expanded.
    if (c === "*") {
      i++;
      const mn = readInt();
      if (mn != null) push({ t: "macroCall", n: mn });
      continue;
    }

    // Voice select @<n> or by name @"name" (FM only)
    if (c === "@") {
      i++;
      if (body[i] === "%") { i++; readInt(); warnOnce(warn, "@%", "register-dump voice (@%) not supported; dropped"); continue; }
      if (body[i] === '"') {
        i++; let name = "";
        while (i < n && body[i] !== '"') name += body[i++];
        if (body[i] === '"') i++;
        if (!isSsg) push({ t: "voiceByName", name });
        continue;
      }
      const v = readInt();
      if (v != null) {
        if (isSsg) warnOnce(warn, "@ssg", "SSG voice/preset (@n on D-F) has no PSG equivalent; dropped");
        else push({ t: "voice", n: v });
      }
      continue;
    }

    // Loops
    // Loop open. A single-line loop becomes a nested (x …) op; a loop that
    // spans source lines becomes #labelK …(go labelK n) (decided by scanLoopSpans).
    if (c === "[") {
      i++;
      const dec = state.decisions[state.decisionIdx++] || { cross: false };
      if (dec.cross) {
        push({ t: "loopMarker", label: dec.label });
        state.crossStack.push(dec.label);
      } else {
        const body2 = [];
        push({ t: "loop", count: 2, body: body2 });
        stack.push(body2);
      }
      continue;
    }
    if (c === "]") {
      i++; const cnt = readInt();
      if (stack.length > 1) {
        // Close the innermost single-line loop (local nesting).
        stack.pop();
        const parent = stack[stack.length - 1];
        const loop = parent[parent.length - 1];
        if (loop && loop.t === "loop") loop.count = cnt ?? 2;
      } else if (state.crossStack.length > 0) {
        // Close the innermost cross-line loop -> (go labelK n).
        push({ t: "loopGo", label: state.crossStack.pop(), count: cnt ?? 2 });
      } else warnOnce(warn, "]", "unmatched ] loop end; ignored");
      continue;
    }
    if (c === "/") { i++; push({ t: "loopBreak" }); continue; }
    if (c === "L") { i++; push({ t: "globalLoop" }); continue; }

    // Tie: ^, ^<len>, or ^<note><len> (a repeated pitch is a tie continuation —
    // keep only its length). Slur '&' has no tie semantics; drop it.
    if (c === "^") {
      i++;
      let num = null, dots = 0, pct = null, hasLen = false;
      // mucom `^` takes only an optional length; the next letter is the next
      // note, not a redundant pitch — do not consume it.
      while (i < n) {
        const d = body[i];
        if (d === "+" || d === "#" || d === "-") i++;
        else if (d === "%") { i++; pct = readInt() ?? 0; hasLen = true; }
        else if (d >= "0" && d <= "9") { num = readInt(); hasLen = true; }
        else if (d === ".") { dots++; i++; hasLen = true; }
        else break;
      }
      push({ t: "tie", len: hasLen ? lengthToken(num, dots, pct, state.wholeClocks) : null });
      continue;
    }
    if (c === "&") { i++; warnOnce(warn, "&", "slur (&) articulation dropped; notes play separately"); continue; }

    // Portamento {from len to}: a pitch glide occupying one note's time. mucom
    // {c2b} slides c->b over length 2 (octaves may be crossed with < / >). Map to
    // MMLisp's portamento: :glide-from <start> :glide <len> then the target note.
    if (c === "{") {
      i++;
      let bo = 0; // octave shift inside the braces (relative to the running octave)
      const notes = []; // {letter, acc, bo} in order
      let inNum = null, inDots = 0, inPct = null;
      while (i < n && body[i] !== "}") {
        const d = body[i];
        if (NOTE_LETTERS.has(d)) {
          i++;
          let acc = 0;
          while (i < n && (body[i] === "+" || body[i] === "#" || body[i] === "-")) {
            acc += body[i] === "-" ? -1 : 1; i++;
          }
          notes.push({ letter: d.toLowerCase(), acc, bo });
        }
        else if (d === ">") { bo += 1; i++; }
        else if (d === "<") { bo -= 1; i++; }
        else if (d === "%") { i++; inPct = readInt() ?? 0; }
        else if (d >= "0" && d <= "9") { inNum = readInt(); }
        else if (d === ".") { inDots++; i++; }
        else i++;
      }
      if (body[i] === "}") i++;
      // A length after } overrides one inside the braces.
      let num = null, dots = 0, pct = null, hasLen = false;
      while (i < n) {
        const d = body[i];
        if (d === "%") { i++; pct = readInt() ?? 0; hasLen = true; }
        else if (d >= "0" && d <= "9") { num = readInt(); hasLen = true; }
        else if (d === ".") { dots++; i++; hasLen = true; }
        else break;
      }
      const len = hasLen
        ? lengthToken(num, dots, pct, state.wholeClocks)
        : lengthToken(inNum, inDots, inPct, state.wholeClocks);
      if (notes.length >= 2) push({ t: "porta", from: notes[0], to: notes[notes.length - 1], len });
      else if (notes.length === 1) push({ t: "note", letter: notes[0].letter, acc: notes[0].acc, len });
      continue;
    }

    // Echo ¥…/\… : `¥=n,n` defines the echo; a trailing `¥` after a note makes
    // the channel sound a delayed copy of that note (these are the delay/echo
    // channels). It occupies the channel's timeline, so emit an echo note of the
    // same pitch/length — otherwise the channel runs short and drifts.
    if (c === "¥" || c === "\\") {
      i++;
      if (body[i] === "=") { i++; while (i < n && /[0-9$+\-,.]/.test(body[i])) i++; continue; }
      const list = stack[stack.length - 1];
      const last = list[list.length - 1];
      if (last && last.t === "note") push({ t: "note", letter: last.letter, acc: last.acc, len: last.len, echo: true });
      continue;
    }

    // Hardware LFO: H speed,pms,ams -> the YM LFO (:lfo-rate global) plus the
    // per-channel sensitivities (:fms / :ams). FM only (rendered side skips SSG).
    if (c === "H") {
      i++;
      const [speed = 0, pms = 0, ams = 0] = readNumList();
      push({ t: "hwLfo", speed, pms, ams });
      continue;
    }

    // Software LFO (pitch vibrato): M delay,clock,amp,amount defines+enables it;
    // MF on/off; MW/MC/ML/MD set one param. State persists across the part's lines
    // and is emitted as a sticky `:macro :pitch (triangle …)` (cleared by MF 0).
    if (c === "M") {
      i++;
      const sub = (i < n && /[A-Za-z]/.test(body[i])) ? body[i++] : null;
      const nums = readNumList();
      const lfo = state.lfo;
      if (sub === "F") lfo.on = (nums[0] ?? 0) !== 0;
      else if (sub === "W") lfo.delay = nums[0] ?? lfo.delay;
      else if (sub === "C") lfo.clock = nums[0] ?? lfo.clock;
      else if (sub === "L") lfo.amp = nums[0] ?? lfo.amp;
      else if (sub === "D") lfo.amt = nums[0] ?? lfo.amt;
      else {
        lfo.delay = nums[0] ?? 0; lfo.clock = nums[1] ?? 0;
        lfo.amp = nums[2] ?? 0; lfo.amt = nums[3] ?? 0; lfo.on = true;
      }
      push({ t: "lfoSet", lfo: { ...lfo }, wholeClocks: state.wholeClocks });
      continue;
    }

    // Deferred / unsupported commands. Consume each command's FULL argument list
    // so nothing leaks into note/length parsing (a leaked arg becomes a spurious
    // note and drifts the channel). Arg shapes differ per command:
    if ("RyKkSEPwsV".includes(c)) {
      i++;
      warnOnce(warn, c, `command '${c}' not supported; dropped`);
      if (c === "y") {
        // y<reg>,<n>,<n> — register may be a symbolic name (letters) or number
        while (i < n && /[A-Za-z]/.test(body[i])) i++; // register name
        while (i < n && /[0-9$+\-,.]/.test(body[i])) i++; // values
      } else {
        while (i < n && /[0-9$+\-,.]/.test(body[i])) i++;
      }
      continue;
    }

    // Unknown char
    warnOnce(warn, c, `unknown token '${c}'; skipped`);
    i++;
  }

  if (stack.length > 1) warn.push(`part ${partLetter}: unterminated loop '[' — closed at end`);
  // Pending tempos are NOT finalized here: they persist on `state` so a `t` on
  // one line can pick up a `C` (and its first note) on a later line of the part.
  // Any still-pending at the very end are flushed by parseMucom.
  return { ops: root, comment };
}

function warnOnce(warn, key, msg) {
  warn._seen = warn._seen || new Set();
  if (warn._seen.has(key)) return;
  warn._seen.add(key);
  warn.push(msg);
}

// --- voice parsing ----------------------------------------------------------

// Parse all numbers from a voice block, ignoring a quoted "name" and the
// braces/commas. Supports $hex.
function parseVoiceNumbers(text) {
  const out = [];
  for (const tok of text.replace(/"[^"]*"/g, " ").split(/[\s,{}]+/)) {
    if (!tok) continue;
    const v = tok[0] === "$" ? parseInt(tok.slice(1), 16) : parseInt(tok, 10);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

// --- top-level parse --------------------------------------------------------

/**
 * Parse mucom88 MML text into a structured, MMLisp-friendly intermediate.
 * @returns {{ meta:{title,author}, tempo:number|null,
 *             voices: Map<number, {fb,alg,ops:Array}>,
 *             parts: Map<string, Array>, warnings: string[] }}
 */
// Decide, per part letter, whether each `[ … ]` loop closes on the same source
// line it opened (single-line -> (x …)) or spans lines (cross-line -> #label /
// (go label n)). Returns Map<letter, Array<{cross, label}>> in `[` order.
function scanLoopSpans(lines) {
  const decisions = new Map(); // letter -> [{cross, label}]
  const stacks = new Map(); // letter -> [{ line, idx }]
  let crossLabel = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\t/g, " ");
    const pm = line.match(/^([A-K]+)(.*)$/);
    if (!pm) continue;
    let body = pm[2];
    const sc = body.indexOf(";");
    if (sc >= 0) body = body.slice(0, sc); // ignore brackets inside comments
    for (const letter of pm[1]) {
      if (letter in DROP_PARTS) continue;
      if (!(letter in FM_PARTS) && !(letter in SSG_PARTS)) continue;
      let dec = decisions.get(letter);
      if (!dec) { dec = []; decisions.set(letter, dec); }
      let st = stacks.get(letter);
      if (!st) { st = []; stacks.set(letter, st); }
      for (const ch of body) {
        if (ch === "[") { st.push({ line: li, idx: dec.length }); dec.push({ cross: false, label: null }); }
        else if (ch === "]") {
          const open = st.pop();
          if (open && open.line !== li) { dec[open.idx].cross = true; dec[open.idx].label = `loop${++crossLabel}`; }
        }
      }
    }
  }
  return decisions;
}

export function parseMucom(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const meta = { title: null, composer: null, author: null, voiceFile: null };
  const voices = new Map();
  // The music in source order: one item per source line. A part line becomes a
  // { kind:"form", letter, ops, comment } (one per letter); an in-music comment
  // line becomes { kind:"comment", text }. Emitted verbatim top-to-bottom.
  const scoreItems = [];
  const droppedOps = []; // ops from dropped parts (G/K) — scanned only for tempo
  const macros = new Map(); // *n -> { ops, comments }
  const warnings = [];
  const pendingComments = []; // full-line comments awaiting the next def/section
  let scoreComments = []; // comments just before the parts, kept above (score …)
  let sawPart = false;
  const state = new Map(); // per-part scanner state

  // Macros (`*n`) are text-substituted in mucom, so their direct-clock lengths
  // (`%`) resolve against the caller's C. Macros are tokenized once, before the
  // parts set C, so seed them with the song's first C (most songs use one).
  const songClocks = (() => {
    const m = text.match(/(?<![A-Za-z])C(\d+)/);
    return m ? parseInt(m[1], 10) : DEFAULT_WHOLE_CLOCKS;
  })();

  // Pre-scan loop brackets per part: a `[ … ]` whose `[` and `]` are on
  // different source lines can't be a single `(x …)` form (we split each line
  // into its own (chN …) form), so it's emitted as `#labelK …(go labelK n)`
  // which spans forms. Returns, per letter, the decision for each `[` in order.
  const loopDecisions = scanLoopSpans(lines);

  const partState = (letter) => {
    if (!state.has(letter)) {
      state.set(letter, {
        wholeClocks: DEFAULT_WHOLE_CLOCKS,
        decisions: loopDecisions.get(letter) || [],
        decisionIdx: 0,
        crossStack: [], // open cross-line loops (labels), persists across lines
        lfo: { on: false, delay: 0, clock: 0, amp: 0, amt: 0 }, // software LFO (M), persists across lines
      });
    }
    return state.get(letter);
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, " ");
    const trimmed = line.trim();
    i++;

    if (trimmed === "") continue;
    // Comments before the music attach to the next def / score header; comments
    // inside the music stay in place, in source order.
    if (trimmed.startsWith(";")) {
      if (sawPart) scoreItems.push({ kind: "comment", text: trimmed });
      else pendingComments.push(trimmed);
      continue;
    }

    // Macro definition: # *n{ … } — store its body, expanded where *n is used.
    const mac = trimmed.match(/^#\s*\*(\d+)\s*\{(.*)$/);
    if (mac) {
      let content = mac[2];
      while (!content.includes("}") && i < lines.length) { content += "\n" + lines[i]; i++; }
      content = content.slice(0, content.indexOf("}")).trim();
      const { ops } = tokenizeBody(content, { wholeClocks: songClocks }, warnings, "*", macros);
      macros.set(parseInt(mac[1], 10), { ops, comments: pendingComments.splice(0) });
      continue;
    }

    // Header directives: #Title, #Composer/#Author, #Option, ...
    if (trimmed.startsWith("#")) {
      const m = trimmed.match(/^#(\w+)\s+(.*)$/);
      if (m) {
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === "title") meta.title = val;
        else if (key === "composer") meta.composer = val;
        else if (key === "author") meta.author = val;
        else if (key === "voice") meta.voiceFile = val; // external @"name" bank (.dat)
      }
      continue;
    }

    // Voice definition: @N:{ FB,AL + 4 operator lines, optional trailing "name" }
    // (also accepts the brace-less form: numbers across the following lines).
    const vm = trimmed.match(/^@(%?)(\d+)/);
    if (vm) {
      if (vm[1] === "%") {
        warnOnce(warnings, "@%def", "register-dump voice defs (@%) not supported; dropped");
        while (i < lines.length && /^[\s$0-9]/.test(lines[i]) && lines[i].trim() !== "") i++;
        continue;
      }
      const num = parseInt(vm[2], 10);
      let block = trimmed.replace(/^@\d+\s*:?\s*/, "");
      if (block.startsWith("{")) {
        while (i < lines.length && !block.includes("}")) { block += "\n" + lines[i]; i++; }
      } else {
        while (i < lines.length && parseVoiceNumbers(block).length < 38) {
          const l2 = lines[i];
          if (l2.trim() === "" || /^[A-K@#;]/.test(l2.trim())) break;
          block += "\n" + l2;
          i++;
        }
      }
      const name = (block.match(/"([^"]*)"/) || [])[1] || null;
      const nums = parseVoiceNumbers(block);
      if (nums.length >= 38) {
        const fb = nums[0], alg = nums[1];
        const ops = [];
        for (let op = 0; op < 4; op++) {
          const b = 2 + op * 9;
          ops.push({
            ar: nums[b], dr: nums[b + 1], sr: nums[b + 2], rr: nums[b + 3],
            sl: nums[b + 4], tl: nums[b + 5], ks: nums[b + 6], ml: nums[b + 7], dt: nums[b + 8],
          });
        }
        voices.set(num, { fb, alg, ops, name, comments: pendingComments.splice(0) });
      } else {
        warnings.push(`voice @${num}: expected 38 numbers, got ${nums.length}; skipped`);
      }
      continue;
    }

    // Part line: leading letters A-K, then MML body.
    const pm = line.match(/^([A-K]+)(.*)$/);
    if (pm) {
      if (!sawPart) { scoreComments = pendingComments.splice(0); sawPart = true; }
      const letters = pm[1];
      const bodyStr = pm[2];
      for (const letter of letters) {
        if (letter in DROP_PARTS) {
          warnOnce(warnings, `part${letter}`, `part ${letter} (${DROP_PARTS[letter]}) not supported; dropped`);
          // The song's tempo (t/T) often lives on a dropped part (rhythm/ADPCM
          // usually comes first), so still tokenize to recover it — discard the
          // rest and its warnings.
          const { ops } = tokenizeBody(bodyStr, partState(letter), [], letter, macros);
          droppedOps.push(...ops);
          continue;
        }
        if (!(letter in FM_PARTS) && !(letter in SSG_PARTS)) continue;
        const ch = FM_PARTS[letter] || SSG_PARTS[letter];
        const { ops, comment } = tokenizeBody(bodyStr, partState(letter), warnings, letter, macros);
        // A multi-letter line shares one trailing comment; keep it on the first.
        scoreItems.push({ kind: "form", letter, ch, ops, comment: letter === letters[0] ? comment : null });
      }
      continue;
    }
    // otherwise: stray line, ignore
  }

  // Flush any tempo still pending at end of a part (no note ever followed it):
  // resolve it against that part's final clock resolution.
  for (const st of state.values()) {
    if (st.pendingTempos?.length) {
      for (const tp of st.pendingTempos) tp.bpm = timerBToBpm(tp.timerB, st.wholeClocks);
      st.pendingTempos.length = 0;
    }
  }

  // The song's initial tempo seeds the score header (a tempo on a dropped part
  // can only live here). Mid-song changes are emitted inline by renderOps, so
  // multiple tempos are expected — not an error.
  let tempo = null;
  const tempoSources = [...scoreItems.filter((it) => it.kind === "form").map((it) => it.ops), droppedOps];
  for (const ops of tempoSources) {
    const t = findFirstTempo(ops);
    if (t != null) { tempo = t; break; }
  }
  if (warnings._seen) delete warnings._seen;
  return { meta, tempo, voices, macros, scoreItems, scoreComments, warnings };
}

// True if the first sounding/octave op is an absolute `o` set — then the source
// establishes the octave itself and we don't prepend a base.
function startsWithAbsoluteOctave(ops) {
  for (const op of ops) {
    if (op.t === "octSet") return true;
    if (op.t === "note" || op.t === "rest" || op.t === "tie" || op.t === "octUp" || op.t === "octDown") return false;
    if (op.t === "loop") return startsWithAbsoluteOctave(op.body);
  }
  return false;
}

function findFirstTempo(ops) {
  for (const op of ops) {
    if (op.t === "tempo") return op.bpm;
    if (op.t === "loop") { const t = findFirstTempo(op.body); if (t != null) return t; }
  }
  return null;
}

// --- MMLisp generation ------------------------------------------------------

const ACC = (acc) => (acc > 0 ? "+" : acc < 0 ? "-" : "");

// Emit `body` repeated `count` times as a compact (x N …). A `/` break in the
// body becomes MMLisp `:break` (final pass exits there). N==1 plays once (no
// redundant `(x 1 …)`) — exiting at the break since it's the only/final pass.
function emitLoop(out, count, body, ctx, depth) {
  if (count <= 0) return;
  if (count === 1) {
    const bi = body.findIndex((o) => o.t === "loopBreak");
    renderOps(bi >= 0 ? body.slice(0, bi) : body, ctx, out, depth);
    return;
  }
  const inner = [];
  renderOps(body, ctx, inner, depth + 1);
  if (inner.length) out.push(`(x ${count} ${inner.join(" ")})`);
}

function renderOps(ops, ctx, out, depth = 0) {
  for (const op of ops) {
    switch (op.t) {
      case "note":
        out.push(`${op.letter}${ACC(op.acc)}${op.len ?? ""}`);
        break;
      case "rest":
        out.push(`_${op.len ?? ""}`);
        break;
      case "tie":
        // '~' and length are separate atoms in MMLisp; bare '~' uses :len.
        out.push(op.len ? `~ ${op.len}` : "~");
        break;
      case "octUp":
        out.push(">"); ctx.oct++;
        break;
      case "octDown":
        out.push("<"); ctx.oct--;
        break;
      case "octSet":
        // mucom FM octaves read one higher than MMLisp's (drop one); SSG/PSG use
        // a different frequency table and need no shift.
        ctx.oct = op.n - (ctx.isSsg ? 0 : 1);
        out.push(`:oct ${ctx.oct}`);
        break;
      case "pan":
        // mucom p: 0=off,1=right,2=left,3=center -> MMLisp :pan
        out.push(`:pan ${{ 1: "right", 2: "left" }[op.v] ?? "center"}`);
        break;
      case "detune": {
        // Track the raw mucom D value (so relative D+ accumulates), then map to
        // cents with the chip's representative factor.
        const raw = op.rel ? (ctx.detune ?? 0) + op.val : op.val;
        ctx.detune = raw;
        const cents = Math.round(raw * (ctx.isSsg ? PSG_CENTS_PER_DETUNE : FM_CENTS_PER_DETUNE));
        out.push(`:pitch ${cents}`);
        break;
      }
      case "lenSet":
        ctx.len = op.token;
        out.push(`:len ${op.token}`);
        break;
      case "porta": {
        // mucom {from len to}: glide from the start pitch to the target over len.
        // :glide-from needs an absolute octave (a bare note resolves to C4).
        const fromOct = ctx.oct + op.from.bo;
        out.push(`:glide-from ${op.from.letter}${ACC(op.from.acc)}${fromOct}`);
        for (let s = op.to.bo; s > 0; s--) { out.push(">"); ctx.oct++; }
        for (let s = op.to.bo; s < 0; s++) { out.push("<"); ctx.oct--; }
        const len = op.len ?? ctx.len ?? "4";
        out.push(`:glide ${len}`);
        out.push(`${op.to.letter}${ACC(op.to.acc)}${op.len ?? ""}`);
        out.push(":glide 0"); // one porta note only; following notes don't glide
        break;
      }
      case "hwLfo":
        // Hardware (YM) LFO. FM only — the SSG/PSG has no equivalent.
        if (ctx.isSsg) {
          warnOnce(ctx.warnings, "Hssg", "hardware LFO (H) is FM-only; dropped on SSG/PSG");
        } else {
          out.push(`:lfo-rate ${clamp(op.speed, 0, 8)} :fms ${clamp(op.pms, 0, 7)} :ams ${clamp(op.ams, 0, 3)}`);
        }
        break;
      case "lfoSet": {
        // Software pitch LFO -> sticky :macro :pitch. Depth/period scaling are
        // representative approximations (like detune); tune by ear if needed.
        // mucom triangle: amp steps of +amt each up then down; peak = amp*amt
        // (F-number units -> cents), full cycle = 2*amp*clock mucom-clocks.
        const lfo = op.lfo;
        let spec;
        if (!lfo.on || lfo.amp * lfo.amt === 0 || lfo.clock === 0) {
          spec = "none"; // LFO off -> (def lfo-off :macro :pitch none)
        } else {
          const factor = WHOLE_TICKS / op.wholeClocks; // mucom clocks -> ticks
          const cents = Math.round(lfo.amp * lfo.amt * (ctx.isSsg ? PSG_CENTS_PER_DETUNE : FM_CENTS_PER_DETUNE));
          const period = Math.max(1, Math.round(2 * lfo.amp * lfo.clock * factor));
          const tri = `(triangle :from ${-cents} :to ${cents} :len ${period}t)`;
          // delay>0: hold at the note's pitch for the delay, then the triangle loops.
          spec = lfo.delay > 0
            ? `[ (wait ${Math.max(1, Math.round(lfo.delay * factor))}t) ${tri} ]`
            : tri;
        }
        // Define each distinct LFO (and the off-clear) once as (def … :macro
        // :pitch …) and reference it by name — compact and readable.
        if (ctx.lfoRegistry) {
          let name = ctx.lfoRegistry.get(spec);
          if (!name) {
            name = spec === "none"
              ? "lfo-off"
              : `lfo${[...ctx.lfoRegistry.keys()].filter((k) => k !== "none").length + 1}`;
            ctx.lfoRegistry.set(spec, name);
          }
          out.push(name); // bare reference — the def already carries :macro
        } else {
          out.push(`:macro :pitch ${spec}`);
        }
        break;
      }
      case "vel":
        if (op.v !== ctx.vel) { out.push(`:vel ${clamp(op.v, 0, 15)}`); ctx.vel = op.v; }
        break;
      case "gateCut": {
        // mucom q<n> -> :gate- (key off n clocks early); convert clocks to ticks.
        const cut = Math.round(op.n * (WHOLE_TICKS / op.wholeClocks));
        if (cut !== ctx.gateCut) { out.push(`:gate- ${cut}t`); ctx.gateCut = cut; }
        break;
      }
      case "velAdj": {
        const nv = clamp((ctx.vel ?? 12) + op.d, 0, 15);
        if (nv !== ctx.vel) { out.push(`:vel ${nv}`); ctx.vel = nv; }
        break;
      }
      case "macroCall":
        // Reference a (def *n …); skip macros whose body had no supported content.
        if (ctx.usableMacros && ctx.usableMacros.has(op.n)) out.push(`*${op.n}`);
        else if (!ctx.warnedVoices.has(`*${op.n}`)) {
          ctx.warnedVoices.add(`*${op.n}`);
          ctx.warnings.push(`macro *${op.n} has no MMLisp-supported content; dropped`);
        }
        break;
      case "voice":
        // Only switch to voices actually defined in this file; an undefined
        // @N would be an "unknown token" error, so skip it (use the default).
        if (ctx.definedVoices.has(op.n)) out.push(`@${ctx.voiceLabels.get(op.n)}`);
        else if (!ctx.warnedVoices.has(op.n)) {
          ctx.warnedVoices.add(op.n);
          ctx.warnings.push(`voice @${op.n} referenced but not defined in this file — using default voice`);
        }
        break;
      case "voiceByName": {
        // @"name": resolve to an inline voice of that name. External banks
        // (#voice xxx.dat) aren't loaded, so unknown names just keep the default.
        const label = ctx.voiceByName && ctx.voiceByName.get(op.name);
        if (label) out.push(`@${label}`);
        else if (!ctx.warnedVoices.has(`"${op.name}"`)) {
          ctx.warnedVoices.add(`"${op.name}"`);
          ctx.warnings.push(`voice @"${op.name}" not defined in this file (external bank?) — using default voice`);
        }
        break;
      }
      case "loopBreak":
        // A break inside a single-line (x …) loop is consumed by the loop case
        // (sliced out and expanded). A break that reaches here is inside a
        // cross-line #label/(go) loop, where MMLisp's :break does the job.
        out.push(":break");
        break;
      case "loopMarker":
        out.push(`#${op.label}`);
        break;
      case "loopGo":
        out.push(`(go ${op.label} ${op.count})`);
        break;
      case "globalLoop":
        // mucom allows one L per track; emit a single #loop label even if the
        // source repeats it (a duplicate label would be invalid).
        if (!ctx.hasGlobalLoop) { out.push("#loop"); ctx.hasGlobalLoop = true; }
        break;
      case "loop":
        // Single-line loop -> (x N …); a `/` break in the body renders as :break.
        emitLoop(out, op.count, op.body, ctx, depth);
        break;
      case "tempo":
        // Emit an inline :tempo only when it changes the running tempo. The
        // first tempo already seeds the score header (ctx.tempo), so it's not
        // repeated inline; mid-song changes are emitted here.
        if (op.bpm !== ctx.tempo) { out.push(`:tempo ${op.bpm}`); ctx.tempo = op.bpm; }
        break;
    }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v | 0)); }

function voiceToDef(label, v) {
  const parts = [`:alg ${clamp(v.alg, 0, 7)} :fb ${clamp(v.fb, 0, 7)}`];
  for (let op = 0; op < 4; op++) {
    const o = v.ops[op];
    const n = op + 1;
    parts.push(
      `:ar${n} ${clamp(o.ar, 0, 31)} :dr${n} ${clamp(o.dr, 0, 31)} :sr${n} ${clamp(o.sr, 0, 31)} ` +
      `:rr${n} ${clamp(o.rr, 0, 15)} :sl${n} ${clamp(o.sl, 0, 15)} :tl${n} ${clamp(o.tl, 0, 127)} ` +
      `:ks${n} ${clamp(o.ks, 0, 3)} :ml${n} ${clamp(o.ml, 0, 15)} :dt${n} ${clamp(o.dt, 0, 7)}`,
    );
  }
  const def = `(def @${label}\n  ${parts.join("\n  ")})`;
  const head = (v.comments || []).join("\n");
  return head ? `${head}\n${def}` : def;
}

// Label each voice by its trailing "name" (sanitized to a symbol) if present,
// else by its number; dedupe collisions by suffixing the number.
function buildVoiceLabels(voices) {
  const labels = new Map();
  const used = new Set();
  for (const [num, v] of [...voices.entries()].sort((a, b) => a[0] - b[0])) {
    let label = String(v.name ?? "").trim().replace(/[^\w\-]/g, "");
    if (!label) label = String(num);
    if (used.has(label)) label = `${label}-${num}`;
    used.add(label);
    labels.set(num, label);
  }
  return labels;
}

const qstr = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/**
 * Render a parsed mucom song into MMLisp source text.
 * @returns {{ source:string, warnings:string[] }}
 */
export function mucomToMmlisp(parsed) {
  const { meta, tempo, voices, macros, scoreItems, scoreComments, warnings } = parsed;
  const lines = [];
  const definedVoices = new Set(voices.keys());
  const warnedVoices = new Set();
  const voiceLabels = buildVoiceLabels(voices);
  // name -> label, for @"name" voice selection (inline voices only)
  const voiceByName = new Map();
  for (const [num, v] of voices) if (v.name) voiceByName.set(v.name, voiceLabels.get(num));

  for (const [num, v] of [...voices.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push("", voiceToDef(voiceLabels.get(num), v));
  }

  // Distinct software-LFO specs collected during rendering -> emitted as
  // (def lfoN :macro :pitch …) above the score, referenced by name.
  const lfoRegistry = new Map();

  // Macros become (def *n …); only those with supported content are kept.
  const usableMacros = new Set();
  for (const [mn, mac] of [...(macros || new Map()).entries()].sort((a, b) => a[0] - b[0])) {
    const toks = [];
    // No lfoRegistry here: a `*n` body can't reference another def (:macro lfoN),
    // so its LFO renders inline. The *n def is already singular, so no duplication.
    renderOps(mac.ops, { vel: null, hasGlobalLoop: false, definedVoices, voiceLabels, voiceByName, usableMacros, warnedVoices, warnings }, toks);
    const content = toks.join(" ").trim();
    if (!content) continue;
    usableMacros.add(mn);
    const head = (mac.comments || []).join("\n");
    lines.push("", (head ? head + "\n" : "") + `(def *${mn} ${content})`);
  }

  // #composer + #author, joined with " | " — but de-duplicated when identical.
  const author = [...new Set([meta.composer, meta.author].filter(Boolean))].join(" | ");
  const scoreHead = ["(score"];
  if (meta.title) scoreHead.push(`:title ${qstr(meta.title)}`);
  if (author) scoreHead.push(`:author ${qstr(author)}`);
  scoreHead.push(`:tempo ${tempo ?? 120}`);
  // LFO defs (if any) are spliced in here once rendering has discovered them.
  const lfoDefAnchor = lines.length;
  lines.push("");
  for (const c of scoreComments || []) lines.push(c);
  lines.push(scoreHead.join(" "));

  // Each part line becomes one (chN …) form; they merge per channel, so the
  // author's line order can be preserved verbatim. State (octave/vel/detune)
  // flows per letter via a ctx kept across that part's lines.
  const ctxByLetter = new Map();
  const letterCtx = (letter) => {
    if (!ctxByLetter.has(letter)) {
      ctxByLetter.set(letter, { vel: null, detune: 0, tempo, oct: letter in SSG_PARTS ? 6 : 5, len: null, isSsg: letter in SSG_PARTS, hasGlobalLoop: false, definedVoices, voiceLabels, voiceByName, usableMacros, warnedVoices, warnings, lfoRegistry });
    }
    return ctxByLetter.get(letter);
  };

  const forms = scoreItems.filter((it) => it.kind === "form");

  // Octave base per letter: mucom default o6 (= :oct 5 after the -1 shift),
  // unless that part opens with an absolute `o`.
  const allOpsByLetter = new Map();
  for (const f of forms) {
    const a = allOpsByLetter.get(f.letter) || [];
    a.push(...f.ops);
    allOpsByLetter.set(f.letter, a);
  }

  // Render in source order so per-letter state flows correctly.
  for (const f of forms) {
    const toks = [];
    renderOps(f.ops, letterCtx(f.letter), toks);
    f.text = toks.join(" ");
  }

  // Emit the discovered LFO defs above the score (referenced by name inline).
  if (lfoRegistry.size) {
    const defLines = [];
    for (const [spec, name] of lfoRegistry) defLines.push("", `(def ${name} :macro :pitch ${spec})`);
    lines.splice(lfoDefAnchor, 0, ...defLines);
  }

  // Per channel: #loop (or octave base) on the first playable form, (go loop)
  // on the last. mucom songs loop from L if present (emitted inline) else start.
  const firstForm = new Map();
  const lastForm = new Map();
  for (const f of forms) {
    if (f.text === "") continue;
    if (!firstForm.has(f.letter)) firstForm.set(f.letter, f);
    lastForm.set(f.letter, f);
  }
  for (const [letter, f] of firstForm) {
    const prefix = [];
    // mucom default octave is o6; FM drops one (-> :oct 5), SSG/PSG keeps it.
    if (!startsWithAbsoluteOctave(allOpsByLetter.get(letter) || [])) prefix.push(`:oct ${letter in SSG_PARTS ? 6 : 5}`);
    if (!letterCtx(letter).hasGlobalLoop) prefix.push("#loop");
    if (prefix.length) f.text = `${prefix.join(" ")} ${f.text}`.trim();
  }
  for (const [, f] of lastForm) f.text = `${f.text} (go loop)`.trim();

  // Emit forms and in-music comments verbatim, in source order.
  for (const it of scoreItems) {
    if (it.kind === "comment") { lines.push(`  ${it.text}`); continue; }
    if (it.text === "") { if (it.comment) lines.push(`  ${it.comment}`); continue; }
    lines.push(`  (${it.ch} ${it.text})${it.comment ? `  ${it.comment}` : ""}`);
  }

  lines.push(")", "");
  return { source: lines.join("\n").replace(/^\n+/, ""), warnings };
}

// --- external voice bank (.dat) --------------------------------------------

// Parse a mucom `.dat` voice bank: 256 voices x 32 bytes (see voiceformat.h).
// Each record is hed(1) + 6 param groups x 4 ops + FB/AL(1) + name(6). The four
// op bytes per group are in YM2608 slot order op1,op3,op2,op4. Returns
// Map<index, { fb, alg, ops:[{ar,dr,sr,rr,sl,tl,ks,ml,dt}x4], name }>.
export function parseVoiceDat(bytes) {
  const REC = 32;
  const voices = new Map();
  const slot = { 1: 0, 2: 2, 3: 1, 4: 3 }; // MMLisp op n -> byte position in a group
  const at = (i) => bytes[i] & 0xff;
  for (let v = 0; (v + 1) * REC <= bytes.length; v++) {
    const o = v * REC;
    let empty = true;
    for (let k = 0; k < REC; k++) if (at(o + k) !== 0) { empty = false; break; }
    if (empty) continue;
    const grp = (g) => [at(o + 1 + g * 4), at(o + 1 + g * 4 + 1), at(o + 1 + g * 4 + 2), at(o + 1 + g * 4 + 3)];
    const dtml = grp(0), tl = grp(1), ksar = grp(2), amdr = grp(3), sr = grp(4), slrr = grp(5);
    const fbal = at(o + 25);
    const ops = [];
    for (let n = 1; n <= 4; n++) {
      const p = slot[n];
      ops.push({
        ar: ksar[p] & 0x1f, dr: amdr[p] & 0x1f, sr: sr[p] & 0x1f, rr: slrr[p] & 0x0f,
        sl: (slrr[p] >> 4) & 0x0f, tl: tl[p] & 0x7f, ks: (ksar[p] >> 6) & 0x03,
        ml: dtml[p] & 0x0f, dt: (dtml[p] >> 4) & 0x07,
      });
    }
    let name = "";
    for (let k = 26; k < 32; k++) { const ch = at(o + k); if (ch >= 0x20 && ch < 0x7f) name += String.fromCharCode(ch); }
    voices.set(v, { fb: (fbal >> 3) & 0x07, alg: fbal & 0x07, ops, name: name.trim() || null });
  }
  return voices;
}

// Pull the voices a song actually references (by @n or @"name") out of a parsed
// .dat bank and add them to `parsed.voices`, so their (def @name …) get emitted
// and @"name"/@n resolve. Only referenced voices are added (a bank has 256).
function mergeDatVoices(parsed, datVoices) {
  const refNums = new Set(), refNames = new Set();
  const scan = (ops) => {
    for (const op of ops) {
      if (op.t === "voice") refNums.add(op.n);
      else if (op.t === "voiceByName") refNames.add(op.name);
      else if (op.t === "loop") scan(op.body);
    }
  };
  for (const it of parsed.scoreItems) if (it.kind === "form") scan(it.ops);
  for (const mac of parsed.macros.values()) scan(mac.ops);
  const byName = new Map();
  for (const [num, v] of datVoices) if (v.name) byName.set(v.name, num);
  const add = (num) => { if (num != null && datVoices.has(num) && !parsed.voices.has(num)) parsed.voices.set(num, datVoices.get(num)); };
  for (const num of refNums) add(num);
  for (const name of refNames) add(byName.get(name));
}

/**
 * Convenience: bytes -> { source, warnings }. Pass the referenced `.dat` voice
 * bank (Uint8Array) as `datBytes` to resolve external @"name"/@n voices.
 */
export function importMucom(bytes, datBytes = null) {
  const parsed = parseMucom(decodeMucText(bytes));
  if (datBytes) mergeDatVoices(parsed, parseVoiceDat(datBytes));
  return mucomToMmlisp(parsed);
}

/**
 * Convert a standalone `.dat` voice bank into MMLisp `(def @name …)` defs — a
 * voice library, no song needed. Unnamed/empty slots are skipped.
 * @returns {{ source:string, warnings:string[] }}
 */
export function voiceBankToMmlisp(datBytes) {
  const named = new Map([...parseVoiceDat(datBytes)].filter(([, v]) => v.name));
  const labels = buildVoiceLabels(named);
  const lines = [`; mucom88 voice bank — ${named.size} voices`];
  for (const [num, v] of [...named.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push("", voiceToDef(labels.get(num), v));
  }
  return { source: lines.join("\n") + "\n", warnings: named.size ? [] : ["no named voices in this bank"] };
}

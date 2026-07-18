// ---------------------------------------------------------------------------
// Encode-time VOICE_TABLE coalescing (driver.md §10, mmb.md §11).
//
// A full FM voice change compiles to a same-tick burst of ~38 PARAM_SETs
// (~90 stream bytes). This pass folds each such burst into one deduplicated
// 29-byte VOICE_TABLE entry + a 2-byte VOICE_SET (0x14); the IR is unchanged.
//
// Pure encode transform: VOICE_SET must produce the same register STATE as the
// burst it replaces. The entry is built from an op shadow tracked across the
// stream, so registers the burst would leave untouched (e.g. $90/SSG when a
// voice def omits it) are written with their current value — a no-op in state
// terms. The ab-compare gate (ir-player vs drv-player) is the safety net.
// ---------------------------------------------------------------------------

import { encode30, encode60, encode80, clampForTarget } from "./ir-utils.js";

// The mandatory targets that mark a same-tick PARAM_SET run as a full voice:
// AR/DR/SR/RR/SL/TL/KS/ML/DT × 4 ops + ALG + FB (38). SSG/AMEN are optional
// (they default to 0 and are folded from the shadow when absent).
const CORE_FAMILIES = [
  "FM_AR", "FM_DR", "FM_SR", "FM_RR", "FM_SL", "FM_TL", "FM_KS", "FM_ML", "FM_DT",
];
const CORE_TARGETS = new Set();
for (const fam of CORE_FAMILIES) for (let op = 1; op <= 4; op++) CORE_TARGETS.add(`${fam}${op}`);
CORE_TARGETS.add("FM_ALG");
CORE_TARGETS.add("FM_FB");

// Every op/ALG/FB target that belongs to a voice (folded into the entry and
// dropped from the stream when a burst coalesces). SSG/AMEN included.
const VOICE_TARGETS = new Set(CORE_TARGETS);
for (const fam of ["FM_SSG", "FM_AMEN"]) for (let op = 1; op <= 4; op++) VOICE_TARGETS.add(`${fam}${op}`);

// target name → { op: 0..3, field } for op params; { voice: 'alg'|'fb' } otherwise.
function targetToField(target) {
  if (target === "FM_ALG") return { voice: "alg" };
  if (target === "FM_FB") return { voice: "fb" };
  const m = /^(FM_[A-Z]+)([1-4])$/.exec(target);
  if (!m) return null;
  const op = Number(m[2]) - 1;
  const field = {
    FM_TL: "tl", FM_AR: "ar", FM_DR: "dr", FM_SR: "d2r", FM_RR: "rr",
    FM_SL: "sl", FM_KS: "rs", FM_ML: "mul", FM_DT: "dt", FM_SSG: "ssg", FM_AMEN: "amen",
  }[m[1]];
  return field ? { op, field } : null;
}

// Driver power-on op shadow (matches drv-player _makeFmChannel + _emitInitWrites).
function makeShadow() {
  return {
    alg: 7,
    fb: 0,
    ops: Array.from({ length: 4 }, () => ({
      dt: 0, mul: 1, tl: 0, rs: 0, ar: 31, amen: 0, dr: 0, d2r: 0, sl: 0, rr: 15, ssg: 0,
    })),
  };
}

// Store a PARAM_SET value into the shadow. Clamp exactly as the exporter's
// PARAM_SET path does (Math.round(clampForTarget(…))) so the entry matches the
// bytes the burst would have written — e.g. FM_DT's range is 0..7 (the raw
// register field), so a signed `:dt -2` clamps to 0, not the 3-bit 6.
function applyToShadow(sh, target, value) {
  const f = targetToField(target);
  if (!f) return;
  value = Math.round(clampForTarget(target, value));
  if (f.voice === "alg") { sh.alg = value & 0x07; return; }
  if (f.voice === "fb") { sh.fb = value & 0x07; return; }
  const o = sh.ops[f.op];
  switch (f.field) {
    case "tl": o.tl = value < 0 ? 0 : value > 127 ? 127 : value; break;
    case "ar": o.ar = value & 0x1f; break;
    case "dr": o.dr = value & 0x1f; break;
    case "d2r": o.d2r = value & 0x1f; break;
    case "rr": o.rr = value & 0x0f; break;
    case "sl": o.sl = value & 0x0f; break;
    case "rs": o.rs = value & 0x03; break;
    case "mul": o.mul = value & 0x0f; break;
    case "dt": o.dt = value; break; // encode30 handles sign→register
    case "ssg": o.ssg = value & 0x0f; break;
    case "amen": o.amen = value & 0x01; break;
  }
}

// 29-byte entry in register-write order (mmb.md §11): $30/$40/$50/$60/$70/$80/$90
// × 4 ops (op1..op4), then $B0.
function entryFromShadow(sh) {
  const b = new Array(29);
  for (let op = 0; op < 4; op++) {
    const o = sh.ops[op];
    b[0 + op] = encode30(o);
    b[4 + op] = o.tl & 0x7f;
    b[8 + op] = ((o.rs & 0x03) << 6) | (o.ar & 0x1f);
    b[12 + op] = encode60(o);
    b[16 + op] = o.d2r & 0x1f;
    b[20 + op] = encode80(o);
    b[24 + op] = o.ssg & 0x0f;
  }
  b[28] = ((sh.fb & 0x07) << 3) | (sh.alg & 0x07); // $B0 (FB/ALG)
  return b;
}

/**
 * Plan the VOICE_TABLE for a whole song.
 * @returns {{ table: number[][], plans: Map<number, {emit: Map<number, number>, drop: Set<number>}> }}
 *   table: deduplicated 29-byte entries; plans[trackIdx].emit maps a burst's
 *   first event index → voice id, .drop is every voice-param index to skip.
 */
export function planVoices(ir) {
  const table = [];
  const keyToId = new Map();
  const plans = new Map();

  const internEntry = (bytes) => {
    const key = bytes.join(",");
    let id = keyToId.get(key);
    if (id === undefined) {
      id = table.length;
      keyToId.set(key, id);
      table.push(bytes);
    }
    return id;
  };

  const tracks = ir.tracks ?? [];
  for (let ti = 0; ti < tracks.length; ti++) {
    const events = tracks[ti].events ?? [];
    // Only FM channels 0..5 carry voices.
    const emit = new Map();
    const drop = new Set();
    const sh = makeShadow();

    let i = 0;
    while (i < events.length) {
      const ev = events[i];
      if (ev.cmd !== "PARAM_SET") { i++; continue; }
      // Gather the maximal same-tick PARAM_SET run.
      const tick = ev.tick;
      let j = i;
      const runTargets = new Set();
      const voiceIdx = [];
      while (j < events.length && events[j].cmd === "PARAM_SET" && events[j].tick === tick) {
        const t = events[j].args?.target;
        runTargets.add(t);
        if (VOICE_TARGETS.has(t)) {
          applyToShadow(sh, t, events[j].args?.value ?? 0);
          voiceIdx.push(j);
        }
        j++;
      }
      // Is the full core voice present in this run?
      let full = true;
      for (const t of CORE_TARGETS) if (!runTargets.has(t)) { full = false; break; }
      if (full) {
        const id = internEntry(entryFromShadow(sh));
        emit.set(voiceIdx[0], id); // VOICE_SET replaces the burst at its first voice param
        for (const k of voiceIdx) drop.add(k);
      }
      i = j;
    }

    if (emit.size) plans.set(ti, { emit, drop });
  }

  return { table, plans };
}

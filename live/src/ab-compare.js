// ---------------------------------------------------------------------------
// A/B register-log comparison: IRPlayer (Web-Audio reference) vs DrvPlayer
// (MMB/Z80 reference). The Phase-C acceptance gate (docs/driver.md §12).
//
// Both players render the same score to a register-write log; this module
// normalizes the two logs and diffs them:
//
// - YM parameter registers are compared as *state runs* — per (port, addr),
//   the sequence of (frame, value) change points. IRPlayer writes on a
//   continuous clock and repeats values freely; the driver is frame-quantized
//   and change-only — raw write streams are incomparable, states are.
// - Key ($28) and PSG bytes are *edges*: they are decoded (PSG latch state
//   machine) into key-event / att / tone / noise-config sequences.
// - Acceptance bands (documented in driver.md §12): ±1 frame timing skew
//   everywhere; TL data (0x40–0x4F) ±2 steps (integer offset tables vs
//   float-sum); F-number low bytes (0xA0–0xA2 / 0xA8–0xAA) ±1 (LUT cent
//   interpolation vs float pow).
// ---------------------------------------------------------------------------

import { compileMMLisp } from "./mmlisp2ir.js";
import { IRPlayer } from "./ir-player.js";
import { DrvPlayer } from "./drv-player.js";
import { encodeMmb } from "./export-mmb.js";

const FRAME_SKEW = 1; // frames of allowed timing skew

// Per-register value tolerance by YM address.
function valueTolerance(port, addr) {
  const hi = addr & 0xf0;
  if (hi === 0x40) return 2; // TL: integer tables vs float sum
  if (addr >= 0xa0 && addr <= 0xa2) return 1; // fnum low (ch)
  if (addr >= 0xa8 && addr <= 0xaa) return 1; // fnum low (fm3 op)
  return 0;
}

// ── Normalization ──────────────────────────────────────────────────────────

// IRPlayer log: [{sec, port, addr, data}] → frame-stamped writes.
function irWritesToFrames(writes) {
  return writes.map((w) => ({
    frame: Math.max(0, Math.round(w.sec * 60)),
    port: w.port,
    addr: w.addr,
    data: w.data,
  }));
}

// Split a frame-stamped write list into:
//   ymRuns:  Map "p:addr" → [{frame, value}] (change points only)
//   keys:    [{frame, data}] $28 writes (edges, consecutive dups collapsed)
//   psg:     { tone: [ch][{frame, value}], att: [ch][...], noise: [{frame, value}] }
function normalize(writes) {
  const ymRuns = new Map();
  const ymLast = new Map();
  const keys = {}; // $28 channel key (data & 0x07) → [{frame, data}]
  const psgLatch = { reg: 0, ch: 0, isAtt: false };
  const tone = [[], [], []];
  const toneLast = [null, null, null];
  const tonePending = [0, 0, 0];
  const att = [[], [], [], []];
  const attLast = [null, null, null, null];
  const noise = [];

  const pushRun = (arr, last, frame, value, idx) => {
    if (last[idx] === value) return;
    last[idx] = value;
    arr[idx].push({ frame, value });
  };

  for (const w of writes) {
    if (w.port === 2) {
      const b = w.data;
      if (b & 0x80) {
        const ch = (b >> 5) & 0x03;
        const isAtt = (b & 0x10) !== 0;
        if (isAtt) {
          if (ch === 3) {
            // noise attenuation
            pushRun(att, attLast, w.frame, b & 0x0f, 3);
          } else {
            pushRun(att, attLast, w.frame, b & 0x0f, ch);
          }
          psgLatch.isAtt = true;
        } else if (ch === 3) {
          // noise config — every write is an LFSR-reset edge; keep all
          noise.push({ frame: w.frame, value: b & 0x07 });
          psgLatch.isAtt = true; // data bytes don't extend noise cfg
        } else {
          psgLatch.ch = ch;
          psgLatch.isAtt = false;
          tonePending[ch] = b & 0x0f;
          // low nibble alone is a complete (partial) update; record after
          // the data byte lands, or now if none follows — record lazily:
          pushRun(
            tone,
            toneLast,
            w.frame,
            (toneLast[ch] ?? 0) & 0x3f0 | (b & 0x0f),
            ch,
          );
        }
      } else if (!psgLatch.isAtt) {
        const ch = psgLatch.ch;
        const value = ((b & 0x3f) << 4) | tonePending[ch];
        pushRun(tone, toneLast, w.frame, value, ch);
      }
      continue;
    }
    if (w.port === 0 && w.addr === 0x28) {
      // Key edges are per-channel sequences: writes to different channels in
      // the same frame are order-independent (the two players dispatch tracks
      // in different orders within a frame).
      const chKey = w.data & 0x07;
      if (!keys[chKey]) keys[chKey] = [];
      const seq = keys[chKey];
      const prev = seq[seq.length - 1];
      if (prev && prev.data === w.data && prev.frame === w.frame) continue;
      seq.push({ frame: w.frame, data: w.data });
      continue;
    }
    const k = `${w.port}:${w.addr}`;
    if (ymLast.get(k) === w.data) continue;
    ymLast.set(k, w.data);
    if (!ymRuns.has(k)) ymRuns.set(k, []);
    ymRuns.get(k).push({ frame: w.frame, value: w.data });
  }
  return { ymRuns, keys, psg: { tone, att, noise } };
}

// ── Run/sequence diffing ───────────────────────────────────────────────────

function diffRuns(label, a, b, tol, maxFrame, out) {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const ra = a[i];
    const rb = b[j];
    if (ra && ra.frame > maxFrame && (!rb || rb.frame > maxFrame)) break;
    if (ra && rb) {
      const dv = Math.abs(ra.value - rb.value);
      const df = Math.abs(ra.frame - rb.frame);
      if (dv <= tol && df <= FRAME_SKEW) {
        i++;
        j++;
        continue;
      }
      // Same frame, different value → value mismatch; otherwise the earlier
      // change is unmatched.
      if (df <= FRAME_SKEW) {
        out.push({
          kind: "value",
          where: label,
          frame: ra.frame,
          a: ra.value,
          b: rb.value,
        });
        i++;
        j++;
      } else if (ra.frame < rb.frame) {
        out.push({ kind: "missing-in-b", where: label, frame: ra.frame, a: ra.value });
        i++;
      } else {
        out.push({ kind: "extra-in-b", where: label, frame: rb.frame, b: rb.value });
        j++;
      }
    } else if (ra) {
      if (ra.frame <= maxFrame)
        out.push({ kind: "missing-in-b", where: label, frame: ra.frame, a: ra.value });
      i++;
    } else {
      if (rb.frame <= maxFrame)
        out.push({ kind: "extra-in-b", where: label, frame: rb.frame, b: rb.value });
      j++;
    }
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Compile `source`, render it through both players, and diff the register
 * logs. Returns { ok, mismatches, stats } — `ok` when no mismatch survived
 * the acceptance bands.
 */
export function abCompare(source, { maxSec = 30, filename = "ab.mmlisp" } = {}) {
  const { ir, diagnostics } = compileMMLisp(source, filename);
  const compileErrors = diagnostics.filter((d) => d.severity === "error");
  if (compileErrors.length) {
    return { ok: false, mismatches: [], stats: { compileErrors } };
  }

  // A: IRPlayer continuous-clock capture.
  const irp = new IRPlayer(() => {});
  irp.loadJSON(ir);
  const capA = irp.captureRegisterLog({ maxSec });
  const framesA = irWritesToFrames(capA.writes);
  const endFrame = Math.min(
    Math.ceil(maxSec * 60),
    Math.ceil((capA.endSec > 0 ? capA.endSec : maxSec) * 60),
  );

  // B: MMB → DrvPlayer frame-stepped capture over the same horizon.
  const { bytes, diagnostics: exportDiags } = encodeMmb(ir);
  const drv = new DrvPlayer();
  drv.loadMMB(bytes);
  const capB = drv.captureRegisterLog({ maxFrames: endFrame + FRAME_SKEW + 1 });

  const A = normalize(framesA.filter((w) => w.frame <= endFrame));
  const B = normalize(capB.writes.filter((w) => w.frame <= endFrame));

  const mismatches = [];
  const allYmKeys = new Set([...A.ymRuns.keys(), ...B.ymRuns.keys()]);
  for (const k of allYmKeys) {
    const [port, addr] = k.split(":").map(Number);
    diffRuns(
      `ym p${port} $${addr.toString(16)}`,
      A.ymRuns.get(k) ?? [],
      B.ymRuns.get(k) ?? [],
      valueTolerance(port, addr),
      endFrame,
      mismatches,
    );
  }
  for (const chKey of new Set([...Object.keys(A.keys), ...Object.keys(B.keys)])) {
    diffRuns(
      `key $28 ch${chKey}`,
      (A.keys[chKey] ?? []).map(keyAsRun),
      (B.keys[chKey] ?? []).map(keyAsRun),
      0,
      endFrame,
      mismatches,
    );
  }
  for (let ch = 0; ch < 3; ch++) {
    diffRuns(`psg tone${ch}`, A.psg.tone[ch], B.psg.tone[ch], 1, endFrame, mismatches);
  }
  for (let ch = 0; ch < 4; ch++) {
    diffRuns(`psg att${ch}`, A.psg.att[ch], B.psg.att[ch], 0, endFrame, mismatches);
  }
  diffRuns("psg noise-cfg", A.psg.noise, B.psg.noise, 0, endFrame, mismatches);

  return {
    ok: mismatches.length === 0,
    mismatches,
    stats: {
      endFrame,
      writesA: capA.writes.length,
      writesB: capB.writes.length,
      exportDiags: exportDiags.length,
      skippedOpcodes: capB.skippedOpcodes,
      pcmCount: capA.pcmCount,
    },
  };
}

const keyAsRun = (k) => ({ frame: k.frame, value: k.data });

/** Human-readable one-screen summary for the console / headless assertions. */
export function formatAbReport(result, { maxLines = 30 } = {}) {
  const lines = [];
  lines.push(
    `A/B ${result.ok ? "OK" : "MISMATCH"} — frames 0..${result.stats.endFrame}, ` +
      `A ${result.stats.writesA} writes, B ${result.stats.writesB} writes, ` +
      `${result.mismatches.length} mismatches`,
  );
  if (result.stats.skippedOpcodes && Object.keys(result.stats.skippedOpcodes).length) {
    lines.push(`  skipped (M2/M3): ${JSON.stringify(result.stats.skippedOpcodes)}`);
  }
  for (const m of result.mismatches.slice(0, maxLines)) {
    lines.push(
      `  f${m.frame} ${m.where}: ${m.kind}` +
        (m.a !== undefined ? ` A=${m.a}` : "") +
        (m.b !== undefined ? ` B=${m.b}` : ""),
    );
  }
  if (result.mismatches.length > maxLines) {
    lines.push(`  … ${result.mismatches.length - maxLines} more`);
  }
  return lines.join("\n");
}

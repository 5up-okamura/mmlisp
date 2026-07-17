// ---------------------------------------------------------------------------
// Encode-time CALL/RET factoring (opcodes.md §5.2, design-eval §9).
//
// Repeated event runs in the EVENT_STREAM are stored once and replaced by a
// 3-byte CALL; the stored fragment ends in RET. This is a *pure encode
// transform*: the same score with dedup on/off MUST produce byte-identical
// register traces. The ab-compare gate (drv/tools/ab-gate.mjs) is the safety
// net — it replays the original IR through ir-player and the deduped MMB
// through drv-player, so any behavioural change fails the baseline.
//
// Conservative first cut. A factored run must be:
//   - control-flow-free (no LOOP_*/JUMP/CALL/RET/MARKER/END_OF_TRACK inside),
//     so it can never escape and no JUMP can target its interior (every JUMP
//     dest is a MARKER offset, and markers are excluded);
//   - at loop depth 0 and within a single track, so a CALL adds exactly one
//     control-stack entry (combined loop+call depth stays ≤ 4, driver.md §5.2).
//
// The only absolute references into the stream are track eventOffsets and JUMP
// dests; both are event boundaries and are relinked here.
// ---------------------------------------------------------------------------

const CONTROL_CMDS = new Set([
  "LOOP_BEGIN",
  "LOOP_END",
  "LOOP_BREAK",
  "JUMP",
  "CALL",
  "RET",
  "MARKER",
  "END_OF_TRACK",
]);

// Gain of factoring a run of `B` bytes appearing `k` times: original `k*B`,
// after `k` CALLs (3 B each) + one fragment (`B` + 1 RET). Positive gain needs
// `(k-1)*B > 3k + 1`; for k=2 that means B ≥ 8.
const MIN_RUN_BYTES = 8;

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * @param {Uint8Array} bytes  the full EVENT_STREAM payload
 * @param {{offset:number,cmd:string,track:number}[]} bounds  per-event starts
 * @param {{eventOffset:number}[]} trackEntries  patched in place
 * @param {Record<string,number>} OPCODE
 * @returns {{bytes:Uint8Array, calls:number, savedBytes:number}}
 */
export function dedupEventStream(bytes, bounds, trackEntries, OPCODE) {
  if (!bounds.length) return { bytes, calls: 0, savedBytes: 0 };

  // ── Units: one per emitted event, in stream order. ──────────────────────
  const units = [];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i].offset;
    const end = i + 1 < bounds.length ? bounds[i + 1].offset : bytes.length;
    units.push({
      origOffset: start,
      bytes: bytes.slice(start, end),
      cmd: bounds[i].cmd,
      track: bounds[i].track,
      depth: 0,
      factorable: false,
      // rewrite state:
      removed: false, // part of a factored occurrence (not the emitted CALL)
      callTo: -1, // if ≥0, this unit becomes a CALL to that orig fragment offset
    });
  }

  // Loop depth at each unit (LOOP_BEGIN raises the following units).
  let depth = 0;
  for (const u of units) {
    if (u.cmd === "END_OF_TRACK") depth = 0;
    if (u.cmd === "LOOP_END") depth = Math.max(0, depth - 1);
    u.depth = depth;
    if (u.cmd === "LOOP_BEGIN") depth++;
    u.factorable = !CONTROL_CMDS.has(u.cmd) && u.depth === 0;
  }

  // Can a run of `runLen` units start at unit index `p`? All must be
  // factorable and share one track.
  const runStartable = (p, runLen) => {
    if (p + runLen > units.length) return false;
    const tr = units[p].track;
    for (let t = 0; t < runLen; t++) {
      const u = units[p + t];
      if (!u.factorable || u.removed || u.callTo >= 0 || u.track !== tr) return false;
    }
    return true;
  };

  const runBytes = (p, runLen) => {
    let n = 0;
    for (let t = 0; t < runLen; t++) n += units[p + t].bytes.length;
    return n;
  };

  const runsEqual = (p, q, runLen) => {
    for (let t = 0; t < runLen; t++) {
      if (!bytesEqual(units[p + t].bytes, units[q + t].bytes)) return false;
    }
    return true;
  };

  // ── Greedy: repeatedly factor the longest beneficial repeated run. ──────
  const fragments = []; // { at: firstUnitIndex, runLen }
  let calls = 0;
  let savedBytes = 0;

  for (;;) {
    // Find the pair (i, j) of factorable starts whose common run is longest
    // in bytes (event-aligned), non-overlapping.
    let best = null; // { i, runLen, byteLen }
    for (let i = 0; i < units.length; i++) {
      if (!runStartable(i, 1)) continue;
      for (let j = i + 1; j < units.length; j++) {
        if (!runStartable(j, 1)) continue;
        if (!bytesEqual(units[i].bytes, units[j].bytes)) continue;
        // Extend the common run while both stay factorable, same-run, and
        // the two windows do not overlap.
        let runLen = 0;
        while (
          runStartable(i, runLen + 1) &&
          runStartable(j, runLen + 1) &&
          j >= i + runLen + 1 &&
          runsEqual(i, j, runLen + 1)
        ) {
          runLen++;
        }
        if (runLen === 0) continue;
        const byteLen = runBytes(i, runLen);
        if (byteLen < MIN_RUN_BYTES) continue;
        if (!best || byteLen > best.byteLen) best = { i, runLen, byteLen };
      }
    }
    if (!best) break;

    // Collect all non-overlapping occurrences of the winning run (greedy L→R).
    const { i: anchor, runLen, byteLen } = best;
    const occ = [];
    let scan = 0;
    while (scan + runLen <= units.length) {
      if (
        runStartable(scan, runLen) &&
        runsEqual(anchor, scan, runLen) &&
        // do not re-consume the anchor's own units as a separate occurrence
        // before we register it; occurrences are picked below including anchor
        true
      ) {
        occ.push(scan);
        scan += runLen; // non-overlapping
      } else {
        scan++;
      }
    }
    if (occ.length < 2) break; // nothing to gain (shouldn't happen)

    // The fragment body is stored once in the pool (first occurrence's units +
    // RET); EVERY occurrence — including the first — becomes an inline CALL.
    // Each occurrence's head unit emits the CALL; the rest are dropped inline.
    // The pool reads the body straight from the head fragment's `.bytes`, which
    // stay valid regardless of the inline-emission flags.
    const fragAt = occ[0];
    const fragOrigOffset = units[fragAt].origOffset;
    fragments.push({ at: fragAt, runLen });
    for (const p of occ) {
      units[p].callTo = fragOrigOffset; // head → CALL
      for (let t = 1; t < runLen; t++) units[p + t].removed = true;
    }

    calls += occ.length;
    savedBytes += byteLen * occ.length - (occ.length * 3 + byteLen + 1);
  }

  if (!fragments.length) return { bytes, calls: 0, savedBytes: 0 };

  // ── Materialize: main sequence (with CALLs) then the fragment pool. ─────
  // Fragment bodies are the runs recorded in `fragments`; their units are the
  // originals at [at .. at+runLen). Those units were NOT marked removed for the
  // pool — we read them straight from the original bytes via origOffset.
  const out = [];
  const remap = new Map(); // origOffset → newOffset (for retained/emitted units)
  let cursor = 0;

  const emit = (arr) => {
    for (const b of arr) out.push(b);
    cursor += arr.length;
  };

  // Pass 1: main stream. Retained units keep identity; removed units vanish;
  // a unit with callTo≥0 emits a CALL placeholder (dest patched in pass 3).
  const callSites = []; // { newOffset, fragOrigOffset }
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    if (u.removed) continue;
    remap.set(u.origOffset, cursor);
    if (u.callTo >= 0) {
      callSites.push({ newOffset: cursor, fragOrigOffset: u.callTo });
      emit([OPCODE.CALL, 0, 0]); // dest lo/hi patched later
    } else {
      emit(Array.from(u.bytes));
    }
  }

  // Pass 2: fragment pool. Each fragment = its body units' bytes + RET. The
  // fragment's new start offset is recorded against the head unit's origOffset
  // so CALL sites can resolve to it.
  const fragNewOffset = new Map(); // fragOrigOffset → pool offset
  for (const frag of fragments) {
    const head = units[frag.at];
    fragNewOffset.set(head.origOffset, cursor);
    for (let t = 0; t < frag.runLen; t++) {
      emit(Array.from(units[frag.at + t].bytes));
    }
    emit([OPCODE.RET]);
  }

  const outBytes = Uint8Array.from(out);

  // Pass 3: patch CALL dests to fragment pool offsets.
  for (const cs of callSites) {
    const dest = fragNewOffset.get(cs.fragOrigOffset);
    outBytes[cs.newOffset + 1] = dest & 0xff;
    outBytes[cs.newOffset + 2] = (dest >> 8) & 0xff;
  }

  // Pass 4: relink JUMP dests (every dest is a MARKER offset = a retained unit
  // start, so it is in `remap`). A JUMP event may carry a sticky-state-restore
  // prelude before the JUMP opcode (export-mmb backward-loop path), so the
  // opcode is the unit's LAST 3 bytes (opcode + u16 dest), not byte 0.
  for (const u of units) {
    if (u.removed || u.cmd !== "JUMP" || u.callTo >= 0) continue;
    const newOff = remap.get(u.origOffset);
    const jpos = u.bytes.length - 3; // JUMP opcode within the unit
    if (u.bytes[jpos] !== OPCODE.JUMP) continue; // defensive
    const origDest = u.bytes[jpos + 1] | (u.bytes[jpos + 2] << 8);
    const newDest = remap.get(origDest);
    if (newDest === undefined) continue; // unresolved upstream; leave as-is
    outBytes[newOff + jpos + 1] = newDest & 0xff;
    outBytes[newOff + jpos + 2] = (newDest >> 8) & 0xff;
  }

  // Pass 5: relink track eventOffsets.
  for (const te of trackEntries) {
    const n = remap.get(te.eventOffset);
    if (n !== undefined) te.eventOffset = n;
  }

  return { bytes: outBytes, calls, savedBytes };
}

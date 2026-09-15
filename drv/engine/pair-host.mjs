// THE PAIR TRANSPORT'S HOST SIDE, as a reference (R28 §63.3 D3/D6, step 2).
//
// One algorithm, used by the JS gate's dynamic host and mirrored by the 68000
// code in rom.mjs, so the emulator runs what the model graded:
//
//   C  = fifoLo >> 1            the expander's next pair, published by piece B
//   d  = (H - C) & 127          how far the producer's head is ahead of it
//   if d == 0 or d > 64:  H = C + 1
//   write up to k pairs at H, H += n
//
// WHY C + 1 AND NOT C. The index is published by piece B, one slot after piece
// A fetched the pair at C; a grab landing between the two reads a C that piece A
// has already consumed as IDLE, and a pair written there would be idled by B
// unseen. C + 1 is the first position no piece has touched whichever side of B
// the grab landed. When d is large the consumer has run past H through idle
// pairs and H is reset the same way; d cannot honestly exceed a handful, since
// the producer writes at most k a grab and the consumer takes sixteen a lap.
//
// A PITCH PAIR IS WRITTEN WHOLE, IN ONE GRAB. The chip's frequency holding
// register for $A4-$A6 is one register for both parts (Nuked-OPN2 `reg_a4`), so
// an upper byte on either port must be followed by its own lower byte before
// any other upper write; a pair split across two grabs would leave it live for
// a lap or more of idle steps. The engine's CSM pair ($AC/$A8) uses the OTHER
// holding register (`reg_ac`) and never interferes — the "unsafe step" idle
// the first version of this inserted was for a latch model the chip does not
// have (analyze.mjs).
import { PCM1, PCM1_OPS, PCM1_OP_LIMIT, pcm1Base } from "./config.mjs";
import { endFor, SAMPLES } from "./pcm1-ref.mjs";

export const FIFO_PAIRS = 128;
export const PAIRS_PER_GRAB = 5;

const isPitchHi = (reg) => (reg >= 0xa4 && reg <= 0xa6) || (reg >= 0xac && reg <= 0xae);

/** The pairs a start is, in the order they must be written. */
export function startPairs(sample, step, gen) {
  const end = endFor(sample, step);
  return [[PCM1_OPS.SRC_LO, sample.at & 0xff], [PCM1_OPS.SRC_HI, sample.at >> 8],
    [PCM1_OPS.END_LO, end & 0xff], [PCM1_OPS.END_HI, end >> 8],
    [PCM1_OPS.STEP, step], [PCM1_OPS.START, gen & 0xff]];
}

/**
 * A producer over a queue of timed items. Each item is `{at, pairs, port?}`;
 * `port` marks the FM port a RAW item belongs to, so a PORT pair is inserted
 * when it changes. `grab(cycle, fifoLo)` returns the byte writes for one grab.
 */
export function makeProducer(cfg, { pairsPerGrab = PAIRS_PER_GRAB } = {}) {
  const base = cfg.ram.fifo[0];
  const queue = [];
  let H = 0, port = 0, written = 0, grabs = 0, resets = 0;
  const log = [];                              // every pair as written: {cycle, pos, op, val}
  const put = (writes, cycle, op, val) => {
    writes.push([base + 2 * H, op], [base + 2 * H + 1, val]);
    log.push({ cycle, pos: H, op, val });
    H = (H + 1) & (FIFO_PAIRS - 1);
  };
  return {
    log,
    get stats() { return { written, grabs, resets, pending: queue.length }; },
    push(item) { queue.push(item); },
    grab(cycle, fifoLo) {
      grabs++;
      const C = (fifoLo >> 1) & (FIFO_PAIRS - 1);
      const d = (H - C) & (FIFO_PAIRS - 1);
      if (d === 0 || d > 64) { H = (C + 1) & (FIFO_PAIRS - 1); resets++; }
      const writes = [];
      let n = 0;
      while (n < pairsPerGrab && queue.length && queue[0].at <= cycle) {
        const item = queue[0];
        const portChange = item.port !== undefined && item.port !== port;
        // A PITCH PAIR IS WRITTEN WHOLE OR NOT AT ALL. Its upper half consumed in
        // one grab and its lower half in the next leaves the chip's latch live
        // across a lap or more of idle steps — and the engine's own CSM pair runs
        // every block. The first run of this gate split one exactly there.
        const hi = item.pairs.some(([op]) => op >= PCM1_OP_LIMIT && isPitchHi(op));
        if (hi) {
          if (n + (portChange ? 1 : 0) + item.pairs.length > pairsPerGrab) break;
          if (portChange) { put(writes, cycle, PCM1_OPS.PORT, item.port); n++; port = item.port; written++; }
          for (const [op, val] of item.pairs) { put(writes, cycle, op, val); n++; written++; }
          queue.shift();
          continue;
        }
        if (portChange) {
          put(writes, cycle, PCM1_OPS.PORT, item.port); n++; port = item.port; written++;
          if (n >= pairsPerGrab) break;
        }
        const [op, val] = item.pairs[0];
        put(writes, cycle, op, val); n++; written++;
        item.pairs.shift();
        if (!item.pairs.length) queue.shift();
      }
      return writes;
    },
  };
}

// ── The streams ────────────────────────────────────────────────────────────
// Items are `{at, port?, pairs}`; `at` is in Z80 cycles from the first DAC write.
// FM registers are the operator and channel registers, with the pitch pairs in
// the order the chip wants (upper, then the lower that commits) and ch3's
// special-mode registers $A8..$AE left alone, since the engine's own CSM traffic
// owns that latch.
const REGS = [0x30, 0x34, 0x38, 0x3c, 0x40, 0x44, 0x48, 0x4c, 0x50, 0x60, 0x70, 0x80, 0x90,
  0x31, 0x45, 0x59, 0x6d, 0x81, 0x95, 0xb0, 0xb4, 0xb1, 0xb5, 0xb2, 0xb6, 0x28, 0x22, 0x27];
const raw = (at, port, reg, val) => ({ at, port, pairs: [[reg, val & 0xff]] });
const pitch = (at, port, ch, hi, lo) => ({ at, port, pairs: [[0xa4 + ch, hi & 0x3f], [0xa0 + ch, lo & 0xff]] });
const pcm = (at, pairs) => ({ at, pairs: pairs.map(([o, v]) => [o, v & 0xff]) });

export function pairStream(kind, cfg, cycles) {
  const items = [];
  const frame = cfg.frameCycles;
  const lut = cfg.ram.lut[0] >> 8, L = cfg.levels;
  let gen = 0, sgen = 0;
  const start = (at, name, step) => items.push(pcm(at, startPairs(SAMPLES[name], step, ++gen)));
  const stop = (at) => items.push(pcm(at, [[PCM1_OPS.STOP, ++sgen]]));
  if (kind === "raw") {
    // Runs of six writes a port, alternating ports, a frame apart, for the run.
    let k = 0;
    for (let t = frame; t < cycles - frame; t += frame)
      for (let j = 0; j < 6; j++, k++) items.push(raw(t, (k / 6 | 0) & 1, REGS[k % REGS.length], 0x11 + k));
  }
  if (kind === "pitch") {
    let k = 0;
    for (let t = frame; t < cycles - frame; t += frame) {
      items.push(pitch(t, k & 1, k % 3, 0x22 + (k & 7), 0x40 + k));
      items.push(raw(t, k & 1, 0x28, (k & 1 ? 0xf4 : 0xf0) + (k % 3)));
      items.push(pitch(t, (k + 1) & 1, (k + 1) % 3, 0x11 + (k & 3), 0x80 + k));
      k++;
    }
  }
  if (kind === "dense") {
    // Every grab full: the queue never runs dry, so the wire is at its ceiling.
    for (let k = 0; k < 20000; k++) items.push(raw(0, (k >> 4) & 1, REGS[k % REGS.length], k * 7));
  }
  if (kind === "pcm") {
    start(frame, "sine", 1);
    items.push(pcm(frame * 3, [[PCM1_OPS.LEVEL, lut + 7]]));
    items.push(pcm(frame * 6, [[PCM1_OPS.MASTER, lut + 3]]));
    stop(frame * 12);
    start(frame * 15, "saw", 2);
    items.push(pcm(frame * 17, [[PCM1_OPS.LEVEL, lut + L - 1], [PCM1_OPS.MASTER, lut + L - 1]]));
    for (let t = frame * 20; t < cycles - frame; t += frame * 9) start(t, "ramp", 1 << ((t / frame) % 4 | 0));
    for (let t = frame * 2; t < cycles - frame; t += frame) items.push(raw(t, 0, 0x4c, 0x20 + (t / frame | 0)));
  }
  if (kind === "roll") {
    for (let t = frame; t < cycles - frame; t += frame / 2) {
      start(t, (t / frame | 0) & 1 ? "short" : "sine", 1);
      items.push(pitch(t, 1, 1, 0x2a, 0x66));
      items.push(raw(t, 0, 0x28, 0xf1));
      items.push(raw(t, 0, 0x28, 0x01));
    }
  }
  items.sort((a, b) => a.at - b.at);
  return items;
}


// ── The same streams, as a table the 68000 replays (step 2 on BlastEm) ──────
//
// Groups, each `[timeLo, timeHi, count, op, val, op, val, ...]`:
//   time    the host-loop iteration (two a frame) from which the group may go
//   count   1..PAIRS_PER_GRAB pairs, written whole in one grab or not at all
//           (a PORT change is the group's first pair)
// The table ends with a count of 0. The 68000 keeps the producer's H, reads
// the engine's index at every grab, and applies exactly the rule makeProducer
// applies; a group is atomic so a pitch pair can never straddle two grabs.
export function encodePairTable(items, cfg) {
  const half = cfg.frameCycles / 2;
  const out = [];
  let port = 0;
  const groups = [];
  for (const item of items) {
    const t = Math.max(0, Math.floor(item.at / half));
    const pairs = [];
    if (item.port !== undefined && item.port !== port) { pairs.push([PCM1_OPS.PORT, item.port]); port = item.port; }
    pairs.push(...item.pairs);
    // A group may not exceed a grab: long items (a start is six pairs) are
    // split into groups of at most PAIRS_PER_GRAB, which is safe because none
    // of them is a pitch pair.
    for (let i = 0; i < pairs.length; i += PAIRS_PER_GRAB) {
      const chunk = pairs.slice(i, i + PAIRS_PER_GRAB);
      groups.push({ t, pairs: chunk });
    }
  }
  for (const g of groups) {
    out.push(g.t & 0xff, (g.t >> 8) & 0xff, g.pairs.length);
    for (const [op, val] of g.pairs) out.push(op & 0xff, val & 0xff);
  }
  out.push(0, 0, 0);
  return { bytes: Uint8Array.from(out), groups };
}

/**
 * What the chip must see for a table, per port and in order: the RAW pairs
 * with the PORT pairs applied — the same fold the JS gate makes of the
 * producer's log, so both sides are graded against one list.
 */
export function expectedWrites(groups) {
  const want = [[], []];
  let port = 0;
  for (const g of groups) for (const [op, val] of g.pairs) {
    if (op === PCM1_OPS.PORT) port = val;
    else if (op >= PCM1_OP_LIMIT) want[port].push({ reg: op, val });
  }
  return want;
}


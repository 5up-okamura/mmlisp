// The JS twin of 68k/mmlpairs.c — the slot stream turned into the pair
// transport (R28 §63.3 D7) — written from the same rules and gated against it
// byte for byte (tools/pairs-gate.mjs). It also feeds the JS machine in the
// end-to-end model run, where the DAC and the FM writes of a real score are
// graded against the reference driver's own stream.
import { decodeSlot } from "../../live/src/slot-builder.js";

export const MMLP_QUEUE = 1024, MMLP_PSG = 256, MMLP_AHEAD = 32, MMLP_HELD = 128;
export const MMLP_FRAMES = 8;
const PCM_LEN = [0, 18, 2, 3, 6, 2];
const LEVEL_OF_SHIFT = [14, 7, 4, 2, 1, 0, 0, 0, 0];
const isPitchHi = (r) => (r >= 0xa4 && r <= 0xa6) || (r >= 0xac && r <= 0xae);

export const levelPage = (cfg, shift) =>
  cfg.lutPage + Math.min(cfg.levels - 1, shift > 8 ? 0 : LEVEL_OF_SHIFT[shift]);

/** The engine header as the C side receives it (mmlispdrv_bin.h). */
export function pairsCfgFromHeader(H) {
  return { fifo: H.FIFO, fifoPairs: H.FIFO_PAIRS, pairsPerGrab: H.PAIRS_PER_GRAB,
    lutPage: H.LUT_PAGE, levels: H.LEVELS, opLimit: H.OP_LIMIT, ops: H.OPS };
}

export class PairsModel {
  constructor(cfg) {
    this.cfg = cfg;
    this.q = [];                         // {port, op, val}; port -1 = a state store
    this.psg = [];
    // Running totals in and out of each queue, and where each frame ends in
    // them (the C keeps ring indices; these are the same cuts).
    this.qIn = 0; this.qOut = 0; this.psgIn = 0; this.psgOut = 0; this.psgMark = 0;
    this.framesIn = 0; this.endQ = new Array(MMLP_FRAMES).fill(0); this.endPsg = new Array(MMLP_FRAMES).fill(0);
    this.chipPort = 0;
    this.startGen = 0; this.stopGen = 0;
    this.head = 0; this.headValid = false;
    this.levelPage = levelPage(cfg, 0); this.masterPage = levelPage(cfg, 0);
    this.droppedVoice = 0; this.droppedLoop = 0; this.stepRounded = 0; this.overflow = 0;
    this.grabs = 0; this.pairsWritten = 0; this.late = 0;
    this.held = [];
    this.staged = null; this.sinceStart = 255;
    this.undo = null;
  }
  push(port, op, val) {
    if (this.q.length >= MMLP_QUEUE - 1) { this.overflow++; return; }
    this.q.push({ port, op, val: val & 0xff });
    this.qIn++;
  }
  store(op, val) { this.push(-1, op, val); }
  stepOf(incI, incFrac) {
    if (incFrac === 0 && [1, 2, 4, 8].includes(incI)) return incI;
    this.stepRounded++;
    if (incI >= 6) return 8;
    if (incI >= 3) return 4;
    if (incI >= 2 || (incI === 1 && incFrac >= 0x8000)) return 2;
    return 1;
  }
  pcm(c) {
    const O = this.cfg.ops;
    switch (c[0]) {
      case 1: {                                    // PCM_START
        if (c[1] !== 0) { this.droppedVoice++; return; }
        const addr = c[7] | (c[8] << 8), left = c[9] | (c[10] << 8), tail = c[13] | (c[14] << 8);
        const step = this.stepOf(c[17], c[15] | (c[16] << 8));
        const end = addr + left + tail;
        let sent = end > 16 * step ? end - 16 * step : 0;
        if (sent < addr) sent = addr;
        if (sent > 0xffff) sent = 0xffff;
        // Only what changed (the C has the note).
        const lv = levelPage(this.cfg, c[3]);
        if (!this.staged || lv !== this.levelPage) this.store(O.LEVEL, lv);
        this.levelPage = lv;
        const v = [addr & 0xff, addr >> 8, sent & 0xff, sent >> 8, step];
        const o = [O.SRC_LO, O.SRC_HI, O.END_LO, O.END_HI, O.STEP];
        for (let k = 0; k < 5; k++) if (!this.staged || v[k] !== this.staged[k]) this.store(o[k], v[k]);
        this.staged = v;
        this.startGen = (this.startGen + 1) & 0xff;
        this.store(O.START, this.startGen);
        return;
      }
      case 2:                                      // PCM_STOP
        if (c[1] !== 0) { this.droppedVoice++; return; }
        this.stopGen = (this.stopGen + 1) & 0xff;
        this.store(O.STOP, this.stopGen);
        return;
      case 3:                                      // PCM_VOL
        if (c[1] !== 0) { this.droppedVoice++; return; }
        this.levelPage = levelPage(this.cfg, c[2]);
        this.store(O.LEVEL, this.levelPage);
        return;
      case 5:                                      // PCM_MASTER
        this.masterPage = levelPage(this.cfg, c[1]);
        this.store(O.MASTER, this.masterPage);
        return;
      case 4: this.droppedLoop++; return;         // PCM_LOOP
      default: return;
    }
  }
  slot(bytes) {
    const d = decodeSlot(bytes);
    // One slot late (mmlpairs.c has the reason): last slot's, then hold these.
    for (const c of this.held) this.pcm(c);
    this.held = [];
    let heldLen = 0;
    for (const c of d.pcm) {
      const n = PCM_LEN[c[0]] ?? 0;
      if (heldLen + n <= MMLP_HELD) { this.held.push(Array.from(c)); heldLen += n; } else this.overflow++;
    }
    for (const sub of d.subs) {
      for (const b of sub.psg) if (this.psg.length < MMLP_PSG - 1) { this.psg.push(b); this.psgIn++; }
      for (const [reg, val] of sub.fm0) this.push(0, reg, val);
      for (const [reg, val] of sub.fm1) this.push(1, reg, val);
    }
    this.endQ[this.framesIn % MMLP_FRAMES] = this.qIn;
    this.endPsg[this.framesIn % MMLP_FRAMES] = this.psgIn;
    this.framesIn++;
  }
  /** How many released frames are queued (mmlpairs.c released()). */
  released(release) {
    const inn = this.framesIn;
    if (release >= inn) return inn;              // everything queued is due
    return inn - release >= MMLP_FRAMES ? inn - (MMLP_FRAMES - 1) : release;
  }
  /** One grab: returns {dst, bytes} or bytes.length 0. `fifoLo` is the byte the engine published last grab, or null. */
  plan(fifoLo, release = this.framesIn) {
    const { fifoPairs: N, pairsPerGrab: K, ops: O, fifo } = this.cfg;
    const MASK = N - 1;
    this.grabs++;
    this.undo = { q: this.q.slice(), qOut: this.qOut, port: this.chipPort, since: this.sinceStart, n: 0 };
    const avail = this.released(release);
    const lim = avail ? this.endQ[(avail - 1) % MMLP_FRAMES] : this.qOut;
    if (fifoLo === null || fifoLo === 0xff) return { dst: 0, bytes: [] };
    const c = (fifoLo >> 1) & MASK;
    let h = (c + MMLP_AHEAD) & MASK;
    if (this.headValid) {
      const dOld = (this.head - c) & MASK, dNew = (h - c) & MASK;
      if (dOld > dNew && dOld < 64) h = this.head;
    }
    if (h + K > N) h = 0;                // a grab never crosses the page end (the C has the note)
    this.head = h; this.headValid = true;
    const out = [];
    let n = 0;
    const staged = new Set([O.SRC_LO, O.SRC_HI, O.END_LO, O.END_HI, O.STEP]);
    while (n < K && this.qOut < lim) {
      const e = this.q[0];
      // Three pairs after a START before any staged store (the C has the note).
      if (e.port === -1 && staged.has(e.op) && this.sinceStart < 3) {
        out.push(O.IDLE, 0); n++; this.sinceStart++;
        continue;
      }
      let need = 1;
      const portChange = e.port !== -1 && e.port !== this.chipPort;
      if (portChange) need++;
      if (e.port !== -1 && isPitchHi(e.op)) need++;
      if (n + need > K) break;
      // From the head PLUS what this grab already planned (the C has the note).
      if (((this.head - c) & MASK) + n + need > N - 8) break;
      if (this.head + n + need > N) break;
      if (portChange) { out.push(O.PORT, e.port); n++; this.chipPort = e.port; }
      out.push(e.op, e.val); n++;
      this.q.shift(); this.qOut++;
      if (e.port !== -1 && isPitchHi(e.op) && this.qOut < lim) {
        const u = this.q.shift(); this.qOut++;
        out.push(u.op, u.val); n++;
      }
      this.sinceStart = e.port === -1 && e.op === O.START ? 0 : Math.min(255, this.sinceStart + need);
    }
    const dst = fifo + 2 * this.head;
    this.head = (this.head + n) & MASK;
    this.pairsWritten += n;
    this.undo.n = n;
    const fill = out.slice();
    while (fill.length < 2 * K) fill.push(O.IDLE, 0);
    return { dst, bytes: out, fill };
  }
  /** The grab was late (mmlpairs.h, the in-grab test): give the pairs back. */
  abort() {
    this.q = this.undo.q; this.qOut = this.undo.qOut; this.chipPort = this.undo.port; this.sinceStart = this.undo.since;
    this.pairsWritten -= this.undo.n; this.undo.n = 0;
    this.headValid = false; this.late++;
  }
  psgTake(max = 256, release = this.framesIn) {
    const out = this.psg.splice(0, Math.min(max, this.psgMark - this.psgOut));
    this.psgOut += out.length;
    const avail = this.released(release);
    if (avail) this.psgMark = this.endPsg[(avail - 1) % MMLP_FRAMES];
    return out;
  }
  get pending() { return this.q.length; }
}

/** mmlp_in_time: the engine moved by less than `dst` was ahead of it. */
export const inTime = (loPrev, dst, loNow) => ((loNow - loPrev) & 0xff) < (((dst & 0xff) - loPrev) & 0xff);

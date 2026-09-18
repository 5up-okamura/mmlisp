// The JS twin of 68k/mmlpairs.c — the slot stream turned into the pair
// transport (R28 §63.3 D7) — written from the same rules and gated against it
// byte for byte (tools/pairs-gate.mjs). It also feeds the JS machine in the
// end-to-end model run, where the DAC and the FM writes of a real score are
// graded against the reference driver's own stream.
import { decodeSlot } from "../../live/src/slot-builder.js";

export const MMLP_QUEUE = 1024, MMLP_PSG = 256, MMLP_AHEAD = 32;
export const MMLP_FRAMES = 8, MMLP_AHEAD_ONE = 48, MMLP_VOICES = 3;
const PCM_LEN = [0, 9, 0, 3, 6, 2];
const isPitchHi = (r) => (r >= 0xa4 && r <= 0xa6) || (r >= 0xac && r <= 0xae);
const OP_IDLE = 0, OP_PORT = 0x20;
const OP_LEVEL = (v) => 1 + 9 * v, OP_SRC = (v) => 2 + 9 * v;
const OP_START = (v) => 8 + 9 * v, OP_RETARGET = (v) => 9 + 9 * v;

/** A voice's rung page (mmlpairs.c mmlp_level_page). */
export const levelPage = (cfg, shift, masterShift) =>
  cfg.lutPage + (shift >= 8 || shift + masterShift > 6 ? 0 : 7 - (shift + masterShift));

/** What SGDK's host grabs with: 8 pairs a grab, two grabs a frame. */
// ONE GRAB A FRAME, from the VBlank callback (driver.md §5.3): sixteen pairs
// a grab is the same 960 pairs a second the two-grab host carried, in half as
// many bus stops.
export const SGDK_PAIRS_PER_GRAB = 16;

/** The converter's configuration for an engine image descriptor (live/src/engine-images.js). */
export function pairsCfgForImage(img, { pairsPerGrab = SGDK_PAIRS_PER_GRAB } = {}) {
  return { fifo: img.fifo, fifoPairs: img.fifoPairs, pairsPerGrab, lutPage: img.lutPage,
    opStride: img.opStride, opPort: OP_PORT, voices: img.voices, idleAfterGen: img.idleAfterGen };
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
    this.head = 0; this.headValid = false;
    this.masterShift = 0;
    this.shift = new Array(MMLP_VOICES).fill(0xff);
    this.page = new Array(MMLP_VOICES).fill(0xff);
    this.staged = Array.from({ length: MMLP_VOICES }, () => null);
    this.startGen = new Array(MMLP_VOICES).fill(0);
    this.endGen = new Array(MMLP_VOICES).fill(0);
    this.sinceGen = new Array(MMLP_VOICES).fill(255);
    this.fault = 0; this.overflow = 0;
    this.grabs = 0; this.pairsWritten = 0; this.late = 0;
    this.undo = null;
  }
  push(port, op, val) {
    if (this.q.length >= MMLP_QUEUE - 1) { this.overflow++; return; }
    this.q.push({ port, op, val: val & 0xff });
    this.qIn++;
  }
  store(op, val) { this.push(-1, op, val); }
  level(v) {
    const pg = levelPage(this.cfg, this.shift[v], this.masterShift);
    if (pg !== this.page[v]) { this.store(OP_LEVEL(v), pg); this.page[v] = pg; }
  }
  stage(v, first, vals) {
    if (!this.staged[v]) this.staged[v] = new Array(6).fill(-1);
    vals.forEach((x, k) => {
      if (x !== this.staged[v][first + k]) { this.store(OP_SRC(v) + first + k, x); this.staged[v][first + k] = x; }
    });
  }
  pcm(c) {
    const w = (k) => [c[k], c[k + 1]];
    switch (c[0]) {
      case 1: {                                    // PCM_START
        const v = c[1];
        if (v >= this.cfg.voices) { this.fault++; return; }
        this.shift[v] = c[2];
        this.level(v);
        // Only what changed (the C has the note). A voice's first start sends all six.
        this.stage(v, 0, [...w(3), ...w(5), ...w(7)]);
        this.startGen[v] = (this.startGen[v] + 1) & 0xff;
        this.store(OP_START(v), this.startGen[v]);
        return;
      }
      case 4: {                                    // PCM_RETARGET
        const v = c[1];
        if (v >= this.cfg.voices) { this.fault++; return; }
        this.stage(v, 2, [...w(2), ...w(4)]);
        this.endGen[v] = (this.endGen[v] + 1) & 0xff;
        this.store(OP_RETARGET(v), this.endGen[v]);
        return;
      }
      case 3: {                                    // PCM_VOL
        const v = c[1];
        if (v >= this.cfg.voices) { this.fault++; return; }
        this.shift[v] = c[2];
        this.level(v);
        return;
      }
      case 5:                                      // PCM_MASTER
        this.masterShift = c[1];
        for (let v = 0; v < this.cfg.voices; v++) if (this.shift[v] !== 0xff) this.level(v);
        return;
      default: return;
    }
  }
  slot(bytes) {
    const d = decodeSlot(bytes);
    // The frame's PCM commands, ahead of its register writes (the C has the note).
    for (const c of d.pcm) this.pcm(c);
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
    const { fifoPairs: N, pairsPerGrab: K, fifo, voices } = this.cfg;
    const MASK = N - 1;
    this.grabs++;
    this.undo = { q: this.q.slice(), qOut: this.qOut, port: this.chipPort, since: this.sinceGen.slice(), n: 0 };
    const avail = this.released(release);
    const lim = avail ? this.endQ[(avail - 1) % MMLP_FRAMES] : this.qOut;
    if (fifoLo === null || fifoLo === 0xff) return { dst: 0, bytes: [] };
    const c = (fifoLo >> 1) & MASK;
    let h = (c + (this.cfg.ahead || MMLP_AHEAD)) & MASK;
    if (this.headValid) {
      const dOld = (this.head - c) & MASK, dNew = (h - c) & MASK;
      if (dOld > dNew && dOld < 64) h = this.head;
    }
    if (h + K > N) h = 0;                // a grab never crosses the page end (the C has the note)
    this.head = h; this.headValid = true;
    const out = [];
    let n = 0;
    const inVoices = (op) => op > 0 && op < 1 + 9 * voices;
    const stagedVoice = (op) => (inVoices(op) && (op - 1) % 9 >= 1 && (op - 1) % 9 <= 6 ? Math.floor((op - 1) / 9) : -1);
    const genVoice = (op) => (inVoices(op) && (op - 1) % 9 >= 7 ? Math.floor((op - 1) / 9) : -1);
    const sinceAdd = (k) => { for (let v = 0; v < MMLP_VOICES; v++) this.sinceGen[v] = Math.min(255, this.sinceGen[v] + k); };
    while (n < K && this.qOut < lim) {
      const e = this.q[0];
      // A generation's IDLE window before a staged store of its voice (the C has the note).
      if (e.port === -1) {
        const sv = stagedVoice(e.op);
        if (sv >= 0 && this.sinceGen[sv] < this.cfg.idleAfterGen) {
          out.push(OP_IDLE, 0); n++; sinceAdd(1);
          continue;
        }
      }
      let need = 1;
      const portChange = e.port !== -1 && e.port !== this.chipPort;
      if (portChange) need++;
      if (e.port !== -1 && isPitchHi(e.op)) need++;
      if (n + need > K) break;
      // From the head PLUS what this grab already planned (the C has the note).
      if (((this.head - c) & MASK) + n + need > N - 8) break;
      if (this.head + n + need > N) break;
      if (portChange) { out.push(OP_PORT, e.port); n++; this.chipPort = e.port; }
      out.push(e.op, e.val); n++;
      this.q.shift(); this.qOut++;
      if (e.port !== -1 && isPitchHi(e.op) && this.qOut < lim) {
        const u = this.q.shift(); this.qOut++;
        out.push(u.op, u.val); n++;
      }
      sinceAdd(need);
      if (e.port === -1 && genVoice(e.op) >= 0) this.sinceGen[genVoice(e.op)] = 0;
    }
    const dst = fifo + 2 * this.head;
    this.head = (this.head + n) & MASK;
    this.pairsWritten += n;
    this.undo.n = n;
    const fill = out.slice();
    while (fill.length < 2 * K) fill.push(OP_IDLE, 0);
    return { dst, bytes: out, fill };
  }
  /** The grab was late (mmlpairs.h, the in-grab test): give the pairs back. */
  abort() {
    this.q = this.undo.q; this.qOut = this.undo.qOut; this.chipPort = this.undo.port; this.sinceGen = this.undo.since;
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

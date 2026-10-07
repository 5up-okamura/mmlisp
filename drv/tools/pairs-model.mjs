// The JS twin of 68k/mmlpairs.c — the sequencer's frames turned into the pair
// transport (R28 §63.3 D7) — written from the same rules and gated against it
// byte for byte (tools/pairs-gate.mjs). It also feeds the JS machine in the
// end-to-end model run, where the DAC and the FM writes of a real score are
// graded against the reference driver's own stream.

export const MMLP_QUEUE = 1024, MMLP_LANE = 256, MMLP_PSG = 256, MMLP_AHEAD = 32;
export const MMLP_FRAMES = 8, MMLP_AHEAD_ONE = 48, MMLP_VOICES = 3;
const PCM_LEN = [0, 9, 0, 3, 6, 2, 11];
const isPitchHi = (r) => (r >= 0xa4 && r <= 0xa6) || (r >= 0xac && r <= 0xae);
const OP_IDLE = 0, OP_PORT = 0x20;
const OP_LEVEL = (v) => 1 + 9 * v, OP_SRC = (v) => 2 + 9 * v;
const OP_START = (v) => 8 + 9 * v, OP_RETARGET = (v) => 9 + 9 * v;

/** A voice's rung page (mmlpairs.c mmlp_level_page). */
export const levelPage = (cfg, shift, masterShift) =>
  cfg.lutPage + (shift >= 8 || shift + masterShift > 6 ? 0 : 7 - (shift + masterShift));

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
    this.q = [];                         // {port, op, val}: the FM writes
    this.lane = [];                      // the PCM lane: state stores (port -1) and $2B (the C has the note)
    this.psg = [];
    // Running totals in and out of each queue, and where each frame ends in
    // them (the C keeps ring indices; these are the same cuts).
    this.qIn = 0; this.qOut = 0; this.lIn = 0; this.lOut = 0; this.psgIn = 0; this.psgOut = 0; this.psgMark = 0;
    this.framesIn = 0; this.endQ = new Array(MMLP_FRAMES).fill(0); this.endPsg = new Array(MMLP_FRAMES).fill(0);
    this.endL = new Array(MMLP_FRAMES).fill(0);
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
  toLane(port, op, val) {
    if (this.lane.length >= MMLP_LANE - 1) { this.overflow++; return; }
    this.lane.push({ port, op, val: val & 0xff });
    this.lIn++;
  }
  store(op, val) { this.toLane(-1, op, val); }
  push0(reg, val) { if (reg === 0x2b) this.toLane(0, reg, val); else this.push(0, reg, val); }
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
  /**
   * One frame record (mmlpairs.h mmlp_frame; FrameRecorder below makes them):
   * its register writes — port 0 and the PSG in order, port 1 held back to the
   * frame's end or to a $28 that names fm4-6 (mmlpairs.c writes_body has the
   * reason), $2B into the PCM lane — then its PCM commands into the lane.
   */
  frame(rec) {
    let i = 1;
    const pcm = [];
    for (let n = rec[0] ?? 0; n > 0 && i < rec.length; n--) {
      const len = PCM_LEN[rec[i]] ?? 0;
      if (!len || i + len > rec.length) { i = -1; break; }   // malformed: nothing (the C has the note)
      pcm.push(rec.subarray ? rec.subarray(i, i + len) : rec.slice(i, i + len));
      i += len;
    }
    if (i >= 0) {
      const held = [];
      const flush = () => { for (const w of held) this.push(1, w[0], w[1]); held.length = 0; };
      const ons = this.keyOnsLast(rec, i);
      for (; i + 3 <= rec.length; i += 3) {
        const port = rec[i], reg = rec[i + 1], val = rec[i + 2];
        if (port === 2) { if (this.psg.length < MMLP_PSG - 1) { this.psg.push(val); this.psgIn++; } }
        else if (port === 0) {
          if (reg === 0x27) this.mode27 = val;
          if (ons?.has(i)) continue;
          if (reg === 0x28 && (val & 4)) flush();
          this.push0(reg, val);
        }
        else held.push([reg, val]);
      }
      flush();
      if (ons) for (const at of ons) this.push0(0x28, rec[at + 2]);
      // The PCM commands last, into the lane behind the frame's $2B (the C has the note).
      for (const c of pcm) this.pcm(c);
    }
    this.endQ[this.framesIn % MMLP_FRAMES] = this.qIn;
    this.endPsg[this.framesIn % MMLP_FRAMES] = this.psgIn;
    this.endL[this.framesIn % MMLP_FRAMES] = this.lIn;
    this.framesIn++;
  }
  /** KEY-ONS LAST (mmlpairs.c keyons_last): the record offsets of the frame's
   * key-ons that go out after its other writes, so a chord keys within a few
   * pairs instead of behind every pitch and level of the frame. Each channel's
   * own writes still precede its key-on. Nothing moves in a frame that writes
   * $27 or while CH3 is in special or CSM mode, and a key-on with a later $28
   * for its channel in the same frame stays where it is. */
  keyOnsLast(rec, at) {
    if ((this.mode27 ?? 0) & 0xc0) return null;
    const ons = [];
    for (let i = at; i + 3 <= rec.length; i += 3) {
      if (rec[i] !== 0) continue;
      if (rec[i + 1] === 0x27) return null;
      if (rec[i + 1] === 0x28) ons.push(i);
    }
    const moved = new Set();
    ons.forEach((i, k) => {
      const ch = rec[i + 2] & 7;
      if ((rec[i + 2] & 0xf0) && !ons.slice(k + 1).some((j) => (rec[j + 2] & 7) === ch)) moved.add(i);
    });
    return moved.size ? moved : null;
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
    this.undo = { q: this.q.slice(), qOut: this.qOut, lane: this.lane.slice(), lOut: this.lOut, port: this.chipPort, since: this.sinceGen.slice(), n: 0 };
    const avail = this.released(release);
    const lim = avail ? this.endQ[(avail - 1) % MMLP_FRAMES] : this.qOut;
    const llim = avail ? this.endL[(avail - 1) % MMLP_FRAMES] : this.lOut;
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
    while (n < K) {
      // The lane first (the C has the note).
      const fromLane = this.lOut < llim;
      if (!fromLane && this.qOut >= lim) break;
      const e = fromLane ? this.lane[0] : this.q[0];
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
      const pitch = !fromLane && e.port !== -1 && isPitchHi(e.op);
      if (pitch) need++;
      if (n + need > K) break;
      // From the head PLUS what this grab already planned (the C has the note).
      if (((this.head - c) & MASK) + n + need > N - 8) break;
      if (this.head + n + need > N) break;
      if (portChange) { out.push(OP_PORT, e.port); n++; this.chipPort = e.port; }
      out.push(e.op, e.val); n++;
      if (fromLane) { this.lane.shift(); this.lOut++; } else { this.q.shift(); this.qOut++; }
      if (pitch && this.qOut < lim) {
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
    this.q = this.undo.q; this.qOut = this.undo.qOut; this.lane = this.undo.lane; this.lOut = this.undo.lOut;
    this.chipPort = this.undo.port; this.sinceGen = this.undo.since;
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
  get pending() { return this.q.length + this.lane.length; }
}

/** mmlp_in_time: the engine moved by less than `dst` was ahead of it. */
export const inTime = (loPrev, dst, loNow) => ((loNow - loPrev) & 0xff) < (((dst & 0xff) - loPrev) & 0xff);

/**
 * The pair host's frames from the JS reference: a builder for
 * DrvPlayer.captureSlotLog in place of the SlotBuilder. Every write in the
 * order the sequencer made it, and no cap — the frame the SGDK host takes
 * (mmlispseq.c fill_view) — as mmlp_frame's record bytes, the same bytes
 * gate_main --frames writes for the C.
 */
export class FrameRecorder {
  constructor() { this._writes = []; this._pcm = []; this.spillPeak = 0; this.spillFrames = 0; }
  write(port, addr, data) { this._writes.push(port, addr & 0xff, data & 0xff); }
  pcm(bytes) { this._pcm.push(...bytes); this._npcm = (this._npcm ?? 0) + 1; }
  endSub() {}
  get pending() { return 0; }
  endFrame() {
    const rec = Uint8Array.from([this._npcm ?? 0, ...this._pcm, ...this._writes]);
    this._writes = []; this._pcm = []; this._npcm = 0;
    return rec;
  }
}

/** A frame record's PCM commands, each as its bytes. */
export function recordPcm(rec) {
  const out = [];
  let i = 1;
  for (let n = rec[0]; n > 0; n--) { out.push(rec.slice(i, i + PCM_LEN[rec[i]])); i += PCM_LEN[rec[i]]; }
  return out;
}

/** Each frame's register writes in the order the chip receives them on its
 * port (recordWrites, with the converter's key-ons moved to the end of port 0
 * by the rule in PairsModel.keyOnsLast) — what a gate grading the chip's write
 * stream must expect. */
export function recordWritesOnWire(frames) {
  let mode27 = 0;
  return frames.map((rec) => {
    const d = recordWrites(rec);
    const set27 = d.fm0.filter(([r]) => r === 0x27);
    let moved = new Set();
    if (!(mode27 & 0xc0) && !set27.length) {
      const last = new Map();
      d.fm0.forEach(([r, v], i) => { if (r === 0x28) last.set(v & 7, i); });
      for (const i of last.values()) if (d.fm0[i][1] & 0xf0) moved.add(i);
    }
    if (set27.length) mode27 = set27.at(-1)[1];
    const fm0 = [...d.fm0.filter((_, i) => !moved.has(i)), ...[...moved].sort((a, b) => a - b).map((i) => d.fm0[i])];
    return { ...d, fm0 };
  });
}

/** A frame record's register writes, per port, in order: {fm0: [[reg, val]…], fm1, psg}. */
export function recordWrites(rec) {
  let i = 1;
  for (let n = rec[0]; n > 0; n--) i += PCM_LEN[rec[i]];
  const fm0 = [], fm1 = [], psg = [];
  for (; i + 3 <= rec.length; i += 3) {
    if (rec[i] === 2) psg.push(rec[i + 2]);
    else (rec[i] === 0 ? fm0 : fm1).push([rec[i + 1], rec[i + 2]]);
  }
  return { fm0, fm1, psg };
}

// THE BANKED CONVERTER'S FM ORDER — the reference for mmlpairs.c banked_writes
// (the integrated gate, banked-sgdk-gate.mjs, grades the chip's stream against
// it). A short ordinary note on an independent, unmodulated channel goes ahead
// of another channel's bulk voice upload; each channel's writes keep their
// order; CH3 and CH6 (the DAC) never move; a frame with a global write other
// than $22/$24-$28/$2B, or a split F-number pair, is left as it is.
// `modulation` is each channel's AMS/FMS as last seen (null = unknown),
// updated in place — a channel whose modulation is unknown or on stays put.
export const fmChannel = ([port, reg, value]) => {
  if (port === 2) return -1;
  if (reg === 0x28 && port === 0 && (value & 3) < 3) return (value & 3) + ((value & 4) ? 3 : 0);
  if (((reg >= 0x30 && reg <= 0x9e) || (reg >= 0xa0 && reg <= 0xa6)
    || (reg >= 0xb0 && reg <= 0xb6)) && (reg & 3) < 3) return port * 3 + (reg & 3);
  return -1;
};

// A short ordinary note on an independent, unmodulated channel should not
// wait behind another channel's bulk voice upload. Preserve each channel's
// write order and keep CH3/DAC channels and LFO-dependent voices in place.
export function prioritizeFmNotes(writes, modulation) {
  const previous = [...modulation];
  for (const [p, r, value] of writes) if (p !== 2 && r >= 0xb4 && r <= 0xb6)
    modulation[p * 3 + (r & 3)] = value & 0x37;
  if (writes.some(([p, r]) => p !== 2 && r < 0x30 && ![0x22,0x24,0x25,0x26,0x27,0x28,0x2b].includes(r))) return writes;
  // F-number upper/lower writes share a chip-wide latch. Only move complete
  // adjacent pairs, so independent channel grouping cannot split a latch.
  for (let i=0; i<writes.length; i++) {
    const [p,r] = writes[i];
    if (p !== 2 && r >= 0xa4 && r <= 0xa6 && (writes[i+1]?.[0] !== p || writes[i+1]?.[1] !== r-4)) return writes;
    if (p !== 2 && r >= 0xa0 && r <= 0xa2 && (writes[i-1]?.[0] !== p || writes[i-1]?.[1] !== r+4)) return writes;
  }
  const groups = Array.from({ length: 6 }, (_, ch) => writes.filter((w) => fmChannel(w) === ch));
  const short = groups.map((group,ch) => ({group,ch})).filter(({group,ch}) => ch !== 2 && ch !== 5
    && previous[ch] === 0 && modulation[ch] === 0 && group.length > 0 && group.length <= 8
    && group.every(([p,r,value]) => !(r >= 0xb4 && r <= 0xb6) || (value & 0x37) === 0));
  short.sort((a,b) => a.group.length-b.group.length);
  const moved = new Set(short.map(({ch}) => ch));
  return [...short.flatMap(({group}) => group), ...writes.filter((w) => !moved.has(fmChannel(w)))];
}

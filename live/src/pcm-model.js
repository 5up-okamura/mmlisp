// ---------------------------------------------------------------------------
// The MMLispDRV light PCM engine, as a state machine
// (.claude/memory/plan-pcm-d10-design.md §1.5, §6.1).
//
// ONE model of what the Z80 image does with its PCM voices, slot by slot:
// the block edge's six pieces at each voice's own phase, the mix through the
// rung pages and the saturating add, the ring with its fixed lead, and the
// expander's STORE arm at the image's own step slots. Three consumers read it:
// the engine gate (drv/tools/engine-gate.mjs) as the VALUE reference the Z80
// is graded against, the reference driver (drv-player.js) as the DAC feed, and
// the browser's worklet so the live editor sounds like the driver (D0).
//
// It depends on nothing — no DOM, no audio, no driver-side module — so the
// browser can import it as it is. The tables are computed here from the
// arithmetic (a rung is `s >> r`, the add saturates at the signed byte), not
// read from the image; the gate checks separately that the image's tables are
// the same arithmetic.
//
// Addresses are the engine's: a voice's pointer, END and WRAP are Z80 window
// addresses ($8000 + bank offset), and a LEVEL byte is an absolute page
// (`lutPage + k`, k = 0 silence .. 7 unity).
// ---------------------------------------------------------------------------

export const PCM_WINDOW = 0x8000;
/** Where a parked voice reads: the bank's top page, which the exporter keeps silent. */
export const PCM_SILENCE_ADDR = 0xff00;
export const PCM_BLOCK = 16;
export const PCM_RUNG_PAGES = 8;
/** The DAC byte for silence. */
export const PCM_SILENCE_BYTE = 0x80;

// ── The state block's layout (drv/engine/config.mjs PCMN_L) ────────────────
export const PCM_OP_STRIDE = 9;
const OP = { LEVEL: 0x01, SRC: 0x02, END: 0x04, WRAP: 0x06, START: 0x08, RETARGET: 0x09 };
/** The pair op of a voice's field: `pcmOp("END", 1)` is voice 1's END_LO. */
export const pcmOp = (name, v) => OP[name] + PCM_OP_STRIDE * v;
const LIVE = { END: 0x22, WRAP: 0x24, LAST_START: 0x26, LAST_END: 0x27, PARK: 0x28,
  START_MASK: 0x29, APPLY_MASK: 0x2a };
const live = (name, v) => LIVE[name] + PCM_OP_STRIDE * v;
/** Ops below this are STOREs into the state block; $20 is PORT, above is RAW. */
export const PCM_OP_PORT = 0x20;

// ── The arithmetic ─────────────────────────────────────────────────────────
const signed = (b) => ((b & 0xff) << 24) >> 24;
/** The signed value rung page `page` makes of signed sample `s` (0 = silence, 7 = unity). */
export const pcmRung = (s, page) => (page <= 0 ? 0 : s >> (PCM_RUNG_PAGES - 1 - page));
/** The rung page a total attenuation shift names; past −36 dB is silence. */
export const pcmPageOfShift = (shift) => (shift > PCM_RUNG_PAGES - 2 ? 0 : PCM_RUNG_PAGES - 1 - shift);
const sat = (x) => (x > 127 ? 127 : x < -128 ? -128 : x);

// ── The loop and shot contracts (design §1.5) ──────────────────────────────
//
// The voice wraps at the last block edge before it would read past END+15,
// so END is the last byte to play, plus one, less a block. Blobs are padded to
// a multiple of 16 bytes by the exporter, so a shot plays every byte.

/** A shot of `len` bytes at window address `src`: play it once and park. */
export function pcmShotPoints(src, len) {
  return { end: (src + len - PCM_BLOCK) & 0xffff, wrap: PCM_SILENCE_ADDR };
}

/**
 * A loop over [ls, le) in baked bytes of a `len`-byte blob at `src`, rounded
 * so the first pass plays exactly [0, le') and every later pass [ls', le'),
 * both whole blocks:
 *
 *   le' = 16·round(le/16), within 16..len
 *   ls' = le' − 16·max(1, round((le − ls)/16)), at least 0
 *
 * `round` is half-up (`(x + 8) >> 4`), the same in the C twin.
 */
export function pcmLoopPoints(src, len, ls, le) {
  const r16 = (x) => Math.floor((Math.max(0, x) + 8) / PCM_BLOCK) * PCM_BLOCK;
  const le2 = Math.max(PCM_BLOCK, Math.min(len, r16(le)));
  const ls2 = Math.max(0, le2 - Math.max(PCM_BLOCK, r16(le - ls)));
  return { end: (src + le2 - PCM_BLOCK) & 0xffff, wrap: (src + ls2) & 0xffff,
    loopStart: ls2, loopEnd: le2 };
}

// ── The engine ─────────────────────────────────────────────────────────────
export class PcmEngineModel {
  /**
   * @param image  an engine image descriptor (live/src/engine-images.js):
   *               voices, lead, blockSamples, voiceOffsets, lightAt,
   *               lapSamples, xpSlots, lutPage
   * @param bank   the 32 KB sample bank the window shows (signed bytes)
   * @param opts.saturate  false builds the gate's VALUE negative (a wrapping add)
   */
  constructor(image, bank, { saturate = true } = {}) {
    this.img = image;
    this.bank = bank;
    this.saturate = saturate;
    this.state = new Uint8Array(0x40);
    this.ring = new Uint8Array(256).fill(PCM_SILENCE_BYTE);
    this.slotIndex = 0;
    this.xp = new Set(image.xpSlots);
    this.ptr = [];
    this.page = [];                          // the mix's own operand: an absolute page
    for (let v = 0; v < image.voices; v++) {
      this.ptr.push(PCM_SILENCE_ADDR);
      this.page.push(image.lutPage);
      this.state[pcmOp("LEVEL", v)] = image.lutPage;
      this.put16(live("END", v), 0);
      this.put16(live("WRAP", v), PCM_SILENCE_ADDR);
    }
    /** What the edge applied, for a caller that checks intent: {slot, v, kind, ...}. */
    this.log = [];
  }

  get16(at) { return this.state[at] | (this.state[at + 1] << 8); }
  put16(at, x) { this.state[at] = x & 0xff; this.state[at + 1] = (x >> 8) & 0xff; }

  /** The expander's STORE arm: `(PCM_STATE + op) := val`. PORT and RAW are not PCM. */
  store(op, val) {
    if (op < PCM_OP_PORT) this.state[op] = val & 0xff;
  }

  /**
   * One engine slot. Returns the byte this slot writes to the DAC (it is
   * written first, before any of the slot's work). `pair`, when this slot is
   * one of the image's expander A-slots, is the `[op, val]` the expander
   * consumed — applied after the slot's edge pieces, as the Z80 orders them.
   */
  slot(pair = null) {
    const img = this.img, s = this.slotIndex++;
    const out = this.ring[s & 0xff];
    const B = img.blockSamples;
    const b = (s + img.lead) % B;
    const V = img.voices;
    const bv = (v) => (((b - img.voiceOffsets[v]) % B) + B) % B;
    for (let v = 0; v < V; v++) if (bv(v) === 0) this.pieceStart(s, v);
    this.ring[(s + img.lead) & 0xff] = this.mix();
    const [pSG, pEG, pAP] = img.lightAt;
    for (let v = 0; v < V; v++) {
      const p = bv(v);
      if (p === pSG) this.pieceGen(v, "START", "LAST_START", "START_MASK");
      if (p === pEG) this.pieceGen(v, "RETARGET", "LAST_END", "APPLY_MASK");
      if (p === pAP) this.pieceApply(s, v);
      if (p === B - 2) this.pieceCompare(v);
      if (p === B - 1) this.pieceWrap(v);
    }
    if (pair && this.xp.has(s % img.lapSamples)) this.store(pair[0], pair[1]);
    return out;
  }

  mix() {
    let acc = 0;
    for (let v = 0; v < this.img.voices; v++) {
      const a = this.ptr[v];
      if (a < PCM_WINDOW) throw new Error(`voice ${v} reads Z80 RAM at $${a.toString(16)}`);
      const t = pcmRung(signed(this.bank[a - PCM_WINDOW]), this.page[v] - this.img.lutPage);
      acc = v === 0 ? t : this.saturate ? sat(acc + t) : signed(acc + t);
      this.ptr[v] = (a + 1) & 0xffff;
    }
    return (acc + 128) & 0xff;
  }

  pieceGen(v, gen, last, mask) {
    const g = this.state[pcmOp(gen, v)];
    this.state[live(mask, v)] = g !== this.state[live(last, v)] ? 0xff : 0;
    this.state[live(last, v)] = g;
  }

  pieceApply(s, v) {
    if (!(this.state[live("APPLY_MASK", v)] | this.state[live("START_MASK", v)])) return;
    const end = this.get16(pcmOp("END", v)), wrap = this.get16(pcmOp("WRAP", v));
    this.put16(live("END", v), end);
    this.put16(live("WRAP", v), wrap);
    this.state[live("APPLY_MASK", v)] = 0;
    this.log.push({ slot: s, v, kind: this.state[live("START_MASK", v)] ? "start-apply" : "retarget", end, wrap });
  }

  pieceCompare(v) {
    this.state[live("PARK", v)] = this.ptr[v] >= this.get16(live("END", v)) ? 0xff : 0;
  }

  pieceWrap(v) {
    this.page[v] = this.state[pcmOp("LEVEL", v)];
    if (this.state[live("PARK", v)]) this.ptr[v] = this.get16(live("WRAP", v));
  }

  pieceStart(s, v) {
    if (!this.state[live("START_MASK", v)]) return;
    this.ptr[v] = this.get16(pcmOp("SRC", v));
    this.state[live("START_MASK", v)] = 0;
    this.log.push({ slot: s, v, kind: "start", src: this.ptr[v] });
  }
}

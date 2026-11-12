// An OPN channel's register state and its encoders (B0, B4, 30, 60, 80),
// shared by the YM2612's chip, the player and the driver's export.

// ---------------------------------------------------------------------------
// YM2612 channel register state + encoding
// ---------------------------------------------------------------------------
//
// MMLisp param names (from IR) map to hardware registers.
// Channel-level params:
//   FM_FB      → 0xB0 bits 5-3 (feedback, 0-7)
//   FM_ALG     → 0xB0 bits 2-0 (algorithm, 0-7)
//   FM_AMS     → 0xB4 bits 5-4 (AM sensitivity, 0-3)
//   FM_FMS     → 0xB4 bits 2-0 (FM sensitivity, 0-7)
//   LFO_RATE   → 0x22 global (0=off, 1-8=rate index)
// Operator params (op1-op4):
//   FM_TL1..4  → 0x40 per op (total level, 0-127)
//   FM_AR1..4  → 0x50 per op (attack rate, 0-31)
//   FM_DR1..4  → 0x60 per op bits 4-0 (decay rate, 0-31)
//   FM_AMEN1..4 → 0x60 per op bit 7 (AM enable, 0-1)
//   FM_SR1..4  → 0x70 per op (sustain rate, 0-31)
//   FM_RR1..4  → 0x80 per op (release rate bits 3-0)
//   FM_SL1..4  → 0x80 per op (sustain level bits 7-4)
//   FM_ML1..4  → 0x30 per op (multiplier bits 3-0)
//   FM_DT1..4  → 0x30 per op (detune bits 6-4, sign-magnitude)

export const OP_ADDR_OFFSET = [0, 8, 4, 12]; // op1,op2,op3,op4 in OPN2 register space

export function buildChannelRegState(chIndex) {
  // Returns a mutable object representing all register state for a channel
  return {
    algorithm: 0,
    feedback: 0,
    pan: 0, // -1 (left) / 0 (center) / 1 (right), used for PAN macro
    snap: 0, // `:snap` pitch-class mask (snapNote); 0 = off
    ams: 0, // LFO AM sensitivity 0-3 (0xB4 bits 5-4)
    fms: 0, // LFO FM sensitivity 0-7 (0xB4 bits 2-0)
    b4: 0xc0, // Cache of YM2612 B4 register (read-only on hardware; we cache to preserve bits)
    ops: [
      {
        tl: 0,
        voicedTl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
        dt2: 0, // the OPM's second detune
      },
      {
        tl: 0,
        voicedTl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
        dt2: 0, // the OPM's second detune
      },
      {
        tl: 0,
        voicedTl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
        dt2: 0, // the OPM's second detune
      },
      {
        tl: 0,
        voicedTl: 0,
        ar: 0,
        dr: 0,
        d2r: 0,
        sl: 0,
        rr: 0,
        mul: 0,
        dt: 0,
        rs: 0,
        amen: 0,
        ssg: 0,
        dt2: 0, // the OPM's second detune
      },
    ],
  };
}

// Encode B0 register (algorithm + feedback)
export function encodeB0(regs) {
  return ((regs.feedback & 0x07) << 3) | (regs.algorithm & 0x07);
}

/**
 * A pan, −1..1, on a chip whose stereo is a left and a right bit (the OPN's,
 * the OPM's, the YM2608's rhythm and ADPCM-B): left −1, both 0, right +1.
 * The player hands an encoder the pan as written; a chip with finer stereo
 * reads it at its own resolution.
 */
export function panSide(pan) {
  return Math.max(-1, Math.min(1, Math.round(Number(pan) || 0)));
}

// Encode B4 register (pan + AMS/FMS)
export function encodeB4(regs) {
  // PAN: -1 (left) → 0b10, 0 (center) → 0b11, 1 (right) → 0b01
  const side = panSide(regs.pan);
  const panBits = side < 0 ? 0b10 : side > 0 ? 0b01 : 0b11;
  return (panBits << 6) | ((regs.ams & 0x03) << 4) | (regs.fms & 0x07);
}

// Encode 0x60 (AM enable + DR) for an operator
export function encode60(op) {
  return ((op.amen & 0x01) << 7) | (op.dr & 0x1f);
}

// Encode 0x30 (DT1/MUL) for an operator.
// DT is signed (-3..+3) everywhere above the register; the chip field is
// sign-magnitude (0-3 = 0,+1,+2,+3 / 4-7 = -0,-1,-2,-3), so map it here.
export function encode30(op) {
  return (detuneToReg(op.dt) << 4) | (op.mul & 0x0f);
}

// DT: signed value → 3-bit sign-magnitude register field, and back.
function detuneToReg(dt) {
  const d = dt | 0;
  return d < 0 ? 4 | (-d & 0x03) : d & 0x03;
}

export function detuneFromReg(reg) {
  const r = reg & 0x07;
  return r & 4 ? -(r & 3) : r;
}

// Encode 0x80 (SL/RR) for an operator
export function encode80(op) {
  return ((op.sl & 0x0f) << 4) | (op.rr & 0x0f);
}

export function fmCarrierOpsForAlg(alg) {
  const CARRIER_OPS = [
    [3], // alg 0: op4
    [3], // alg 1: op4
    [3], // alg 2: op4
    [3], // alg 3: op4
    [1, 3], // alg 4: op2, op4
    [1, 2, 3], // alg 5: op2, op3, op4
    [1, 2, 3], // alg 6: op2, op3, op4
    [0, 1, 2, 3], // alg 7: all
  ];
  return CARRIER_OPS[alg] ?? [3];
}

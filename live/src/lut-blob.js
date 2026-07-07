// The driver's constant LUTs, packed as the LUT_TABLE MMB section payload
// (mmb.md §16). These used to be baked into the Z80 image; they now live in ROM
// and the driver reads them through the bank window, freeing 8 KB Z80 work RAM.
//
// Single source of truth for the LUT bytes, shared by export-mmb.js (which
// emits the section) and drv/tools/gen-tables.mjs (which emits the matching
// byte offsets for the asm). The values come from the same ir-utils.js math the
// JS reference player uses, so asm/reference divergence is impossible.
import {
  midiToFnumBlock,
  velToTlAtten,
  volToTlOffset,
  velToPsgAtten,
  volToPsgOffset,
  fmCarrierOpsForAlg,
  OP_ADDR_OFFSET,
  PSG_MASTER_CLOCK,
} from "./ir-utils.js";
import { SIN_LUT, PCM_MULT_FRAME } from "./mmb.js";

function fnumLut12() {
  // MIDI 57..68 (A3..G#4): one octave the block rule extends to MIDI 9..116.
  const lut = [];
  for (let n = 57; n <= 68; n++) lut.push(midiToFnumBlock(n).fnum);
  return lut;
}

function psgPeriodLut() {
  const lut = [];
  for (let n = 45; n <= 116; n++) {
    const freq = 440 * Math.pow(2, (n - 69) / 12);
    lut.push(Math.max(1, Math.min(1023, Math.round(PSG_MASTER_CLOCK / (32 * freq)))));
  }
  return lut;
}

const q4 = (f) => (v) => Math.round(f(v) * 4);
const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const u16bytes = (arr) => [...arr].flatMap((v) => [v & 0xff, (v >> 8) & 0xff]);
const u8bytes = (arr) => [...arr].map((v) => v & 0xff);

// Fixed layout: [asm base-pointer label, packed bytes]. Order is the contract
// between the section payload and the asm offsets.
function lutLayout() {
  return [
    ["FNUM_LUT", u16bytes(fnumLut12())],
    ["PSG_PERIOD_LUT", u16bytes(psgPeriodLut())],
    ["VEL_TL4", u16bytes(range(16, q4(velToTlAtten)))],
    ["VOL_TL4", u16bytes(range(32, q4(volToTlOffset)))],
    ["VEL_PSG4", u16bytes(range(16, q4(velToPsgAtten)))],
    ["VOL_PSG4", u16bytes(range(32, q4(volToPsgOffset)))],
    ["CARRIER_MASK", u8bytes(range(8, (alg) => fmCarrierOpsForAlg(alg).reduce((m, op) => m | (1 << op), 0)))],
    ["OP_ADDR_OFF", u8bytes(OP_ADDR_OFFSET)],
    ["SIN_LUT", u8bytes(SIN_LUT)],
    ["PCM_MULT_FRAME", u16bytes(PCM_MULT_FRAME)],
  ];
}

// { blob: Uint8Array (the LUT_TABLE payload), offsets: {label→byteOffset}, size }.
export function buildLutBlob() {
  const bytes = [];
  const offsets = {};
  for (const [name, arr] of lutLayout()) {
    offsets[name] = bytes.length;
    bytes.push(...arr);
  }
  return { blob: Uint8Array.from(bytes), offsets, size: bytes.length };
}

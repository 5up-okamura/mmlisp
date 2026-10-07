// Experimental MMLisp -> banked ROM + precomputed host frames. The production
// MMB/.smp ABI is not widened or silently reinterpreted by this tool.
import { readFileSync } from "node:fs";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { createSampleBankBuilder, encodeMmb } from "../../live/src/export-mmb.js";
import { parsePcmBank } from "../../live/src/pcm-model.js";
import { engineImage } from "../../live/src/engine-images.js";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { readImportSources } from "./mmb-build.mjs";
import { loadSamplesForIr } from "./wav.mjs";
import { MultibankPairs } from "./multibank-model.mjs";
import { prioritizeFmNotes } from "./pairs-model.mjs";

export function packMultibank(raw, { separateBanks = false } = {}) {
  const { entries, stamp } = parsePcmBank(raw);
  const banks = [new Uint8Array(0x8000)]; // every bank ends in a silence page
  const shared = new Map();
  let bank = 0, cursor = 0, usedBytes = 0;
  const packed = entries.map((s) => {
    if (!Number.isInteger(s.len) || s.len <= 0 || s.len % 16 || s.len > 0x7f00)
      throw new RangeError(`one baked sample is ${s.len} B; the prototype supports 16..32512 B per blob`);
    if (s.base + s.len > raw.length) throw new RangeError("truncated baked sample data");
    const key = `${s.base}:${s.len}`;
    if (!shared.has(key)) {
      if (cursor + s.len > 0x7f00 || (separateBanks && cursor > 0)) {
        bank++;
        // Normal cartridge ROM aperture; larger mapper ROMs need a host policy.
        if (bank >= 128) throw new RangeError("prototype PCM ROM exceeds the 4 MiB cartridge aperture");
        banks.push(new Uint8Array(0x8000)); cursor = 0;
      }
      banks[bank].set(raw.subarray(s.base, s.base + s.len), cursor);
      shared.set(key, { bank, base: bank * 0x8000 + cursor });
      cursor += s.len; usedBytes += s.len;
    }
    return { ...s, ...shared.get(key) };
  });
  const rom = new Uint8Array(banks.length * 0x8000);
  banks.forEach((data, i) => rom.set(data, i * 0x8000));
  return { rom, entries: packed, usedBytes, stamp, banks: banks.length };
}

class BankedPlayer extends DrvPlayer {
  _pcmCmd(c) {
    if (c[0] === 1) {
      const v = this._pcmVoices[c[1]];
      const bank = this._song.samples[v.sampleId]?.bank ?? 0;
      c = [...c, bank & 255, bank >> 8];
    }
    if (this._slotSink) this._slotSink.pcm(c);
  }
}
class Frames {
  constructor() { this.commands = []; this.writes = []; }
  pcm(c) { this.commands.push([...c]); }
  write(port, addr, data) { this.writes.push([port, addr, data]); }
  endSub() {}
  get pending() { return false; }
  endFrame() {
    const f = { pcm: this.commands, writes: this.writes };
    this.commands = []; this.writes = [];
    return f;
  }
}

// Count the intervening FM/PCM pairs as generation protection too. Padding
// every START immediately wasted bandwidth even when a long FM voice update
// already kept the next staged write safely behind the generation.
export function fenceMultibankItems(items, idleAfterGen) {
  const since = [255, 255];
  const advance = () => { for (let v = 0; v < 2; v++) since[v] = Math.min(255, since[v]+1); };
  return items.map((item) => {
    const pairs = [];
    for (const [op, value] of item.pairs) {
      if (op === 0) continue;
      const voice = op >= 0x1c && op <= 0x1f ? (op-0x1c)>>1
        : op >= 1 && op <= 18 && (op-1)%9 !== 0 ? Math.floor((op-1)/9) : -1;
      if (voice >= 0) while (since[voice] < idleAfterGen) { pairs.push([0, 0]); advance(); }
      pairs.push([op, value]); advance();
      if (op === 8 || op === 9) since[0] = 0;
      if (op === 17 || op === 18) since[1] = 0;
    }
    return { ...item, pairs };
  });
}

export function buildMultibankScore(path, { frames = 240, idleAfterGen = 2, separateBanks = false, prioritizeNotes = true } = {}) {
  const src = readFileSync(path, "utf8");
  const compiled = compileMMLisp(src, path, { imports: readImportSources(path, src) });
  const diagnostics = [...compiled.diagnostics];
  const rejectErrors = () => {
    const errors = diagnostics.filter((d) => d.severity === "error");
    if (errors.length) throw new Error(errors.map((e) => e.message).join("\n"));
  };
  rejectErrors();
  const ir = compiled.ir;
  const sourceVoices = ir.metadata.pcmVoices;
  if (sourceVoices < 1 || sourceVoices > 2) throw new Error("multibank prototype requires one or two PCM voices");
  if (sourceVoices !== 2) {
    ir.metadata.pcmVoices = 2;
    diagnostics.push({ severity: "info", code: "I_MULTIBANK_ENGINE",
      message: "one-voice score rebaked for the experimental bank image (10111.709 Hz)" });
  }
  const samples = loadSamplesForIr(ir, diagnostics);
  const builder = createSampleBankBuilder(engineImage(2).rateHz);
  const encoded = encodeMmb(ir, { samples, bankBuilder: builder });
  diagnostics.push(...encoded.diagnostics);
  const flat = builder.finish((severity, code, message) => diagnostics.push({ severity, code, message }));
  rejectErrors();
  const packed = packMultibank(Uint8Array.from(flat.bytes), { separateBanks });
  const player = new BankedPlayer();
  player.loadMMB(encoded.bytes);
  // Explicit experiment adapter; these records never enter a production .smp.
  player._song.samples = packed.entries;
  const capture = player.captureSlotLog({ maxFrames: frames, builder: new Frames() });
  diagnostics.push(...capture.diagnostics);
  rejectErrors();
  const converter = new MultibankPairs(idleAfterGen), items = [];
  const modulation = new Array(6).fill(null);
  let port = 0;
  const u16 = (c, i) => c[i] | c[i + 1] << 8;
  for (let frame = 0; frame < capture.slots.length; frame++) {
    const f = capture.slots[frame];
    const frameStart = items.length;
    for (const c of f.pcm) {
      const intent = c[0] === 1 ? { kind: "start", v: c[1], src: u16(c, 3), bank: u16(c, 9), end: u16(c, 5), wrap: u16(c, 7) }
        : c[0] === 4 ? { kind: "retarget", v: c[1], end: u16(c, 2), wrap: u16(c, 4) } : undefined;
      items.push({ frame: frame + 1, pairs: converter.pcm(c), intent });
    }
    const pairs = [], psg = [];
    for (const [p, reg, value] of prioritizeNotes ? prioritizeFmNotes(f.writes, modulation) : f.writes) {
      if (p === 2) { psg.push(value); continue; }
      if (port !== p) { pairs.push([0x20, p]); port = p; }
      pairs.push([reg, value]);
    }
    items.push({ frame: frame + 1, pairs, psg });
    // PCM source staging can be ten or more pairs when both voices start.
    // Ordinary FM notes share no registers with that staging, so publish
    // their ordered writes first. Keep initialisation and chip-wide control
    // frames in the original order.
    if (sourceVoices === 2 && frame > 0 && pairs.length <= 8 && f.writes.every(([p, reg]) => p === 2 || reg >= 0x30 || reg === 0x28)) {
      const fm = items.pop();
      items.splice(frameStart, 0, fm);
    }
  }
  return { ...packed, mmb: encoded.bytes, entryIds: encoded.pcmEntryIds,
    items: fenceMultibankItems(items, idleAfterGen), diagnostics, sourceVoices, separateBanks };
}

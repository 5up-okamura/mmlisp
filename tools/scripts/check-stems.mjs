#!/usr/bin/env node
// File > Export > Stems (live/src/stems.js): the score rendered a file per
// mixer strip, each strip soloed as the mixer's S solos it.
//
//   every machine  a test score of each: one stem a strip the song plays (a
//                  ROM rhythm sound its own, the chip's sample voices theirs),
//                  handed over in order, none longer than the WAV, each
//                  sounding, none standing off zero (the Mega Drive's DAC
//                  offset is the floor's, taken out of each), a DAC stem
//                  resting at zero, and no PCM said skipped
//   the sum        where the chips mix their channels on their own — the
//                  SSG, the AY-3-8910, the Game Boy's APU, the HuC6280's
//                  waves — the stems and the floor add up to the WAV export
//                  (renderWav), sample for sample
//
// Where they do not add up is the chips': the YM2612's and SN76489's cores
// step on a register write (wasm/nuked_adapter.c, Nuked-PSG's write buffer),
// so a channel's waveform moves with the other channels' writes; the OPLL
// has one user voice, the PC Engine's names share a channel, the 2A03's mixer
// is not linear; and a mix that clips. Each stem is its strip as it sounds
// soloed in Live all the same.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileScoreFile } from "../../drv/tools/mmb-build.mjs";
import { bakedChipSamples, loadSamplesForIr } from "../../drv/tools/wav.mjs";
import { IRPlayer } from "../../live/src/ir-player.js";
import { renderWavSamples } from "../../live/src/export-wav.js";
import { renderStems, mixerStrips, stemName } from "../../live/src/stems.js";
import { targetProfile } from "../../live/src/targets.js";
import { bakeSampleBank, sampleBankKind } from "../../live/src/sample-bank.js";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

// A 16-bit stereo WAV's samples, interleaved.
const samples = (bytes) => {
  const v = new DataView(bytes.buffer, bytes.byteOffset);
  const out = new Float32Array((bytes.length - 44) / 2);
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(44 + 2 * i, true) / 32767;
  return out;
};
const db = (x) => 10 * Math.log10(x + 1e-30);

async function stemsOf(file) {
  const { ir, diagnostics } = compileScoreFile(file);
  assert.ok(!diagnostics.some((d) => d.severity === "error"), `${file} compiles`);
  const target = targetProfile(ir.metadata?.target);
  // The samples as Live bakes them.
  const kind = sampleBankKind(target);
  let pcm = null;
  if (kind === "mmb" && ir.metadata.samples?.length) pcm = bakeSampleBank(ir, loadSamplesForIr(ir), target).pcm;
  else if (kind) {
    const { adpcm, frames } = bakedChipSamples(ir, target);
    pcm = adpcm ? { adpcm } : frames ? { [kind]: frames } : null;
  }
  const make = () => new IRPlayer(() => {}).loadJSON(ir);
  const stems = [];
  const set = await renderStems(ir, make, { pcm }, (stem) => { stems.push(stem); });
  assert.equal(stems.length, set.count);
  assert.deepEqual(stems.map((s) => s.index), stems.map((_, i) => i), `${file}: in order`);
  return { ir, pcm, make, stems, ...set };
}

// ── Every machine ─────────────────────────────────────────────────────────
const EVERY = [
  "drv/tests/m3-pcm-softmix.mmlisp", // md: the DAC's soft mix
  "drv/tests/m3-pcm-sync.mmlisp", // md: FM beside the DAC
  "drv/tests/m4-pcm-hold.mmlisp", // md: a held PCM note, FM beside it
  "examples/daisy-bell.mmlisp", // md: CSM, the PSG and its noise
  "tools/tests/pc88/rhythm.mmlisp", // pc88: the ROM rhythm's sounds
  "tools/tests/pc88/ssg.mmlisp",
  "tools/tests/x68k/fm.mmlisp",
  "tools/tests/msx/scc.mmlisp",
  "tools/tests/pce/wave.mmlisp",
  "tools/tests/gb/apu.mmlisp",
  "tools/tests/fc/apu.mmlisp",
];
// The strips a test score plays that make no sound, in the WAV as in their
// stem: a track of rests, a rhythm sound with no ROM and no :file (pc88's
// kit), and gb's noise at c2-d+2, whose LFSR the APU clocks 4.6-6 times a
// second.
const QUIET = (file, head, ir) =>
  !ir.tracks.some((t) => (t.scoreChannel ?? t.channel) === head && t.events.some((e) => /NOTE_ON$/.test(e.cmd)) || head.startsWith("rhythm-"))
  || (head.startsWith("rhythm-") && !ir.metadata.samples.some((d) => d.rhythm === head.slice(7) && d.file))
  || (file === "tools/tests/gb/apu.mmlisp" && head === "noise");
for (const file of EVERY) {
  const { ir, stems, durationSec, pcmCount, pcm, make } = await stemsOf(file);
  const strips = mixerStrips(ir).filter((s) => !ir.tracks[s.trackIndex]?.se);
  assert.deepEqual(stems.map((s) => s.head), strips.map((s) => s.head), `${file}: a stem a strip`);
  // The samples loaded: no PCM event skipped (a muted track's offs are none).
  assert.equal(pcmCount, 0, `${file}: no PCM skipped`);
  // A looping score's stems are one length, the WAV's.
  if ((await renderWavSamples(make(), { pcm })).durationSec > durationSec + 1e-6) assert.fail(`${file}: a stem as long as the WAV`);
  for (const s of stems) {
    const x = samples(s.bytes);
    let energy = 0, mean = 0;
    for (const v of x) { energy += v * v; mean += v; }
    mean /= x.length;
    const rms = Math.sqrt(energy / x.length);
    if (!QUIET(file, s.head, ir)) assert.ok(db(energy / x.length) > -70, `${file} ${s.head}: it sounds`);
    // Its sound, not an offset: the YM2612's floor left in a stem is most
    // of a quiet one's level.
    assert.ok(Math.abs(mean) < 0.25 * rms + 1e-4, `${file} ${s.head}: no offset (mean ${mean.toFixed(4)}, rms ${rms.toFixed(4)})`);
    // A DAC stem rests at zero after its last sound (m3-pcm-softmix's notes
    // all end): the DAC at rest is channel 6 at rest, the floor's.
    if (file === "drv/tests/m3-pcm-softmix.mmlisp") {
      let tail = 0;
      for (let i = x.length - 1920; i < x.length; i++) tail += x[i];
      tail /= 1920;
      assert.ok(Math.abs(tail) < 1e-4, `${file} ${s.head}: rests at zero (${(tail * 32767).toFixed(1)} LSB)`);
    }
  }
  assert.ok(durationSec > 0);
  console.log(`  ${file}: ${stems.map((s, i) => stemName(i, s.head)).join(" ")}`);
}

// ── The sum ───────────────────────────────────────────────────────────────
const ADDS_UP = ["tools/tests/pc88/ssg.mmlisp", "tools/tests/msx/psg.mmlisp", "tools/tests/gb/apu.mmlisp", "tools/tests/pce/wave.mmlisp"];
for (const file of ADDS_UP) {
  const { stems, pcm, make } = await stemsOf(file);
  const mix = await renderWavSamples(make(), { pcm });
  const off = make();
  off.soloTrack(-1, true);
  const floor = await renderWavSamples(off, { pcm });
  const xs = stems.map((s) => samples(s.bytes));
  let em = 0, er = 0;
  for (let i = 0; i < mix.L.length; i++) {
    for (const [side, m, f] of [[0, mix.L, floor.L], [1, mix.R, floor.R]]) {
      let sum = f[Math.min(i, f.length - 1)];
      for (const x of xs) sum += x[2 * i + side] ?? 0;
      em += m[i] ** 2;
      er += (sum - m[i]) ** 2;
    }
  }
  const residual = db(er / em);
  assert.ok(residual < -45, `${file}: the stems add up to the WAV (${residual.toFixed(1)} dB)`);
  console.log(`  ${file}: the stems and the floor are the WAV to ${residual.toFixed(1)} dB`);
}

console.log("check:stems ok");

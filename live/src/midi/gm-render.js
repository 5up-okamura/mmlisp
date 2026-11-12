// ---------------------------------------------------------------------------
// A score rendered on the GM output's SoundFont: `:target midi`'s WAV, its
// stems and the MCP render (export-wav.js renderWavSamples hands it over).
//
// The machine has no register log to play back: what sounds is the MIDI
// export's plan (export-midi.js midiPlan), so a render runs MidiOutRun
// (midi-output.js) as the GM output does, on a clock of its own made from
// the plan's tempo map, into the same synthesizer (gm-synth.js) — what Live
// plays, rendered. Its length is the WAV export's: a looping score's loop
// twice and a fade, a one-shot to where its last voice has faded out.
// Mute and solo are the player's (a stem's strip soloed).
// ---------------------------------------------------------------------------

import { midiPlan } from "../export/export-midi.js";
import { MidiOutRun } from "./midi-output.js";
import { planVoices, GM_REVERB_DEFAULT } from "./gm-output.js";
import { GmSynth } from "./gm-synth.js";

const QUANTUM = 128;
const PASS_FRAMES = 1024; // MidiOutRun sends ahead every ~20 ms, as Live's timer does
const TAIL_MAX_SEC = 8; // a one-shot's release, at most
const TAIL_FLOOR = 1e-4; // −80 dB: where the release ends

/**
 * The plan's clock: seconds at a tick, and the tick at a second, on its
 * tempo map (the conductor's set tempos, 96 ticks a quarter).
 */
export function planClock(plan) {
  const tempos = (plan.conductor ?? [])
    .filter((e) => e.bytes[0] === 0xff && e.bytes[1] === 0x51)
    .map((e) => [e.tick, ((e.bytes[3] << 16) | (e.bytes[4] << 8) | e.bytes[5]) / 1e6 / plan.ppqn])
    .sort((a, b) => a[0] - b[0]);
  // [tick, sec, seconds a tick] from each change; 120 BPM before the first.
  const segs = [[0, 0, 0.5 / plan.ppqn]];
  for (const [tick, spt] of tempos) {
    const last = segs.at(-1);
    const sec = last[1] + (tick - last[0]) * last[2];
    if (tick === last[0]) segs[segs.length - 1] = [tick, last[1], spt];
    else segs.push([tick, sec, spt]);
  }
  const secAt = (tick) => {
    let s = segs[0];
    for (const x of segs) if (x[0] <= tick) s = x; else break;
    return s[1] + (tick - s[0]) * s[2];
  };
  const tickAt = (sec) => {
    let s = segs[0];
    for (const x of segs) if (x[1] <= sec) s = x; else break;
    return s[0] + (sec - s[1]) / s[2];
  };
  return { secAt, tickAt };
}

/**
 * The stereo float buffers of `player`'s score on `bank` (a SoundFont's
 * bytes, kept for the render), as renderWavSamples returns them.
 */
export async function renderGmSamples(player, { bank, reverb = GM_REVERB_DEFAULT, sampleRate = 48000, fadeSec = 4, onProgress = null } = {}) {
  const ir = player.loadedIr();
  if (!ir) throw new Error("No IR loaded");
  const plan = midiPlan(ir);
  const { secAt, tickAt } = planClock(plan);
  const looping = plan.loopStart != null;
  const endSec = secAt(plan.endTick);
  const loopSec = looping ? secAt(plan.loopStart) : null;
  const P = looping ? endSec - loopSec : 0;
  // Where the run is at a second: the first pass on the tempo map, a pass
  // after it the first loop pass's time again (as the WAV export tiles a
  // chip's loop body), its ticks counting on (MidiOutRun wraps them).
  const rawAt = (t) => {
    if (!looping || t < endSec || P <= 0) return tickAt(t);
    const k = Math.floor((t - endSec) / P);
    return plan.endTick + k * (plan.endTick - plan.loopStart) + (tickAt(loopSec + (t - endSec - k * P)) - plan.loopStart);
  };
  const clock = {
    isPlaying: () => true,
    loadedIr: () => ir,
    runNumber: () => 0,
    pendingSwapTime: () => null,
    lookaheadSec: () => 0.05,
    loopEnabled: () => looping,
    heldTracks: () => [],
    isTrackAudible: (ti) => player.isTrackAudible?.(ti) ?? true,
    trackTickAt: (_ti, t) => ({ raw: rawAt(t) }),
  };

  const gm = new GmSynth(sampleRate);
  gm.setReverb(reverb);
  await gm.load(bank);
  gm.preload(planVoices(plan));
  const run = new MidiOutRun({
    send: (bytes, ms) => gm.schedule([[bytes, ms / 1000]]),
    clear: () => gm.clear(),
    perfAt: (t) => t * 1000,
  });
  run.setPlan(plan, ir);

  const songSec = looping ? endSec + P + fadeSec : endSec;
  const total = Math.max(1, Math.ceil((songSec + (looping ? 0 : TAIL_MAX_SEC)) * sampleRate));
  const L = new Float32Array(total), R = new Float32Array(total);
  const songEnd = Math.round(songSec * sampleRate);
  let quiet = 0, end = total;
  for (let at = 0; at < total; at += QUANTUM) {
    const now = at / sampleRate;
    if (at % PASS_FRAMES === 0 && at < songEnd) run.pass(clock, now);
    const n = Math.min(QUANTUM, total - at);
    gm.render(L, R, at, n, now);
    // A one-shot ends where its last voice has faded (a quarter second
    // under the floor), past its last note.
    if (!looping && at >= songEnd) {
      let peak = 0;
      for (let i = at; i < at + n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      quiet = peak < TAIL_FLOOR ? quiet + n : 0;
      if (quiet >= sampleRate / 4) { end = at + n; break; }
    }
    if (onProgress && at % (QUANTUM * 512) === 0) { onProgress(at / total); await new Promise((r) => setTimeout(r, 0)); }
  }
  gm.close();
  if (looping) {
    const from = Math.round((endSec + P) * sampleRate);
    for (let i = from; i < total; i++) { const g = 1 - (i - from) / (total - from); L[i] *= g; R[i] *= g; }
  }
  onProgress?.(1);
  const out = end < total ? { L: L.slice(0, end), R: R.slice(0, end) } : { L, R };
  return { ...out, sampleRate, pcmCount: 0, durationSec: out.L.length / sampleRate };
}

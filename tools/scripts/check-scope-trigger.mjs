#!/usr/bin/env node
// Exercise live/src/scope-trigger.js on synthetic chip-like waves.
//
// The oscilloscope is judged by eye, but the property that makes it readable —
// the trace standing still while a note holds — is exactly what is hard to see
// in a screenshot. So assert it numerically here, and print the per-frame cost
// of running the trigger on all 10 scope channels.
import assert from 'node:assert/strict';
import { CorrelationTrigger, TRIGGER_STRIDE } from '../../live/src/scope-trigger.js';

const SR = 48000;
const RING = 16384;              // live/index.html SCOPE_RING
const GAIN = 10;                 // live/index.html SCOPE_DISPLAY_GAIN
const FRAME = Math.round(SR / 60);
const AMP = 1 / 16;              // a full-scale channel, in mix-contribution units

// ---- synthetic voices (phase in cycles) ----
const pulse = (duty) => (ph) => ((ph % 1) < duty ? AMP : -AMP);
const saw = () => (ph) => AMP * (2 * ((ph % 1)) - 1);
// 2-op FM whose index sweeps over ~1s, i.e. a timbre that evolves under a note.
const fm = () => (ph, t) => {
  const index = 1 + 3 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 1.0));
  return AMP * Math.sin(2 * Math.PI * ph + index * Math.sin(2 * Math.PI * ph));
};

function fill(ring, from, count, freq, shape, t0) {
  for (let i = 0; i < count; i++) {
    const n = from + i;
    const t = n / SR;
    ring[((n % RING) + RING) % RING] = freq > 0 ? shape(freq * t, t - t0) : shape(0, t - t0);
  }
}

// Run `frames` frames of one steady note. Each entry keeps the trigger and a
// snapshot of the wave around it, taken there and then: the ring wraps every
// 341ms, so an early trigger's samples are long gone by the last frame.
const CTX = 4 * TRIGGER_STRIDE;
function runNote({ freq, shape, frames = 60, trig, ring, start = 0 }) {
  const out = [];
  let latest = start;
  for (let f = 0; f < frames; f++) {
    fill(ring, latest, FRAME, freq, shape, start / SR);
    latest += FRAME;
    const t = trig.getTrigger(ring, latest, freq);
    const ctx = new Float32Array(2 * CTX + 1);
    for (let d = -CTX; d <= CTX; d++) ctx[d + CTX] = ring[(((t + d) % RING) + RING) % RING];
    out.push({ t, ctx });
  }
  return out;
}

function phaseErr(delta, P) {
  const m = ((delta % P) + P) % P;
  return Math.min(m, P - m);
}

// Frames where the trace visibly jumped: the trigger's phase within the period
// moved by more than one trigger subsample since the previous frame. Zero hops
// means a perfectly still trace. A wave whose shape changes (an FM index
// sweep, a new note) legitimately re-locks onto a different edge now and then,
// which is one hop — what must not happen is hopping every frame.
// The post trigger lands on the exact zero crossing, so a still trace should
// not move by even one sample; allow one for rounding.
const PHASE_TOL = 1;
function hops(ts, P, from = 0) {
  let n = 0;
  for (let i = from + 1; i < ts.length; i++) {
    if (phaseErr(ts[i].t - ts[i - 1].t, P) > PHASE_TOL) n++;
  }
  return n;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n     ${e.message.split('\n')[0]}`);
  }
}

// A steady note: the trigger must ride a rising edge, hold its phase, and
// never move backwards.
function steady(name, freq, shape, maxHops = 0) {
  check(name, () => {
    const ring = new Float32Array(RING);
    const trig = new CorrelationTrigger(SR, GAIN);
    const ts = runNote({ freq, shape, frames: 60, trig, ring });
    const P = SR / freq;
    // (c) monotonic
    for (let i = 1; i < ts.length; i++) {
      assert.ok(ts[i].t >= ts[i - 1].t, `frame ${i}: trigger moved backwards`);
    }
    // settle for 10 frames, then (b) the trace stands still
    const n = hops(ts, P, 10);
    assert.ok(n <= maxHops, `${n} phase hops after settling (allowed ${maxHops}, period ${P.toFixed(1)})`);
    // (a) a rising zero crossing sits within a stride of the trigger
    for (const { t, ctx } of ts.slice(10)) {
      let rising = false;
      for (let d = 0; d < ctx.length - 1; d++) {
        if (ctx[d] < 0 && ctx[d + 1] >= 0) rising = true;
      }
      assert.ok(rising, `trigger ${t} is not on a rising zero crossing`);
    }
  });
}

steady('50% pulse, 110Hz (FM bass)', 110, pulse(0.5));
steady('12.5% pulse, 440Hz (PSG lead)', 440, pulse(0.125));
steady('saw, 220Hz', 220, saw());
// A sweeping FM index reshapes the wave until a different rising edge becomes
// the better lock. Over one up-and-down sweep of the index that happens twice,
// symmetrically (measured at index ~2.3 either way); per-frame hopping is what
// must not happen.
steady('2-op FM with a sweeping index, 330Hz', 330, fm(), 2);

// A note change must re-lock quickly, and still never rewind.
check('note change C4 -> G4 re-locks within 3 frames', () => {
  const ring = new Float32Array(RING);
  const trig = new CorrelationTrigger(SR, GAIN);
  runNote({ freq: 261.63, shape: fm(), frames: 30, trig, ring });
  const b = runNote({ freq: 392.0, shape: fm(), frames: 20, trig, ring, start: 30 * FRAME });
  for (let i = 1; i < b.length; i++) assert.ok(b[i].t >= b[i - 1].t, `frame ${i}: trigger moved backwards`);
  const P = SR / 392.0;
  const n = hops(b, P, 3);
  assert.ok(n <= 1, `${n} phase hops in the 17 frames after the change (allowed 1)`);
});

// Unpitched material (a DAC one-shot, PSG noise): no period is reported, so
// the buffer is disabled and only the edge trigger runs. It must stay finite
// and inside the ring's valid span.
check('unpitched one-shot (freq 0) stays finite', () => {
  const ring = new Float32Array(RING);
  const trig = new CorrelationTrigger(SR, GAIN);
  let latest = 0;
  let prng = 12345;
  for (let f = 0; f < 30; f++) {
    for (let i = 0; i < FRAME; i++) {
      prng = (prng * 1103515245 + 12345) & 0x7fffffff;
      const env = Math.max(0, 1 - (latest + i) / (SR * 0.2));
      ring[((latest + i) % RING)] = AMP * env * (prng / 0x3fffffff - 1);
    }
    latest += FRAME;
    const t = trig.getTrigger(ring, latest, 0);
    assert.ok(Number.isFinite(t), `frame ${f}: trigger is ${t}`);
    assert.ok(t <= latest && t > latest - RING, `frame ${f}: trigger ${t} outside the ring (latest ${latest})`);
  }
});

check('silence returns a finite, advancing trigger', () => {
  const ring = new Float32Array(RING);
  const trig = new CorrelationTrigger(SR, GAIN);
  let latest = 0, prev = -Infinity;
  for (let f = 0; f < 20; f++) {
    latest += FRAME;
    const t = trig.getTrigger(ring, latest, 0);
    assert.ok(Number.isFinite(t), `frame ${f}: trigger is ${t}`);
    assert.ok(t >= prev, `frame ${f}: trigger moved backwards`);
    prev = t;
  }
});

// Cost: the live scope runs this for 10 channels every animation frame.
{
  const CH = 10;
  const rings = Array.from({ length: CH }, () => new Float32Array(RING));
  const trigs = Array.from({ length: CH }, () => new CorrelationTrigger(SR, GAIN));
  const freqs = [55, 110, 220, 330, 440, 0, 660, 880, 1320, 0];
  const shapes = [fm(), pulse(0.5), saw(), fm(), pulse(0.125), saw(), pulse(0.25), saw(), fm(), pulse(0.5)];
  let latest = 0;
  const FRAMES = 300;
  // warm up JIT
  for (let f = 0; f < 30; f++) {
    for (let c = 0; c < CH; c++) fill(rings[c], latest, FRAME, freqs[c] || 220, shapes[c], 0);
    latest += FRAME;
    for (let c = 0; c < CH; c++) trigs[c].getTrigger(rings[c], latest, freqs[c]);
  }
  let total = 0;
  for (let f = 0; f < FRAMES; f++) {
    for (let c = 0; c < CH; c++) fill(rings[c], latest, FRAME, freqs[c] || 220, shapes[c], 0);
    latest += FRAME;
    const t0 = performance.now();
    for (let c = 0; c < CH; c++) trigs[c].getTrigger(rings[c], latest, freqs[c]);
    total += performance.now() - t0;
  }
  console.log(`\ncost ${CH} channels: ${(total / FRAMES).toFixed(2)} ms/frame (stride ${TRIGGER_STRIDE})`);
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

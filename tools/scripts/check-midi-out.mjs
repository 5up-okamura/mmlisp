#!/usr/bin/env node
// MMLisp > MIDI > Output (live/src/midi-output.js): the MIDI export's plan
// (export-midi.js midiPlan) sent ahead on the preview's clock.
//
//   the player's clock  an IRPlayer run on a stand-in AudioContext, stepped
//                       by hand: each note on goes out when the YM2612's
//                       key-on does, through a tempo change and round the
//                       loop; a seek sends the channel's program before its
//                       notes
//   the run's turns     on a stand-in player: a muted track sends no key
//                       and lets one go at the mute, a stop lets every key
//                       go with All Notes Off — after what was sent ahead,
//                       or with it cleared — a hot-swap stops the outgoing
//                       plan at its bar and the incoming one goes on from
//                       there unchased, the loop going round leaves what stood
//                       before its label and lets its last key go, a seek
//                       while playing starts over (chased round the loop), a
//                       plan made again (a def-val moved)
//                       sends nothing twice, a plan that comes late sends
//                       what fell due since the run began
//   Live's keyboards    a key on `:target midi` goes out at once; stopped,
//                       after its channel's opening voice (bank, program,
//                       volume, pan before its first key), playing, alone
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { midiPlan } from "../../live/src/export-midi.js";
import { MidiOutRun, channelOpening } from "../../live/src/midi-output.js";
import { IRPlayer } from "../../live/src/ir-player.js";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const imports = new Map([["presets/gm/set.mmlisp", readFileSync("live/presets/gm/set.mmlisp", "utf8")]]);
const compile = (src, opts = {}) => {
  const { ir, diagnostics } = compileMMLisp(src, "out.mmlisp", { imports, ...opts });
  const errs = diagnostics.filter((d) => d.severity === "error");
  assert.equal(errs.length, 0, errs.map((d) => d.message).join("; "));
  return ir;
};
// The player's IR, and the plan of the same score as Live makes it (the
// compile worker's 'midi': voices kept, no hoist).
const both = (src, vals) => {
  const ir = compile(src);
  return { ir, plan: midiPlan(compile(src, { voiceStamps: true, voiceHoist: false }), { vals }) };
};
const isOn = (b) => (b[0] & 0xf0) === 0x90 && b[2] > 0;
const isOff = (b) => (b[0] & 0xf0) === 0x80 || ((b[0] & 0xf0) === 0x90 && b[2] === 0);
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what}: ${a.toFixed(4)} vs ${b.toFixed(4)}`);

// ── The player's clock ────────────────────────────────────────────────────
{
  const SRC = `(import "presets/gm/set.mmlisp")
(fm1 :tempo 120 gm-flute :len 4 #top c d :tempo 60 e f :tempo 120 (go top))`;
  const { ir, plan } = both(SRC);
  const keyOns = [];
  const player = new IRPlayer((port, addr, data, when) => {
    if (typeof port !== "object" && port === 0 && addr === 0x28 && (data & 0xf0) && (data & 7) === 0) keyOns.push(when);
  });
  player.loadJSON(ir);
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.setPlan(plan, ir);
  const ctx = { currentTime: 10, state: "running", resume() {} };
  player.play(ctx);
  for (let t = 10; t < 18.5; t += 0.01) {
    ctx.currentTime = t;
    clearTimeout(player._schedulerTimer);
    player._scheduleLoop();
    clearTimeout(player._schedulerTimer);
    run.pass(player, t);
  }
  player.stop();
  run.pass(player, 18.5);
  const ons = sent.filter((m) => isOn(m.b)).map((m) => m.t);
  const keys = keyOns.filter((t) => t < 18.4);
  assert.ok(ons.length >= 8, `two passes of the loop went out (${ons.length})`);
  // Each note on, the chip's key-on: through :tempo 60 and back, round the loop.
  for (const [i, t] of ons.slice(0, keys.length).entries()) near(t, keys[i], 0.002, `note ${i}`);
  assert.deepEqual(sent.filter((m) => (m.b[0] & 0xf0) === 0xc0).map((m) => m.b[1]), [73], "gm-flute, once");
  assert.ok(sent.at(-1).b[1] === 123, "a stop ends with All Notes Off");
}
{ // A seek: the channel's program and level go first, then its notes.
  const { ir, plan } = both(`(import "presets/gm/set.mmlisp")
(fm1 :tempo 120 gm-organ-drawbar :len 4 :vol 24 c d e f g a b > c)`);
  const player = new IRPlayer(() => {});
  player.loadJSON(ir);
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.setPlan(plan, ir);
  const ctx = { currentTime: 5, state: "running", resume() {} };
  player.seek(ctx, { sec: 2.1 });
  for (let t = 5; t < 6; t += 0.01) {
    ctx.currentTime = t;
    clearTimeout(player._schedulerTimer);
    player._scheduleLoop();
    clearTimeout(player._schedulerTimer);
    run.pass(player, t);
  }
  player.stop();
  const first = sent.findIndex((m) => isOn(m.b));
  const before = sent.slice(0, first).map((m) => m.b);
  assert.ok(before.some((b) => (b[0] & 0xf0) === 0xc0 && b[1] === 16), "the organ's program, chased");
  assert.ok(before.some((b) => (b[0] & 0xf0) === 0xb0 && b[1] === 7 && b[2] === 57), "its :vol 24, chased");
  assert.equal(sent[first].b[1], 69, "the first note after 2.1 s (tick 403) is a4, at tick 480");
}

// ── The run's turns, on a stand-in player ─────────────────────────────────
function standIn(ir, { spt = 0.5 / 96, start = 0 } = {}) {
  const p = {
    ir, playing: true, start, spt, muted: new Set(), swapTime: null, held: [], ahead: 0.2,
    isPlaying: () => p.playing,
    loadedIr: () => p.ir,
    pendingSwapTime: () => p.swapTime,
    lookaheadSec: () => p.ahead,
    isTrackAudible: (ti) => !p.muted.has(ti),
    heldTracks: () => p.held,
    trackTickAt: (ti, t) => ({ raw: (t - p.start) / p.spt, tick: (t - p.start) / p.spt }),
  };
  return p;
}
const drive = (run, p, from, to, step = 0.025) => { for (let t = from; t < to; t += step) run.pass(p, t); };
const SONG = `(fm1 :tempo 120 :len 4 c d e f)\n(fm2 :len 2 g a)`;

{ // Mute: no keys; muted mid-note, the key goes at once.
  const { ir, plan } = both(SONG);
  const p = standIn(ir);
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.setPlan(plan, ir);
  p.muted.add(1);
  drive(run, p, 0, 0.6);
  assert.ok(!sent.some((m) => isOn(m.b) && (m.b[0] & 0x0f) === 1), "a muted fm2 keys nothing");
  p.muted.add(0);
  drive(run, p, 0.6, 0.7);
  const offs = sent.filter((m) => isOff(m.b) && (m.b[0] & 0x0f) === 0 && m.t >= 0.6 && m.t < 0.65);
  assert.ok(offs.length >= 1, "fm1 muted mid-note: its key let go at the mute");
}
{ // The panel's level (Live: a strip's :vol, the MASTER in hand): a melodic
  // channel's CC7 is the panel's, sent as it moves and over the plan's (−12 dB
  // is 64 on GM's curve); its keys' velocity stays the score's; at 0, a mute.
  const { ir, plan } = both(SONG);
  const p = standIn(ir);
  const sent = [];
  const levels = [{ vol: 25, master: 31, scoreVol: 31, scoreMaster: 31 }, { vol: 0, master: 31, scoreVol: 31, scoreMaster: 31 }];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }), levelOf: (ti) => levels[ti] });
  run.setPlan(plan, ir);
  drive(run, p, 0, 0.6);
  const cc7 = sent.filter((m) => (m.b[0] & 0xf0) === 0xb0 && m.b[1] === 7 && (m.b[0] & 0x0f) === 0);
  assert.ok(cc7.length && cc7.at(-1).b[2] === 64, `fm1's CC7 the panel's: ${cc7.map((m) => m.b[2])}`);
  assert.ok(!sent.some((m) => isOn(m.b) && (m.b[0] & 0x0f) === 1), "fm2 at 0 keys nothing");
  const plain = [];
  const run2 = new MidiOutRun({ send: (b, ms) => plain.push({ b, t: ms / 1000 }) });
  run2.setPlan(plan, ir);
  drive(run2, standIn(ir), 0, 0.6);
  const vels = (list) => list.filter((m) => isOn(m.b) && (m.b[0] & 0x0f) === 0).map((m) => m.b[2]).join();
  assert.equal(vels(sent), vels(plain), "fm1's keys at the score's velocity");
  // Let go and written over by the score: its CC7 as the plan last had it.
  levels[0] = null;
  run.pass(p, 0.6);
  const back = sent.filter((m) => (m.b[0] & 0xf0) === 0xb0 && m.b[1] === 7 && (m.b[0] & 0x0f) === 0).at(-1);
  assert.equal(back.b[2], 127, "the score's CC7 back");
}
{ // Stop: every key, then All Notes Off on each channel.
  const { ir, plan } = both(SONG);
  const p = standIn(ir);
  const sent = [];
  const run = new MidiOutRun({ send: (b) => sent.push(b) });
  run.setPlan(plan, ir);
  drive(run, p, 0, 0.3);
  p.playing = false;
  run.pass(p, 0.3);
  const tail = sent.slice(-4);
  assert.deepEqual(tail.filter((b) => b[1] === 123).map((b) => b[0] & 0x0f).sort(), [0, 1], "All Notes Off on both channels");
  const held = new Map();
  for (const b of sent) if (isOn(b)) held.set(`${b[0] & 15}:${b[1]}`, 1); else if (isOff(b)) held.delete(`${b[0] & 15}:${b[1]}`);
  assert.equal(held.size, 0, "no key left on");
}
{ // A stop with keys sent ahead: each off after its own on, by timestamp —
  // the output plays what it was sent in time order, so a key must not end
  // up held; with clear(), what was ahead is dropped and all goes now —
  // a key's off too, sent ahead of a stop that came before it (at 0.4, c's
  // off at 0.5 had gone out): the key is let go with an off of its own, not
  // only All Notes Off, which a module may ignore.
  for (const [withClear, stopAt] of [[false, 0.26], [true, 0.26], [true, 0.4]]) {
    const { ir, plan } = both(SONG);
    const p = standIn(ir);
    const sent = [];
    const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }), clear: withClear ? () => sent.splice(0, sent.length, ...sent.filter((m) => m.t <= stopAt)) : null });
    run.setPlan(plan, ir);
    drive(run, p, 0, stopAt); // d (0.5) sent ahead by now
    p.playing = false;
    run.pass(p, stopAt);
    const byTime = [...sent].sort((x, y) => x.t - y.t);
    const held = new Set();
    for (const m of byTime) { const k = `${m.b[0] & 15}:${m.b[1]}`; if (isOn(m.b)) held.add(k); else if (isOff(m.b)) held.delete(k); }
    assert.equal(held.size, 0, `no key held, in time order${withClear ? ` (cleared at ${stopAt})` : ""}: ${[...held]}`);
    if (withClear) assert.ok(!sent.some((m) => isOn(m.b) && m.t > stopAt), "cleared: nothing ahead sounds");
  }
}
{ // A hot-swap: nothing past the bar from the outgoing plan; the incoming
  // plan from the bar, its controllers not chased.
  const a = both(SONG), b = both(`(fm1 :tempo 120 :len 4 > c d e f)\n(fm2 :len 2 g a)`);
  const p = standIn(a.ir);
  const sent = [];
  const run = new MidiOutRun({ send: (bytes, ms) => sent.push({ b: bytes, t: ms / 1000 }) });
  run.setPlan(a.plan, a.ir);
  drive(run, p, 0, 0.4);
  p.swapTime = 1.0;
  drive(run, p, 0.4, 0.95);
  assert.ok(!sent.some((m) => isOn(m.b) && m.t >= 1.0), "the outgoing plan stops at the bar");
  p.swapTime = null;
  p.ir = b.ir; // committed
  const at = sent.length;
  run.pass(p, 0.96); // the plan is coming: nothing
  assert.equal(sent.length, at + 0, "nothing while its plan comes");
  run.setPlan(b.plan, b.ir);
  drive(run, p, 0.97, 1.6);
  const next = sent.slice(at);
  assert.ok(!next.some((m) => (m.b[0] & 0xf0) === 0xb0 && m.b[1] === 7 && m.t < 1.0), "no chase at a swap");
  assert.ok(next.some((m) => isOn(m.b) && m.b[1] === 76 && Math.abs(m.t - 1.0) < 1e-6), "the incoming e5 at the bar (tick 192)");
}
{ // A plan made again for the same IR: nothing sent twice.
  const SRC = `(def-val depth 0 0..127 :public)\n(fm1 :tempo 120 :len 8 c d e f g a b > c)`;
  const { ir, plan } = both(SRC);
  const p = standIn(ir);
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.setPlan(plan, ir);
  drive(run, p, 0, 0.5);
  run.setPlan(both(SRC, { depth: 64 }).plan, ir);
  drive(run, p, 0.5, 1.2);
  const ons = sent.filter((m) => isOn(m.b)).map((m) => m.t.toFixed(4));
  assert.equal(new Set(ons).size, ons.length, "each note once");
  assert.equal(ons.length, 6, "c d e f g a: by 1.2 s and its 0.2 s lookahead");
}
{ // Round the loop: what stood before the label at the loop point plays
  // once — the second pass keeps :vol 20, as the chip does (no write at #top).
  const { ir, plan } = both("(fm1 :tempo 120 :len 4 :vol 31 #top c :vol 20 d (go top))");
  const p = standIn(ir);
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.setPlan(plan, ir);
  drive(run, p, 0, 2.2);
  const cc7 = sent.filter((m) => (m.b[0] & 0xf0) === 0xb0 && m.b[1] === 7).map((m) => [m.t, m.b[2]]);
  // (the body's :vol 20 is written each pass, as the chip has it written)
  assert.deepEqual(cc7.map(([t, v]) => [Math.round(t * 1000) / 1000, v]), [[0, 127], [0.5, 36], [1.5, 36]], ":vol 31 once, never back round the loop");
  assert.equal(sent.filter((m) => isOn(m.b)).length, 5, "c d c d c by 2.2 s");
}
{ // The loop's end: the last note's off goes there (it sits at endTick), so
  // no key is left held round the loop.
  const { ir, plan } = both("(fm1 :tempo 120 :len 4 #top c d e f (go top))");
  const p = standIn(ir);
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.setPlan(plan, ir);
  drive(run, p, 0, 4.4);
  const fOff = sent.filter((m) => isOff(m.b) && m.b[1] === 65).map((m) => Math.round(m.t * 1000) / 1000);
  assert.deepEqual(fOff, [2, 4], "f let go at each pass's end");
}
{ // A seek while playing (IRPlayer runNumber): the keys let go, the run over
  // from its point, chased, and nothing between the two points sent.
  const { ir, plan } = both("(fm1 :tempo 120 :len 4 :vol 31 #top c :vol 20 d e f (go top))");
  const p = standIn(ir);
  p.runs = 1;
  p.runNumber = () => p.runs;
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.setPlan(plan, ir);
  drive(run, p, 0, 0.6);
  const at = sent.length;
  // To 2.05 s: the second pass's c (tick 384+, after :vol 20 went by).
  p.runs++;
  p.start = 0.6 - 2.05;
  drive(run, p, 0.6, 0.9);
  const next = sent.slice(at);
  assert.ok(next.findIndex((m) => m.b[1] === 123) < next.findIndex((m) => (m.b[0] & 0xf0) === 0xb0 && m.b[1] === 7), "let go, then chased");
  const cc7 = next.find((m) => (m.b[0] & 0xf0) === 0xb0 && m.b[1] === 7);
  assert.equal(cc7.b[2], 36, "chased round the loop: :vol 20 stands, not the :vol 31 before the label");
  assert.ok(next.filter((m) => isOn(m.b)).length <= 1, "no burst of what lay between");
}
{ // `once` is what stood before a label at the loop point: a track that
  // loops from earlier writes its body's there (a vel step at tick 96 here).
  const { plan } = both("(fm1 :tempo 120 :len 2 #top (macro :step 48t :vel [15 10 5 1]) c (go top))\n(fm2 :len 4 c)");
  assert.equal(plan.loopStart, 96);
  const at96 = plan.tracks[0].events.filter((e) => e.tick === 96 && (e.bytes[0] & 0xf0) === 0xb0);
  assert.ok(at96.length && at96.every((e) => !e.once), "fm1's CC11 at the loop point is its body's");
}
{ // The preview's loop off (IRPlayer loopEnabled): nothing round the loop.
  const { ir, plan } = both("(fm1 :tempo 120 :len 4 #top c d (go top))");
  const p = standIn(ir);
  p.loopEnabled = () => false;
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.setPlan(plan, ir);
  drive(run, p, 0, 1.6);
  assert.deepEqual(sent.filter((m) => isOn(m.b)).map((m) => m.b[1]), [60, 62], "once through, no second pass");
}
{ // A plan that comes late: what fell due since the run began goes at once.
  const { ir, plan } = both(SONG);
  const p = standIn(ir);
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b, t: ms / 1000 }) });
  run.pass(p, 0); // the run begins; no plan yet
  run.pass(p, 0.1);
  run.setPlan(plan, ir);
  run.pass(p, 0.12);
  const first = sent.filter((m) => isOn(m.b));
  assert.deepEqual(first.slice(0, 2).map((m) => [m.b[1], m.t]), [[60, 0.12], [67, 0.12]], "c and g, late, at once");
}

// ── Live's keyboards ──────────────────────────────────────────────────────
{
  const { ir, plan } = both(`(def-score :target midi)
(ch3 :tempo 120 :bank 130 gm-flute :vol 20 :pan -0.5 :len 4 c d gm-trumpet e)
(ch5 :len 4 _ :prog 20 c)`);
  assert.deepEqual(channelOpening(plan, 2), [[0xb2, 0, 1], [0xb2, 32, 2], [0xc2, 73], [0xb2, 7, 36], [0xb2, 10, 32]],
    "ch3's bank, program, volume and pan before its first key, not the trumpet after it");
  assert.deepEqual(channelOpening(plan, 4), [[0xc4, 20], [0xb4, 7, 127]], "a program after a rest is still the opening one");
  assert.deepEqual(channelOpening(plan, 0), [], "a channel the score does not use: nothing");
  const sent = [];
  const run = new MidiOutRun({ send: (b, ms) => sent.push({ b: [...b], t: ms / 1000 }) });
  run.setPlan(plan, ir);
  run.keyOn(ir, 2, 64, undefined, 1);
  run.keyOff(2, 64, 1.5);
  assert.deepEqual(sent.map((m) => m.b), [...channelOpening(plan, 2), [0x92, 64, 127], [0x82, 64, 0]], "stopped: the voice, then the key");
  assert.deepEqual(sent.map((m) => m.t), [1, 1, 1, 1, 1, 1, 1.5], "at once");
  sent.length = 0;
  run.running = true;
  run.keyOn(ir, 2, 64, 7, 2);
  assert.equal(sent.length, 1, "playing: the song's voice stands, the key alone");
  assert.ok(sent[0].b[2] > 1 && sent[0].b[2] < 127, "a :vel 7 key below full velocity");
}

console.log("check:midi-out ok");

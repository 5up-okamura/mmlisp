#!/usr/bin/env node
// The panel's controls, on both players (IRPlayer, DrvPlayer: hold / release
// / read). A control shows the score's value as it plays; held, its value is
// the panel's and the score's writes of it go unheard; let go, it stays until
// the score next writes it; a run starts with the score's own values.
//
//   cd tools && npm run check:panel
//
// Each case plays a score on a player stepped by hand, moves a control as
// Live's panel does and reads the control and the chip's writes back.
import assert from "node:assert/strict";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { IRPlayer } from "../../live/src/ir-player.js";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { encodeMmb } from "../../live/src/export-mmb.js";

const compile = (src) => {
  const { ir, diagnostics } = compileMMLisp(src, "panel.mmlisp", {});
  const errs = diagnostics.filter((d) => d.severity === "error");
  assert.equal(errs.length, 0, errs.map((d) => d.message).join("; "));
  return ir;
};

// A player and its clock: `to(sec)` plays up to `sec` of the song; `reg(addr)`
// the last value the chip's port-0 register took by then, `att(ch)` a PSG
// channel's attenuation (0 loud .. 15 off).
const isAtt = (data, ch) => (data & 0x90) === 0x90 && ((data >> 5) & 3) === ch;
const RIGS = {
  ir(ir) {
    const writes = [];
    const ctx = { currentTime: 10, state: "running", resume() {} };
    // A write with no time is the panel's own, played at once.
    const player = new IRPlayer((port, addr, data, when) => {
      if (typeof port !== "object") writes.push({ port, addr, data, when: when ?? ctx.currentTime });
    });
    player.loadJSON(ir);
    player.play(ctx);
    const t0 = 10.05; // play's own lead
    return {
      player,
      to(sec) {
        for (let t = ctx.currentTime; t <= t0 + sec + 1e-9; t += 0.005) {
          ctx.currentTime = t;
          clearTimeout(player._schedulerTimer);
          player._scheduleLoop();
          clearTimeout(player._schedulerTimer);
        }
      },
      reg(addr) {
        let last = null;
        for (const w of writes) if (w.port === 0 && w.addr === addr && w.when <= ctx.currentTime + 1e-9 && (!last || w.when >= last.when)) last = w;
        return last?.data ?? null;
      },
      att(ch) {
        let last = null;
        for (const w of writes) if (w.port === 2 && isAtt(w.data, ch) && w.when <= ctx.currentTime + 1e-9 && (!last || w.when >= last.when)) last = w;
        return last ? last.data & 15 : null;
      },
    };
  },
  drv(ir) {
    const reg = new Map();
    const atts = [null, null, null, null];
    const { bytes, sampleBank } = encodeMmb(ir);
    const player = new DrvPlayer((port, addr, data) => {
      if (typeof port === "object") return;
      if (port === 0) reg.set(addr & 0xff, data & 0xff);
      if (port === 2 && (data & 0x90) === 0x90) atts[(data >> 5) & 3] = data & 15;
    });
    player.loadMMB(bytes, sampleBank);
    player._reset(true);
    let frame = 0;
    return {
      player,
      to(sec) {
        for (; frame < Math.round(sec * 60); frame++) player.stepFrame();
      },
      reg: (addr) => reg.get(addr) ?? null,
      att: (ch) => atts[ch],
    };
  },
};

const word = (id) => ({ id, kind: "word", word: id });
const vol = (head, tracks) => ({ id: `vol:${head}`, kind: "vol", strip: { heads: [head], tracks } });
const val = (name) => ({ id: `val:${name}`, kind: "val", name });
const reg = (ch, w) => ({ id: `reg:${ch}:${w}`, kind: "reg", ch, word: w });
const TL4 = 0x4c; // fm1's op4: the carrier of every algorithm

let failed = 0;
const open = [];
function scene(name, src, body, { openOn = [] } = {}) {
  const ir = compile(src);
  for (const [which, make] of Object.entries(RIGS)) {
    try {
      body(make(ir), which);
    } catch (e) {
      if (openOn.includes(which)) { open.push(`${name} (${which}): ${e.message.replace(/\n+/g, " ")}`); continue; }
      failed++;
      console.error(`FAIL ${name} (${which}): ${e.message}`);
    }
  }
}

// 120 bpm: a quarter is 0.5 s.
scene("the panel shows the score's values",
  `(def-val depth 3 0..40 :public)
   (fm1 :tempo 120 :master 20 :vol 25 :len 4 c :depth 30 :master 28 :vol 9 :tempo 90 c c c)`,
  ({ player, to }) => {
    to(0.3);
    assert.equal(player.read(word("MASTER")).v, 20, "master");
    assert.equal(Math.round(player.read(word("tempo")).v), 120, "tempo");
    assert.equal(player.read(vol("fm1", [0])).v, 25, "vol");
    assert.equal(player.read(val("depth")).v, 3, "val");
    assert.equal(player.read(word("MASTER")).hand, false);
    to(1.0);
    assert.equal(player.read(word("MASTER")).v, 28, "master, written again");
    assert.equal(Math.round(player.read(word("tempo")).v), 90, "tempo, written again");
    assert.equal(player.read(vol("fm1", [0])).v, 9, "vol, written again");
    assert.equal(player.read(val("depth")).v, 30, "val, written again");
  });

scene("held, a control's value is the panel's and the score's writes wait; let go, it stays until the next",
  `(def-val depth 3 0..40 :public)
   (fm1 :tempo 120 :master 20 :vol 25 :len 4 c
        :depth 30 :master 28 :vol 9 :tempo 90 c c
        :depth 31 :master 29 :vol 10 :tempo 91 c c)`,
  ({ player, to }) => {
    const all = [[word("MASTER"), 5, 29], [word("tempo"), 150, 91], [vol("fm1", [0]), 7, 10], [val("depth"), 12, 31]];
    to(0.2);
    for (const [c, v] of all) player.hold(c, v);
    to(0.3);
    for (const [c, v] of all) assert.deepEqual([Math.round(player.read(c).v), player.read(c).hand], [v, true], `${c.id} held`);
    // The second note's writes fall under the hands (0.5 s at 120, held at
    // 150: sooner). The IR player takes a score write as it queues it, its
    // lookahead before it sounds: the hands let go well ahead of the next.
    to(0.7);
    for (const [c, v] of all) assert.equal(Math.round(player.read(c).v), v, `${c.id} under the score's write`);
    for (const [c] of all) player.release(c);
    to(0.75);
    for (const [c, v] of all) assert.deepEqual([Math.round(player.read(c).v), player.read(c).hand], [v, true], `${c.id} let go, not yet written`);
    to(3);
    for (const [c, , next] of all) assert.deepEqual([Math.round(player.read(c).v), player.read(c).hand], [next, false], `${c.id} taken back`);
  });

scene("a held level is what the chip plays",
  `(fm1 :tempo 120 :len 2 c c c c)`,
  ({ player, to, reg: r }) => {
    to(0.3);
    const full = r(TL4);
    player.hold(vol("fm1", [0]), 16);
    to(0.4);
    const faded = r(TL4);
    assert.ok(faded > full, `:vol 16 is quieter than 31 (TL ${full} → ${faded})`);
    to(1.3); // the next note composes with the hand
    assert.equal(r(TL4), faded, "the next note at the panel's level");
    player.hold(word("MASTER"), 16);
    to(1.4);
    assert.ok(r(TL4) > faded, "MASTER under it");
  });

scene("an FM register in hand",
  `(fm1 :tempo 120 :len 4 c :fb 2 c :fb 3 c c)`,
  ({ player, to, reg: r }) => {
    to(0.2);
    player.hold(reg(0, "FM_FB"), 6);
    to(0.7); // :fb 2 falls under the hand
    assert.equal((r(0xb0) >> 3) & 7, 6, "the panel's feedback on the chip");
    player.release(reg(0, "FM_FB"));
    to(1.3); // :fb 3 takes it back
    assert.equal((r(0xb0) >> 3) & 7, 3, "the score's again");
  });

// Held through the score's own motion: a sweep's and a macro's later frames
// stay under the hand. The IR player's chip is behind its run by the
// lookahead, and what the run had sent plays out: a hand has the chip within
// it (0.2 s), which is where these look.
const through = (name, src, c, value, read, louder = true) => scene(name, src, ({ player, to, reg: r, att }) => {
  r.att = att;
  to(0.5);
  const swept = read(r);
  player.hold(c, value);
  to(0.8);
  const held = read(r);
  if (louder === null) {
    // The note's own :vel runs on; the :vol under it is the panel's (louder than the score's).
    assert.ok(held < swept, `the panel's :vol under the note's :vel (att ${swept} → ${held})`);
    return;
  }
  if (louder) assert.ok(held < swept, `the panel's level over the sweep's (${swept} → ${held})`);
  else assert.equal(held, value, "the panel's value on the chip");
  to(1.5);
  assert.equal(read(r), held, "the score's frames stay under the hand");
});
through("a level held through the score's sweep",
  `(fm1 :tempo 120 :len 1 :vol (linear 31..0 :len 1/1) c c)`, vol("fm1", [0]), 31, (r) => r(TL4));
through("a level held through a note's :vol macro",
  `(fm1 :tempo 60 :len 1 (macro :vol [(linear 31..0 :len 1/1)]) c)`, vol("fm1", [0]), 31, (r) => r(TL4));
through("MASTER held through the score's sweep",
  `(fm1 :tempo 120 :len 1 :master (linear 31..0 :len 1/1) c c)`, word("MASTER"), 31, (r) => r(TL4));
through("an FM register held through the score's sweep",
  `(fm1 :tempo 120 :len 1 :fb (linear 0..7 :len 1/1) c c)`, reg(0, "FM_FB"), 1, (r) => (r(0xb0) >> 3) & 7, false);
through("an FM register held through a note's macro",
  `(fm1 :tempo 60 :len 1 (macro :fb [(linear 0..7 :len 1/1)]) c)`, reg(0, "FM_FB"), 1, (r) => (r(0xb0) >> 3) & 7, false);

through("a PSG lane's level held through the score's sweep",
  `(sqr1 :tempo 120 :len 1 :vol (linear 31..4 :len 1/1) c c)`, vol("sqr1", [0]), 31, (r) => r.att(0));
through("a PSG lane's level held through a note's :vel macro",
  `(sqr1 :tempo 60 :len 1 :vol 20 (macro :vel [(linear 15..4 :len 1/1)]) c)`, vol("sqr1", [0]), 31, (r) => r.att(0), null);

scene("MASTER let go follows the score's next write; the score's own ran on under it",
  `(fm1 :tempo 120 :len 4 :master 20 c :master 24 c c :master 28 c c)`,
  ({ player, to }, which) => {
    to(0.2);
    player.hold(word("MASTER"), 5);
    to(0.8);
    const held = player.read(word("MASTER"));
    assert.deepEqual([held.v, held.hand], [5, true]);
    // The IR player lays a level over the score's, which it keeps; the
    // driver's gate skips the score's write.
    if (which === "ir") assert.equal(held.score, 24, "the score's master under the hand");
    player.release(word("MASTER"));
    to(2.5);
    const back = player.read(word("MASTER"));
    assert.deepEqual([back.v, back.hand], [28, false], "taken back");
  });

for (const o of open) console.log(`open: ${o}`);
if (failed) process.exit(1);
console.log(`check:panel ok${open.length ? ` (${open.length} open)` : ""}`);

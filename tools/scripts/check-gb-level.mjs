// The Game Boy's level under a note (chips/lr35902.js): a score's register log
// lands on the level it asks for on the two ways a player reads NRx2 — the
// chip's zombie steps (synth-gb.js, SameBoy's rule) and MAME's core, which
// takes the high nibble at once — and a note's level moves trigger nothing.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileScoreFile } from "../../drv/tools/mmb-build.mjs";
import { IRPlayer } from "../../live/src/ir-player.js";
import { Apu } from "../../live/src/synth-gb.js";
import { lr35902 } from "../../live/src/chips/lr35902.js";
import { gbPitch } from "../../live/src/scope-pitch.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const logOf = (file) => {
  const { ir } = compileScoreFile(path.join(ROOT, file), {});
  const player = new IRPlayer(() => {});
  player.loadJSON(ir);
  return player.captureRegisterLog().writes;
};

// Every 4-bit level to every other, written as the encoder does, on the chip's
// rule from a trigger.
for (let from = 0; from < 16; from++)
  for (let to = 0; to < 16; to++) {
    const apu = new Apu();
    for (const [, a, d] of lr35902.init) apu.write(a, d);
    apu.write(0x02, (from << 4) | 8);
    apu.write(0x04, 0x80);
    for (let n = (to - from) & 15; n > 0; n--) apu.write(0x02, (to << 4) | 8);
    assert.equal(apu.env[0].volume, to, `${from} → ${to}`);
  }

// The score's own moves: a pulse's and the noise's levels, read both ways, agree
// after every burst of writes.
const NRX2 = { 0x02: 0, 0x07: 1, 0x11: 3 };
const NRX4 = { 0x04: 0, 0x09: 1, 0x13: 3 };
let moves = 0, triggers = 0;
{
  const writes = logOf("tools/tests/gb/apu.mmlisp");
  const apu = new Apu();
  const mame = [0, 0, 0, 0]; // MAME's envelope_value: NRx2's high nibble as written
  let i = 0;
  while (i < writes.length) {
    const sec = writes[i].sec;
    const seen = new Set();
    for (; i < writes.length && writes[i].sec === sec; i++) {
      const { addr, data } = writes[i];
      apu.write(addr, data);
      if (addr in NRX2) {
        mame[NRX2[addr]] = data >> 4;
        seen.add(NRX2[addr]);
        assert.equal(data & 7, 0, "the envelope's pace stays 0");
        assert.notEqual(data & 0xf8, 0, "the DAC stays on");
      }
      if (addr in NRX4 && data & 0x80) { triggers++; seen.delete(NRX4[addr]); }
    }
    for (const ch of seen) {
      assert.equal(apu.env[ch].volume, mame[ch], `channel ${ch} at ${sec} s`);
      moves++;
    }
  }
}
assert.ok(moves > 20, `a level macro's moves are zombie writes (${moves})`);

// A level macro does not trigger: one per note, and the slur none.
{
  const writes = logOf("tools/tests/gb/apu.mmlisp");
  const keyOns = (addr) => writes.filter((w) => w.addr === addr && w.data & 0x80).length;
  assert.ok(keyOns(0x04) <= 12, `sqr1's triggers: its notes and rests, not its macro's steps (${keyOns(0x04)})`);
  assert.equal(keyOns(0x09), 6, "sqr2: init, three notes, the one after the slur, the end");
}

// The wave: a note does not trigger, a load does, the same steps load once, and
// its level is NR32 alone.
{
  const writes = logOf("tools/tests/gb/wave.mmlisp");
  const loads = writes.filter((w) => w.addr === 0x0a && w.data === 0).length;
  assert.equal(loads, 4, "init, saw, tri2, saw again: not the tri2 named twice");
  assert.equal(writes.filter((w) => w.addr === 0x0e && w.data & 0x80).length, 4, "the wave triggers at a load");
  assert.deepEqual([...new Set(writes.filter((w) => w.addr === 0x0c).map((w) => w.data >> 5))].sort(), [0, 1, 2, 3]);
}

// A stop silences every channel, whatever the queue had run the state on to: a
// macro falling to 0 ahead of the stop must not leave a channel sounding.
{
  const enc = lr35902.psgEncoder();
  const [sqr1, sqr2] = enc.lanes;
  for (const [lane, l] of [[sqr1, 0], [sqr2, 1]]) { lane.keyOn(l, 1); lane.att(l, 0, 1); lane.att(l, 15, 2); }
  enc.flush(0.5);
  const writes = [...sqr1.att(0, 15), ...(enc.flush(Infinity), []), ...sqr2.att(1, 15)];
  assert.deepEqual(writes.filter((w) => w[1] === 0x07 || w[1] === 0x09).map((w) => [w[1], w[2] & 0x80]), [[0x07, 0], [0x09, 0x80]], "sqr2 keyed off after sqr1's stop flushed the queue");
}

// A silence is written where it is asked for, so a hot swap's dropped queue
// cannot leave a note on; asked again, it writes nothing.
{
  const enc = lr35902.psgEncoder();
  const [sqr1] = enc.lanes;
  sqr1.keyOn(0, 1);
  sqr1.att(0, 0, 1);
  assert.equal(sqr1.att(0, 15, 2).length, 2, "the key-off comes at once");
  assert.equal(sqr1.att(0, 15, 3).length, 0, "a second silence is nothing");
}

// The scope's latch reads each channel's low and high bytes (sqr2's NR23 is even).
{
  const out = new Float64Array(11);
  const pitch = gbPitch(4194304);
  for (const [a, d] of [[0x03, 0x00], [0x04, 0x87], [0x08, 0x00], [0x09, 0x87], [0x0d, 0x00], [0x0e, 0x87]]) pitch.write(0, a, d, out);
  assert.deepEqual([out[6], out[7], out[10]], [512, 512, 256]);
}

console.log(`Game Boy level checks passed: ${moves} level moves on both readings, ${triggers} triggers`);

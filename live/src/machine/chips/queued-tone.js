// A cartridge's tone channels as the IR player's lanes (the player's
// `toneEncoder`, ir-player.js _toneEncodersOf): the VRC6's, the MMC5's. Each
// channel has a control register holding its level (and a pulse's duty),
// which the player sends out of time order (a note's level macro its whole
// length ahead, then its duty macro), and a period whose high bits are
// written on a change only — so a write with a time is queued, and
// flush(horizon) applies them in time order, reading the state as it is
// then (chips/rp2a03.js's APU encoder, the same pattern with the noise). A
// silence is written at once (a level 0 is silent at any duty) and queued
// for the state; a write with no time (a key, a stop) goes to the chip now.
//
// `chip`: { port, channels, top(ch) the loudest level, ctl(ch) the control
// register, ctlByte(ch, duty, vol), lo(ch) / hi(ch) the period's registers,
// hiByte(bits) the high register's byte, period(ch) hz → the period,
// duty(sixteenths) → the chip's duty code (pulses: ch < pulses), pulses,
// startDuty }.
export function queuedToneEncoder(chip) {
  const { port, channels, pulses } = chip;
  let vol, duty, hi, last, queue;
  const reset = () => {
    vol = new Array(channels).fill(0);
    duty = new Array(pulses).fill(chip.startDuty);
    hi = new Array(channels).fill(-1); // the period's high bits as written; -1 none yet
    last = new Map(); // a control register's byte as written, in time order
    queue = [];
  };
  reset();
  const ctlByte = (ch, v) => chip.ctlByte(ch, duty[ch], v);
  const ctl = (ch) => {
    const data = ctlByte(ch, vol[ch]);
    if (last.get(ch) === data) return [];
    last.set(ch, data);
    return [[port, chip.ctl(ch), data]];
  };
  const apply = (op) => {
    const { ch } = op;
    switch (op.kind) {
      case "vol":
        vol[ch] = op.v;
        if (op.silent) {
          last.set(ch, ctlByte(ch, 0));
          return [];
        }
        return ctl(ch);
      case "duty":
        duty[ch] = op.v;
        return ctl(ch);
      case "tone": {
        const out = [[port, chip.lo(ch), op.v & 0xff]];
        if (hi[ch] !== op.v >> 8) out.push([port, chip.hi(ch), chip.hiByte((hi[ch] = op.v >> 8))]);
        return out;
      }
    }
    return [];
  };
  const take = (op, when) => {
    if (when === undefined || when === null) {
      last.delete(op.ch);
      return apply(op);
    }
    queue.push({ ...op, t: when });
    return [];
  };
  // A level: the player's attenuation on the part's ladder (0 loud), upside
  // down.
  const att = (ch, a, when) => {
    const top = chip.top(ch);
    const v = top - Math.max(0, Math.min(top, a | 0));
    if (v || when === undefined || when === null) return take({ kind: "vol", ch, v }, when);
    // A key-off at the time of a write still queued (a note shorter than
    // the frame it lands in): queued after it, so it comes after.
    if (queue.some((op) => op.ch === ch && op.t >= when - 1e-9)) return take({ kind: "vol", ch, v: 0 }, when);
    queue.push({ kind: "vol", ch, v: 0, silent: true, t: when });
    return [[port, chip.ctl(ch), ctlByte(ch, 0)]];
  };
  const view = (ch) => ({
    period: chip.period(ch),
    att: (_l, a, when) => att(ch, a, when),
    tone: (_l, p, when) => take({ kind: "tone", ch, v: p }, when),
    duty: ch < pulses ? (_l, d, when) => take({ kind: "duty", ch, v: chip.duty(d) }, when) : undefined,
  });
  return {
    lanes: Array.from({ length: channels }, (_, ch) => view(ch)),
    flush(horizon) {
      const due = queue.filter((op) => op.t <= horizon + 1e-9).sort((a, b) => a.t - b.t);
      if (!due.length) return [];
      queue = queue.filter((op) => op.t > horizon + 1e-9);
      return due.flatMap((op) => apply(op).map((w) => [...w, op.t]));
    },
    // A stop or a seek: what is queued does not play, and every channel has
    // been silenced.
    drop() {
      queue = [];
      for (let ch = 0; ch < channels; ch++) {
        vol[ch] = 0;
        last.set(ch, ctlByte(ch, 0));
      }
    },
    reset,
  };
}

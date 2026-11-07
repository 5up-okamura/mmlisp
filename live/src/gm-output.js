// ---------------------------------------------------------------------------
// The GM output (MMLisp > MIDI > Output): a SoundFont played in the page, for
// a score with no sound of its own (`:target midi`) or beside the chips.
//
// It is an output as a MIDI port is: MidiOutRun (midi-output.js) sends it the
// MIDI export's bytes, stamped with the audio time each is due instead of the
// page's clock, and the synthesizer in its own AudioWorklet (gm-worklet.js)
// plays each in its render quantum — tempo, loops, seeks, mute and the faders
// as the run does them for a port. The bank is FluidR3Mono (soundfonts/, MIT),
// fetched the first time, or the user's own SF2 / SF3.
//
// A plan's programs and keys are decoded ahead (planVoices → 'preload'): a
// sample decodes on its first note otherwise, on the audio thread, and the
// quantum it falls in runs late.
// ---------------------------------------------------------------------------

/** The bundled bank: FluidR3Mono GM (MIT), 22.5 MiB. */
export const GM_BANK_URL = new URL("../soundfonts/FluidR3Mono_GM.sf3", import.meta.url).href;
const WORKLET_URL = new URL("./gm-worklet.js", import.meta.url).href;
const DRUM_CH = 9;

/**
 * The voices a plan plays: each bank and program a channel strikes a key under
 * (CC0 / CC32 and the program change before it, channel 10 a kit), with the
 * range of its keys — what the synthesizer decodes ahead.
 * @returns {{ program, bankMSB, bankLSB, drums, lo, hi }[]}
 */
export function planVoices(plan) {
  const voices = new Map();
  for (const t of plan?.tracks ?? []) {
    if (t.port > 0) continue; // the second port's, which no output sends
    let msb = 0, lsb = 0, program = 0;
    for (const e of t.events) {
      const [st, a, b] = e.bytes;
      const kind = st & 0xf0;
      if (kind === 0xb0 && a === 0) msb = b;
      else if (kind === 0xb0 && a === 32) lsb = b;
      else if (kind === 0xc0) program = a;
      else if (kind === 0x90 && b > 0) {
        const drums = (st & 0x0f) === DRUM_CH;
        const key = drums ? `kit:${program}` : `${msb}:${lsb}:${program}`;
        const v = voices.get(key);
        if (v) { v.lo = Math.min(v.lo, a); v.hi = Math.max(v.hi, a); }
        else voices.set(key, { program, bankMSB: drums ? 0 : msb, bankLSB: drums ? 0 : lsb, drums, lo: a, hi: a });
      }
    }
  }
  return [...voices.values()];
}

// The worklet's module, added once a context (a second addModule of it would
// register its processor twice).
const added = new WeakMap();

/**
 * One GM output: `loadBank()` its SoundFont's bytes. Created when chosen;
 * `attach` once there is an AudioContext (on a phone, the first Play), which
 * resolves when the bank is loaded and the output can take a run.
 */
export class GmOutput {
  constructor({ loadBank }) {
    this.loadBank = loadBank;
    this.node = null;
    this.attaching = null;
    this.batch = [];
    this.pending = new Map(); // a reply's type → its resolver
    this.closed = false;
    this.preloaded = new Map(); // a voice's key → the keys decoded, [lo, hi]
  }

  attach(ctx, destination) {
    this.attaching ??= (async () => {
      if (!added.has(ctx)) added.set(ctx, ctx.audioWorklet.addModule(WORKLET_URL).catch((e) => { added.delete(ctx); throw e; }));
      await added.get(ctx);
      const bytes = await this.loadBank();
      const node = new AudioWorkletNode(ctx, "mmlisp-gm", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.onmessage = ({ data }) => {
        const done = this.pending.get(data.type === "error" ? "ready" : data.type);
        this.pending.delete(data.type === "error" ? "ready" : data.type);
        done?.(data);
      };
      const reply = this.reply("ready");
      node.port.postMessage({ type: "bank", bytes }, [bytes]);
      const r = await reply;
      if (r.type === "error") throw new Error(r.message);
      if (this.closed) { node.port.postMessage({ type: "close" }); throw new Error("closed"); } // another output chosen meanwhile
      node.connect(destination);
      this.node = node;
      return r;
    })();
    return this.attaching;
  }

  reply(type) {
    return new Promise((resolve) => this.pending.set(type, resolve));
  }

  /** A message due at `at` (audio time); a quantum's messages go as one. */
  send(bytes, at) {
    if (!this.node) return;
    if (!this.batch.length) queueMicrotask(() => this.flush());
    this.batch.push([[...bytes], at]);
  }

  flush() {
    if (this.batch.length && this.node) this.node.port.postMessage({ type: "midi", events: this.batch });
    this.batch = [];
  }

  /** What was sent and is not yet due, dropped (a seek, a stop). */
  clear() {
    this.batch = [];
    this.node?.port.postMessage({ type: "clear" });
  }

  /**
   * The plan's programs and keys decoded now; resolves the time it took (ms).
   * Only what no plan before asked for: a preload runs on the audio thread,
   * and one of a preset already decoded still takes ~20 ms (a slider's
   * replan would stall the sound each time).
   */
  async preload(plan) {
    if (!this.node) return null;
    const voices = [];
    for (const v of planVoices(plan)) {
      const key = `${v.drums}:${v.bankMSB}:${v.bankLSB}:${v.program}`;
      const had = this.preloaded.get(key);
      if (had && had[0] <= v.lo && had[1] >= v.hi) continue;
      const lo = Math.min(v.lo, had?.[0] ?? v.lo), hi = Math.max(v.hi, had?.[1] ?? v.hi);
      this.preloaded.set(key, [lo, hi]);
      voices.push({ ...v, lo, hi });
    }
    if (!voices.length) return 0;
    const reply = this.reply("preloaded");
    this.node.port.postMessage({ type: "preload", voices });
    return (await reply).ms;
  }

  close() {
    this.closed = true;
    this.batch = [];
    if (!this.node) return;
    this.node.port.postMessage({ type: "close" });
    this.node.disconnect();
    this.node = null;
  }
}

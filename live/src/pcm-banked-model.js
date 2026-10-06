// Arithmetic model of the generated block renderer, shared by live playback
// and the instruction gate. Timing actions come from the generated image.
const pcmOp = (name, v) => ({LEVEL:1,SRC:2,END:4,WRAP:6,START:8,RETARGET:9}[name] + 9*v);
const pcmRung = (s, page) => page <= 0 ? 0 : s >> (7-page);
export class MultibankModel {
  constructor(gen, rom) {
    this.gen = gen;
    this.rom = rom;
    this.state = new Uint8Array(32);
    this.voices = Array.from({ length: 2 }, () => ({ ptr: 0xff00, bank: 0,
      end: 0, wrap: 0xff00, startGen: 0, endGen: 0, start: false, apply: false, park: false, page: 0, out: 0 }));
    this.ring = new Uint8Array(256).fill(128);
    this.target = 32;
    this.log = [];
    this.slotIndex = 0;
  }
  store(op, value) { if (op < 32) this.state[op] = value; }
  word(at) { return this.state[at] | this.state[at + 1] << 8; }
  slot(pair) {
    const s = this.slotIndex++;
    const output = this.ring[s & 255];
    for (const a of this.gen.actions[s % 80]) {
      const v = this.voices[a.v], k = a.v;
      switch (a.kind) {
        case "genStart": {
          const g = this.state[pcmOp("START", k)];
          v.start = v.startGen !== g; v.startGen = g;
          break;
        }
        case "genEnd": {
          const g = this.state[pcmOp("RETARGET", k)];
          v.apply = v.endGen !== g; v.endGen = g;
          break;
        }
        case "apply":
          if (v.start || v.apply) {
            v.end = this.word(pcmOp("END", k)); v.wrap = this.word(pcmOp("WRAP", k));
            if (!v.start) this.log.push({ kind: "retarget", v: k, end: v.end, wrap: v.wrap, slot: s });
          }
          break;
        case "start":
          if (v.start) {
            v.ptr = this.word(pcmOp("SRC", k)); v.bank = this.word(0x1c + 2*k);
            this.log.push({ kind: "start", v: k, src: v.ptr, bank: v.bank, end: v.end, wrap: v.wrap, slot: s });
          }
          break;
        case "level": v.page = this.state[pcmOp("LEVEL", k)] - 0x13; break;
        case "begin": v.out = this.target; break;
        case "compare": v.park = v.ptr >= v.end; break;
        case "wrap":
          if (v.park) v.ptr = v.wrap;
          if (k === this.gen.cfg.voices - 1) this.target = v.out;
          break;
        case "mix":
          for (let n = 0; n < a.n; n++) {
            const raw = this.rom[v.bank * 0x8000 + v.ptr - 0x8000] ?? 255;
            let sample = (raw << 24) >> 24;
            if (this.uiGain) sample = Math.round(sample * this.uiGain[k]);
            const term = pcmRung(sample, v.page);
            const sum = term + (k ? this.ring[v.out] - 128 : 0);
            this.ring[v.out] = Math.max(-128, Math.min(127, sum)) + 128;
            v.ptr = (v.ptr + 1) & 65535; v.out = (v.out + 1) & 255;
          }
          break;
        default: throw new Error(`unknown model action ${a.kind}`);
      }
    }
    if (pair && pair[0] < 32) this.state[pair[0]] = pair[1];
    return output;
  }
}


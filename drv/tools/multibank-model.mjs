// Independent arithmetic reference for the experimental block renderer.
// The generated schedule says WHEN work happens; no Z80 output or LUT is
// used to determine WHAT the DAC should output.
import { pcmOp, pcmRung } from "../../live/src/pcm-model.js";
import { MB } from "../engine/gen-multibank.mjs";

export { MultibankModel } from "../../live/src/pcm-banked-model.js";

// Prototype transport: append a u16 bank to PCM_START, keep all other command
// payloads unchanged. This is intentionally not the production wire ABI.
export class MultibankPairs {
  constructor(idleAfterGen) {
    this.idle = idleAfterGen;
    this.startGen = [0, 0, 0]; this.endGen = [0, 0, 0];
    this.shift = [8, 8, 8]; this.master = 0;
    this.staged = new Array(34).fill(-1);
    this.banks = [-1, -1, -1];
    this.started = [false,false,false];
  }
  pcm(c) {
    const out = [];
    const byte = (op, value, force = false) => {
      if (force || this.staged[op] !== value) { out.push([op, value]); this.staged[op] = value; }
    };
    const store = (key, v, value) => byte(pcmOp(key, v), value, key === "START" || key === "RETARGET");
    const word = (key, v, lo, hi) => { byte(pcmOp(key, v), lo); byte(pcmOp(key, v) + 1, hi); };
    const level = (v) => store("LEVEL", v, 0x13 + (this.shift[v] >= 8 || this.shift[v] + this.master > 6
      ? 0 : 7 - this.shift[v] - this.master));
    const fence = () => { for (let i = 0; i < this.idle; i++) out.push([0, 0]); };
    const v = c[1];
    if (c[0] !== 5 && (!Number.isInteger(v) || v < 0 || v > 2)) throw new Error("multibank supports pcm1–pcm3");
    switch (c[0]) {
      case 1:
        if (c.length !== 11 || (c[9] | c[10] << 8) > 511) throw new Error("PCM_START needs a nine-bit ROM bank");
        this.started[v] = true; this.shift[v] = c[2]; level(v);
        word("SRC", v, c[3], c[4]); word("END", v, c[5], c[6]); word("WRAP", v, c[7], c[8]);
        if (this.banks[v] !== (c[9] | c[10] << 8)) {
          if (v===2 && (c[9] | c[10]<<8)>127) throw new RangeError("PCM bank exceeds the 4 MiB aperture");
          out.push([MB.bankOp[v],c[9]]); if(v!==2) out.push([MB.bankOp[v]+1,c[10]]);
          this.banks[v] = c[9] | c[10] << 8;
        }
        store("START", v, this.startGen[v] = (this.startGen[v] + 1) & 255); fence();
        break;
      case 4:
        word("END", v, c[2], c[3]); word("WRAP", v, c[4], c[5]);
        store("RETARGET", v, this.endGen[v] = (this.endGen[v] + 1) & 255); fence();
        break;
      case 3: this.shift[v] = c[2]; level(v); break;
      case 5: this.master = c[1]; level(0); level(1); if(this.started[2]) level(2); break;
      default: throw new Error(`unknown PCM command ${c[0]}`);
    }
    return out;
  }
}

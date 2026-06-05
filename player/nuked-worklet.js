import createNukedModule from "./wasm/dist/nuked-opn2.js";

const modulePromise = createNukedModule();

class NukedOPN2Processor extends AudioWorkletProcessor {
  constructor() {
    super();

    this._module = null;
    this._bufferPtr = 0;
    this._nativeSR = 7670454 / 144;
    this._outputSR = sampleRate;
    this._step = this._nativeSR / this._outputSR;
    this._frac = 0;
    this._current = [0, 0];
    this._next = [0, 0];
    this._writeQueue = [];
    this._timedQueue = [];
    this._ready = false;

    this._initPromise = modulePromise
      .then((instance) => {
        this._module = instance;
        this._module._nopn_init();
        this._bufferPtr = this._module._nopn_get_buffer_ptr();
        this._nativeSR = this._module._nopn_get_native_sample_rate();
        this._step = this._nativeSR / this._outputSR;
        this._frac = 0;
        this._current = [0, 0];
        this._next = this._renderOne();
        this._ready = true;
      })
      .catch((error) => {
        this.port.postMessage({
          type: "error",
          message: String(error?.message ?? error),
        });
      });

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === "write") {
        if (msg.when != null) {
          const targetFrame = Math.round(msg.when * sampleRate);
          const entry = {
            frame: targetFrame,
            port: msg.port ?? 0,
            addr: msg.addr & 0xff,
            data: msg.data & 0xff,
          };
          let i = this._timedQueue.length;
          while (i > 0 && this._timedQueue[i - 1].frame > targetFrame) i--;
          this._timedQueue.splice(i, 0, entry);
        } else {
          this._writeQueue.push({
            port: msg.port ?? 0,
            addr: msg.addr & 0xff,
            data: msg.data & 0xff,
          });
        }
      } else if (msg.type === "writes") {
        for (const op of msg.ops || []) {
          this._writeQueue.push({
            port: op.port ?? 0,
            addr: op.addr & 0xff,
            data: op.data & 0xff,
          });
        }
      } else if (msg.type === "reset") {
        this._writeQueue = [];
        this._timedQueue = [];
        this._frac = 0;
        this._current = [0, 0];
        this._next = [0, 0];
        if (this._module) {
          this._module._nopn_reset();
          this._next = this._renderOne();
        }
      } else if (msg.type === "flush") {
        this._writeQueue = [];
        this._timedQueue = [];
      }
    };
  }

  _renderOne() {
    if (!this._module) {
      return [0, 0];
    }
    this._module._nopn_render(1);
    const base = this._bufferPtr >> 1;
    const heap = this._module.HEAP16;
    return [heap[base] / 512, heap[base + 1] / 512];
  }

  _drainImmediateWrites() {
    if (!this._module) {
      return;
    }
    while (this._writeQueue.length > 0) {
      const op = this._writeQueue.shift();
      this._module._nopn_write_reg(op.port, op.addr, op.data);
    }
  }

  process(_inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outputs[0][0];

    if (!this._ready) {
      outL.fill(0);
      outR.fill(0);
      return true;
    }

    this._drainImmediateWrites();

    for (let i = 0; i < outL.length; i++) {
      const frame = currentFrame + i;
      while (
        this._timedQueue.length > 0 &&
        this._timedQueue[0].frame <= frame
      ) {
        const op = this._timedQueue.shift();
        this._module._nopn_write_reg(op.port, op.addr, op.data);
      }

      const t = this._frac;
      outL[i] = this._current[0] * (1 - t) + this._next[0] * t;
      outR[i] = this._current[1] * (1 - t) + this._next[1] * t;

      this._frac += this._step;
      while (this._frac >= 1) {
        this._frac -= 1;
        this._current = this._next;
        this._next = this._renderOne();
      }
    }

    return true;
  }
}

registerProcessor("nuked-opn2-processor", NukedOPN2Processor);

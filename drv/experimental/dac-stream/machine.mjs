// The emulated machine, and the instrument (docs/dac-engine-implementation.md
// §5/P0: "測定ツールに、設定値を自動検出したメタデータ、出力時刻、出力値、
// BUSREQ、DAC enable区間を持たせる").
//
// A Mega Drive slice: 8 KB of Z80 RAM, the YM2612's four ports with a REAL
// timer model, the bank register, the PSG port, and the 68000's bus grab as an
// injectable stretch of stopped time. Everything it observes is stamped with a
// 64-bit-safe cycle count — the existing probe log wraps its 32-bit master
// clock every 80 seconds and the §6.2 ten-minute case cannot use it.
//
// THE TIMERS ARE MODELLED FROM THE CHIP, NOT FROM OUR DOCUMENT. A harness
// written from a design doc cannot fail on a register the doc forgot: this one
// implements $24/$25/$26/$27 as the YM2612 defines them — load bits run the
// counters, ENABLE bits are what publish an overflow to the status byte, and
// the reset bits clear a published flag without touching either. That last
// distinction is a bug this project has already paid for once.
//
// BUSY IS OBSERVED, NEVER ENFORCED. A write always lands, exactly as BlastEm
// applies it (§6.4) and as the hardware would if the settling time is
// respected. What the instrument does instead is RECORD the gap between writes
// so the analyzer can check them against the chip's settling table. A driver
// that polls BUSY has already lost the cycles; a driver whose schedule spaces
// its writes does not need to.
import { Z80Cpu } from "../../tools/z80cpu.mjs";
import { YM } from "./config.mjs";

const RAM_SIZE = 0x2000;

export class Machine {
  constructor(cfg, { bytes, symbols }, { wave = null, grabs = [] } = {}) {
    this.cfg = cfg;
    this.symbols = symbols;
    this.ram = new Uint8Array(RAM_SIZE);
    this.ram.set(bytes, 0);
    if (wave) this.ram.set(wave, cfg.ram.wave[0]);
    this.masterPerZ80 = cfg.machine.z80Div;
    this.cycles = 0;          // Z80 cycles since reset — a double, exact to 2^53
    this.instrStart = 0;      // stamp used for everything one instruction does

    // ── The chip ───────────────────────────────────────────────────────────
    this.reg = new Uint8Array(0x200);   // $000-$0FF port 0, $100-$1FF port 1
    this.addr = [-1, -1];
    this.ctl27 = 0;
    this.status = 0;
    this.busyUntil = -1;
    this.timer = [
      { name: "A", periodMaster: 0, next: Infinity, running: false },
      { name: "B", periodMaster: 0, next: Infinity, running: false },
    ];

    // ── What it records ────────────────────────────────────────────────────
    this.trace = {
      meta: null,
      dacCycle: [], dacValue: [],       // §6.2 t[i] and §6.1 the value
      ym: [],                           // every non-DAC chip DATA write
      ymAddr: [],                       // every address-port write, for the settling check
      statusRead: [],                   // cycle, value — the phase reference
      dacEnable: [],                    // $2B edges: the DAC-enable intervals
      overflow: [],                     // when the timers REALLY overflowed
      grabs: [],                        // 68000 bus held: [start, end]
      stray: [],                        // writes to no device — a value fault
    };
    this.grabs = [...grabs].sort((a, b) => a.at - b.at);
    this.grabIdx = 0;

    this.cpu = new Z80Cpu({
      read: (a) => this.read(a & 0xffff),
      write: (a, d) => this.write(a & 0xffff, d & 0xff),
    });
    this.cpu.pc = 0;
  }

  get master() { return this.cycles * this.masterPerZ80; }

  // ── Memory / device map ──────────────────────────────────────────────────
  read(a) {
    if (a < RAM_SIZE) return this.ram[a];
    if (a >= YM.addr0 && a <= YM.data1) {
      // All four YM addresses read the same status byte on a YM2612.
      const v = this.statusByte();
      this.trace.statusRead.push([this.instrStart, v]);
      return v;
    }
    if (a >= 0x8000) return 0xff;   // the 68k window — unused in P1
    return 0xff;
  }

  write(a, d) {
    if (a < RAM_SIZE) { this.ram[a] = d; return; }
    if (a === YM.addr0 || a === YM.addr1) {
      const port = a === YM.addr0 ? 0 : 1;
      this.addr[port] = d;
      this.trace.ymAddr.push([this.instrStart, port, d]);
      return;
    }
    if (a === YM.data0 || a === YM.data1) {
      const port = a === YM.data0 ? 0 : 1;
      const reg = this.addr[port];
      if (reg < 0) { this.trace.stray.push([this.instrStart, a, d, "data write with no address latched"]); return; }
      this.chipWrite(port, reg, d);
      return;
    }
    if (a === YM.bank || a === YM.psg) return;
    this.trace.stray.push([this.instrStart, a, d, "write outside every device"]);
  }

  chipWrite(port, reg, d) {
    this.reg[port * 0x100 + reg] = d;
    this.busyUntil = this.cycles + 53;      // observed, never enforced
    if (port === 0 && reg === YM.R_DAC) {
      this.trace.dacCycle.push(this.instrStart);
      this.trace.dacValue.push(d);
      return;
    }
    this.trace.ym.push([this.instrStart, port, reg, d]);
    if (port === 0 && reg === YM.R_DACEN)
      this.trace.dacEnable.push([this.instrStart, (d & 0x80) ? 1 : 0]);
    if (port === 0 && (reg === YM.R_TIMER_A_HI || reg === YM.R_TIMER_A_LO
      || reg === YM.R_TIMER_B || reg === YM.R_TIMER_CTL)) this.timerWrite(reg, d);
  }

  // ── The timers ───────────────────────────────────────────────────────────
  timerWrite(reg, d) {
    const fmMaster = this.cfg.machine.fmSampleMaster;
    if (reg === YM.R_TIMER_CTL) {
      const was = this.ctl27;
      this.ctl27 = d;
      // Reset bits clear a PUBLISHED flag. They do not stop, reload or disable
      // anything, and they are not stored.
      if (d & YM.CTL_RESET_A) this.status &= ~YM.ST_FLAG_A;
      if (d & YM.CTL_RESET_B) this.status &= ~YM.ST_FLAG_B;
      for (const [i, load] of [[0, YM.CTL_LOAD_A], [1, YM.CTL_LOAD_B]]) {
        const t = this.timer[i];
        const on = !!(d & load);
        if (on && !(was & load)) {          // 0 -> 1 reloads and starts
          t.periodMaster = i === 0
            ? (1024 - this.timerA()) * fmMaster
            : 16 * (256 - this.reg[YM.R_TIMER_B]) * fmMaster;
          t.next = this.master + t.periodMaster;
          t.running = true;
        } else if (!on) {
          t.running = false;
          t.next = Infinity;
        }
      }
      return;
    }
    // A period write takes effect at the counter's next reload, which is what
    // the chip does — it does not restart the counter.
    if (reg === YM.R_TIMER_B && this.timer[1].running)
      this.timer[1].periodMaster = 16 * (256 - d) * fmMaster;
    if ((reg === YM.R_TIMER_A_HI || reg === YM.R_TIMER_A_LO) && this.timer[0].running)
      this.timer[0].periodMaster = (1024 - this.timerA()) * fmMaster;
  }

  timerA() { return ((this.reg[YM.R_TIMER_A_HI] & 0xff) << 2) | (this.reg[YM.R_TIMER_A_LO] & 3); }

  advanceTimers() {
    const now = this.master;
    for (const [i, t] of this.timer.entries()) {
      if (!t.running || t.periodMaster <= 0) continue;
      while (t.next <= now) {
        // ENABLE, not load, is what publishes the overflow (ym3438.c).
        const en = i === 0 ? YM.CTL_ENA_A : YM.CTL_ENA_B;
        const fl = i === 0 ? YM.ST_FLAG_A : YM.ST_FLAG_B;
        if (this.ctl27 & en) this.status |= fl;
        this.trace.overflow.push([t.next / this.masterPerZ80, t.name]);
        t.next += t.periodMaster;
      }
    }
  }

  statusByte() {
    this.advanceTimers();
    return (this.status & 0x03) | (this.cycles < this.busyUntil ? YM.ST_BUSY : 0);
  }

  // ── Run ──────────────────────────────────────────────────────────────────
  /** Run until `untilCycles` Z80 cycles have elapsed. */
  run(untilCycles) {
    const cpu = this.cpu;
    while (this.cycles < untilCycles) {
      // The 68000's bus grab: the Z80 executes NOTHING while it is held, and
      // it is charged as stopped time rather than skipped. §3.6 is the reason
      // this exists before there is anything to transfer — a hole is a hole
      // whether or not the buffer was full.
      const g = this.grabs[this.grabIdx];
      if (g && this.cycles >= g.at) {
        this.trace.grabs.push([this.cycles, this.cycles + g.cycles]);
        this.cycles += g.cycles;
        this.grabIdx++;
        continue;
      }
      this.instrStart = this.cycles;
      const c = cpu.step();
      this.cycles += c;
      this.advanceTimers();
    }
    return this.cycles;
  }
}

/** Everything the analyzer needs to know about how a trace was produced. */
export function traceMeta(cfg, extra = {}) {
  return {
    stamp: cfg.stamp,
    profile: cfg.profile.name,
    rateHz: cfg.rateHz,
    periodCycles: cfg.periodCycles,
    periodNum: cfg.periodNum, periodDen: cfg.periodDen,
    groupSlots: cfg.groupSlots, groupCycles: cfg.groupCycles,
    slotCycles: cfg.slotCycles,
    z80Hz: cfg.z80Hz,
    voices: cfg.voices, csm: cfg.csm, timerB: cfg.timerB,
    ...extra,
  };
}

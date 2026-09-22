// The emulated machine, and the instrument. What it was asked to carry:
// metadata auto-detected from the settings, the time of each output, its value,
// BUSREQ, and the DAC-enable spans.
//
// A Mega Drive slice: 8 KB of Z80 RAM, the YM2612's four ports with a REAL
// timer model, the bank register, the PSG port, and the 68000's bus grab as an
// injectable stretch of stopped time. Everything it observes is stamped with a
// 64-bit-safe cycle count — the existing probe log wraps its 32-bit master
// clock every 80 seconds and a ten-minute run cannot use it.
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
import { Z80Cpu } from "./z80cpu.mjs";
import { YM } from "../engine/config.mjs";

const RAM_SIZE = 0x2000;

export class Machine {
  constructor(cfg, { bytes, symbols }, { wave = null, grabs = [], rom = null, pokes = [],
    watch = [], vdp = null, host = null } = {}) {
    this.cfg = cfg;
    this.symbols = symbols;
    this.ram = new Uint8Array(RAM_SIZE);
    this.ram.set(bytes, 0);
    if (wave) this.ram.set(wave, cfg.ram.wave[0]);
    // The sample data lives where it really lives: 68k ROM, seen through the
    // $8000 bank window. On silicon that read pays bus arbitration this model
    // does not charge — the one instruction in the mix that is exposed to it.
    this.rom = rom;
    // The host's writes into Z80 RAM, scheduled by cycle. This is the 68000
    // poking a level, WITHOUT the bus grab it would really cost: §3.6 is P3's
    // question and this is not an answer to it.
    this.pokes = [...pokes].sort((a, b) => a.at - b.at);
    this.pokeIdx = 0;
    this.watch = new Set(watch);
    // A HOST THAT DECIDES AS IT GOES (R28 §63.6 step 2): `{every, fn}` — every
    // `every` cycles `fn(ram, cycle)` is called with the Z80 stopped and returns
    // the bytes to write, `[[addr, value], ...]`. This is the 68000 reading the
    // expander's index and writing pairs ahead of it; the model charges no bus
    // stop for it — that is BlastEm's measurement, not this one's.
    this.host = host;
    this.hostNext = host ? host.every : Infinity;
    // The VDP's window at $7F00. There is no VDP in this model — what it is
    // for is the phase observer, which reads the HV counter and nothing else,
    // so a case hands in the byte a read should see and the reads are recorded.
    // Without it $7F09 answers $FF, which the decoder correctly calls "not a
    // value the table knows" and which is therefore a silently useless test.
    this.vdp = vdp;
    this.ringLo = cfg.ram.ring ? cfg.ram.ring[0] : -1;
    this.ringHi = cfg.ram.ring ? cfg.ram.ring[1] : -1;
    this.masterPerZ80 = cfg.machine.z80Div;
    this.cycles = 0;          // Z80 cycles since reset — a double, exact to 2^53
    this.instrStart = 0;      // stamp used for everything one instruction does
    this.instrPc = 0;
    this.windowReads = 0;

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
      globRead: [],                     // reads of watched RAM: cycle, addr, value
      globWrite: [],                    // …and the Z80's writes to it
      pokes: [],                        // the host's writes, as applied
      // Every access to the finished-sample ring, with the PC that made it —
      // §3.3 (R1) asks for the fixed lead to be CHECKED, and the check needs to
      // tell the play cursor's fetch from the mixer's park and read-back. The
      // PC is what separates them, so it is recorded rather than inferred.
      ring: [],                         // cycle, pc, addr, isWrite
      grabs: [],                        // 68000 bus held: [start, end]
      vdpRead: [],                      // cycle, addr, value — the observer's reads
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
    if (a < RAM_SIZE) {
      if (this.watch.has(a)) this.trace.globRead.push([this.instrStart, a, this.ram[a]]);
      if (a >= this.ringLo && a < this.ringHi)
        this.trace.ring.push([this.instrStart, this.instrPc, a, 0]);
      return this.ram[a];
    }
    if (a >= YM.addr0 && a <= YM.data1) {
      // All four YM addresses read the same status byte on a YM2612.
      const v = this.statusByte();
      this.trace.statusRead.push([this.instrStart, v]);
      return v;
    }
    if (this.vdp && a >= 0x7f00 && a < 0x7f20) {
      // The VDP window is reached over the 68k bus and pays the same wait the
      // $8000 window does — `windowWait`, measured on BlastEm. Without charging
      // it the slot carrying the read comes out three cycles short here and
      // exactly right there, which is a model disagreeing with the machine over
      // the one instruction the observer is made of.
      this.windowReads++;
      const v = this.vdp(a, this.instrStart) & 0xff;
      this.trace.vdpRead.push([this.instrStart, a, v]);
      return v;
    }
    if (a >= 0x8000) {
      // The 68k window is not Z80 RAM: the read pays a wait, MEASURED on
      // BlastEm rather than assumed (config.mjs, `windowWait`). Charging it
      // here is what keeps this model and the machine agreeing — without it
      // the model reports a rate 1.65% faster than the emulator does at two
      // voices, and the schedule that looks exact here arrives slow there.
      this.windowReads++;
      return this.rom ? this.rom[(a - 0x8000) % this.rom.length] : 0xff;
    }
    return 0xff;
  }

  write(a, d) {
    if (a < RAM_SIZE) {
      if (a >= this.ringLo && a < this.ringHi)
        this.trace.ring.push([this.instrStart, this.instrPc, a, 1]);
      if (this.watch.has(a)) this.trace.globWrite.push([this.instrStart, a, d]);
      this.ram[a] = d;
      return;
    }
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
      while (this.pokeIdx < this.pokes.length && this.pokes[this.pokeIdx].at <= this.cycles) {
        const p = this.pokes[this.pokeIdx++];
        this.ram[p.addr] = p.value & 0xff;
        this.trace.pokes.push([this.cycles, p.addr, p.value & 0xff]);
      }
      if (this.cycles >= this.hostNext) {
        for (const [addr, value] of this.host.fn(this.ram, this.cycles) ?? []) {
          this.ram[addr] = value & 0xff;
          this.trace.pokes.push([this.cycles, addr, value & 0xff]);
        }
        this.hostNext += this.host.every;
      }
      const g = this.grabs[this.grabIdx];
      if (g && this.cycles >= g.at) {
        this.trace.grabs.push([this.cycles, this.cycles + g.cycles]);
        this.cycles += g.cycles;
        this.grabIdx++;
        continue;
      }
      this.instrStart = this.cycles;
      this.instrPc = cpu.pc;
      this.windowReads = 0;
      const c = cpu.step();
      this.cycles += c + this.windowReads * this.cfg.windowWait;
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

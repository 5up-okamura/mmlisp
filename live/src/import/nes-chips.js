// The Famicom's chips as a VGM or an NSF writes them: the 2A03 (its DMC
// among the PCM chips), the FDS, the VRC6, the N163, and nesChips, which
// wires the ones a song uses to one clock.

import { RATE } from "./import-song.js";
import { velOfDb, SETUP_T, pitchOf, FRAME, waveOf, TONE_MAX_HZ, pcmChips, opllChip, ayChip } from "./vgm-chips.js";
import { NOISE_NOTE_BASE, NOISE_PERIODS, DUTIES, DMC_RATES, DMC_PERIODS } from "../machine/chips/rp2a03.js";

// The 2A03's APU (chips/rp2a03.js), VGM 0xB4: $00-$03 / $04-$07 the pulses
// (duty, length halt, constant volume, volume; the sweep; the period; its
// high bits under the length load, a write that restarts the envelope and
// the phase), $08-$0B the triangle (its linear counter's control and
// reload; the period under the length load), $0C-$0F the noise (level,
// mode and rate, length), $10-$13 the DMC (rate and loop, the DAC, the
// sample's address and length), $15 the enables (the DMC's bit starts and
// stops a sample). A channel sounds while enabled, its length counter
// running (LENGTHS, a half frame a step, halted by its halt bit), its
// level up — the volume, or the envelope decaying from 15 a step every
// (volume + 1) quarter frames, looping on the halt bit — and, the
// triangle, its linear counter up. The counters run between writes, so
// each write first lets the time pass (`advance`): a note ends where its
// counter ran out, its level steps where the envelope stepped. The frame
// counter's mode ($4017) sets the quarter frame's length, 4-step or 5-step,
// on the average, the sweep on its half frames (a pitch moving under the
// note) and its mute. Not followed: a halt cleared under a held counter
// (the counter stays held). With `mmc5` it is the MMC5's two pulses
// ($5000-$5007, $5015's low bits): the 2A03's, with no sweep (nor its mute)
// and the envelope and length counters on the chip's own 240 Hz.
const APU_LENGTHS = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
export const NES_RAM = 0xc2; // VGM's RAM-write block for the NES's memory
export function apuChip(clock, { ev, skip, pcm, ram, mmc5 = false }) {
  // Samples a quarter frame: 4-step mode's 29830 clocks over four (~240 Hz),
  // 5-step's 37282 over four.
  let QUARTER = (RATE * 29830) / (4 * clock);
  let lastT = -Infinity; // the previous write's time: nothing is emitted before it
  const r = new Uint8Array(0x18);
  const KEY = mmc5 ? ["MMC5 SQ1", "MMC5 SQ2"] : ["2A03 SQ1", "2A03 SQ2", "2A03 TRI", "2A03 noise"];
  // The counters start at 0 (silent until a load).
  const ch = [0, 1, 2, 3].map(() => ({ on: false, lenEnd: -Infinity, linEnd: -Infinity, env: null, vel: 0, pitch: null, duty: null, mode: null, velAt: -1, pitchAt: -1 }));
  // The channels start enabled: an NSF player sets $4015 before the song
  // starts, and a rip of it often does not log that write.
  // (The MMC5's start off: a driver enables them.)
  let enable = mmc5 ? 0 : 0x0f;
  const dmc = { playing: false, end: Infinity, dac: 0, dacAt: -Infinity };
  const ctlOf = (c) => r[c === 3 ? 0x0c : 4 * c];
  const haltOf = (c) => (c === 2 ? r[0x08] & 0x80 : ctlOf(c) & 0x20);
  const period = (c) => (c === 2 ? ((r[0x0b] & 7) << 8) | r[0x0a] : ((r[4 * c + 3] & 7) << 8) | r[4 * c + 2]);
  const hz = (c) => clock / ((c === 2 ? 32 : 16) * (period(c) + 1));
  const rate = () => r[0x0e] & 15;
  const mode = () => (r[0x0e] & 0x80 ? "periodic" : "white");
  // A channel's level at `t`: its volume, or its envelope's step.
  const level = (c, t) => {
    if (c === 2) return 15;
    const ctl = ctlOf(c);
    if (ctl & 0x10) return ctl & 15;
    const e = ch[c].env;
    if (!e) return 0;
    const steps = Math.floor((t - e.t0) / (e.div * QUARTER));
    return ctl & 0x20 ? 15 - (steps % 16) : Math.max(0, 15 - steps);
  };
  // The 4-bit volume is linear: its :vel on the 2 dB ladder.
  const velOf = (v) => (v > 0 ? velOfDb(20 * Math.log10(v / 15)) : 0);
  const endAt = (c) => Math.min(ch[c].lenEnd, c === 2 ? ch[c].linEnd : Infinity);
  // A looping envelope passes 0 for a step and starts over: it stays on.
  const loopEnv = (c) => c !== 2 && !!ch[c].env && (ctlOf(c) & 0x30) === 0x20;
  const sounding = (c, t) => !!(enable & (1 << c)) && endAt(c) > t && (level(c, t) > 0 || loopEnv(c)) && !sweepMuted(c) && (c === 3 || period(c) >= (c === 2 ? 2 : 8));
  // The pitch a write burst started from (`burstPitch`), and the way the
  // last burst moved it under the note (`glide`): what the triangle's
  // $400B compares.
  const pitchMoved = (st, t) => {
    if (t - st.pitchAt > SETUP_T) { st.burstPitch = st.pitch; st.lastGlide = st.glide; st.glide = null; }
    st.pitchAt = t;
  };
  const onEvent = (c, t, kind) => {
    const st = ch[c];
    st.vel = level(c, t);
    pitchMoved(st, t);
    st.velAt = t;
    if (c === 3) {
      st.pitch = NOISE_NOTE_BASE + 15 - rate();
      st.mode = mode();
      return { t, kind, pitch: st.pitch, vel: velOf(st.vel), mode: st.mode, noiseHz: clock / NOISE_PERIODS[rate()], kindOf: "noise" };
    }
    st.pitch = pitchOf(hz(c));
    st.duty = c < 2 ? DUTIES[ctlOf(c) >> 6] : null;
    return { t, kind, pitch: st.pitch, vel: velOf(st.vel), kindOf: "psg", ...(c < 2 ? { duty: st.duty } : {}) };
  };
  // What a write changed: a note started, ended, struck again, or moved.
  const sync = (c, t, strike = false) => {
    const st = ch[c], was = st.on, now = sounding(c, t);
    st.on = now;
    if (!was && now) ev(KEY[c], onEvent(c, t, "on"));
    else if (was && !now) ev(KEY[c], { t, kind: "off" });
    else if (was && strike) ev(KEY[c], onEvent(c, t, "retrig"));
    else if (was) {
      const v = level(c, t), vCh = v !== st.vel;
      const p = c === 3 ? null : pitchOf(hz(c)), pCh = c !== 3 && p !== st.pitch;
      // A driver strikes a note by writing its period and its level
      // together (no key-off between): a new note, as on the SN76489 — where
      // the level came up, or the pitch jumped a semitone or more (a level
      // envelope under a vibrato, written each frame, is one note).
      // (Together: within a driver's setup burst of each other.)
      const jump = c !== 3 && Math.abs(p - st.pitch) >= 0.5;
      const struck = (vCh && t - st.pitchAt <= SETUP_T && (v > st.vel || jump)) ||
        (pCh && t - st.velAt <= SETUP_T && (v > st.vel || jump));
      if (struck && !st.pendingB) { ev(KEY[c], onEvent(c, t, "retrig")); return; }
      if (vCh) { st.vel = v; st.velAt = t; ev(KEY[c], { t, kind: "vel", vel: velOf(v) }); }
      if (c === 3) {
        if (rate() !== NOISE_NOTE_BASE + 15 - st.pitch || mode() !== st.mode)
          ev(KEY[c], onEvent(c, t, "retrig"));
      } else {
        if (pCh) {
          pitchMoved(st, t);
          st.glide = { t, way: Math.sign(p - st.burstPitch) };
          st.pitch = p;
          ev(KEY[c], { t, kind: "pitch", pitch: p });
        }
        const d = c < 2 ? DUTIES[ctlOf(c) >> 6] : null;
        if (d !== st.duty) { st.duty = d; ev(KEY[c], { t, kind: "duty", duty: d }); }
      }
    }
  };
  // The sweep (a pulse's $4001): its target period, whether it mutes the
  // channel (a period under 8, or a target over $7FF when it adds), and its
  // divider, stepped every half frame (sweepHalf).
  const sweep = [{ div: 0, reload: false }, { div: 0, reload: false }];
  const sweepTarget = (c) => {
    const p = period(c), d = p >> (r[4 * c + 1] & 7);
    return r[4 * c + 1] & 8 ? p - d - (c === 0 ? 1 : 0) : p + d;
  };
  const sweepMuted = (c) => !mmc5 && c < 2 && (period(c) < 8 || (!(r[4 * c + 1] & 8) && sweepTarget(c) > 0x7ff));
  const sweeping = (c) => c < 2 && ch[c].on && r[4 * c + 1] & 0x80 && r[4 * c + 1] & 7;
  const sweepHalf = (c, at) => {
    const sw = sweep[c], reg = r[4 * c + 1];
    if (sw.div === 0 && reg & 0x80 && reg & 7 && !sweepMuted(c)) {
      const p = Math.max(0, sweepTarget(c));
      r[4 * c + 2] = p & 0xff;
      r[4 * c + 3] = (r[4 * c + 3] & 0xf8) | ((p >> 8) & 7);
      sync(c, at);
    }
    if (sw.div === 0 || sw.reload) { sw.div = (reg >> 4) & 7; sw.reload = false; } else sw.div--;
  };
  // The frame counter's half frames, from its last $4017 write.
  let fcT0 = 0, nextHalf = null;
  const halfAfter = (t) => fcT0 + (Math.floor((t - fcT0) / (2 * QUARTER)) + 1) * 2 * QUARTER;
  // The time between writes, in order: the envelopes' steps, the sweeps'
  // half frames, the counters' ends.
  const advance = (t) => {
    for (;;) {
      let at = Infinity, what = null, cc = -1;
      for (let c = 0; c < 4; c++) {
        const st = ch[c];
        if (!st.on) continue;
        const e = c !== 2 && !(ctlOf(c) & 0x10) ? st.env : null;
        const step = e ? e.t0 + (e.next + 1) * e.div * QUARTER : Infinity;
        if (step < at) { at = step; what = "env"; cc = c; }
        if (endAt(c) < at) { at = endAt(c); what = "end"; cc = c; }
      }
      if (sweeping(0) || sweeping(1)) {
        if (nextHalf == null || nextHalf <= lastT) nextHalf = halfAfter(Math.max(lastT, fcT0));
        if (nextHalf < at) { at = nextHalf; what = "half"; }
      } else nextHalf = null;
      if (at > t) break;
      if (what === "end") { ch[cc].on = false; ev(KEY[cc], { t: at, kind: "off" }); continue; }
      if (what === "half") { for (const c of [0, 1]) if (sweeping(c)) sweepHalf(c, at); nextHalf = at + 2 * QUARTER; continue; }
      const st = ch[cc], e = st.env;
      e.next++;
      if (at < lastT) continue; // stepped while the level was the volume's: nothing to say
      const v = level(cc, at);
      if (v === 0 && !loopEnv(cc)) { st.on = false; ev(KEY[cc], { t: at, kind: "off" }); }
      else if (v !== st.vel) { st.vel = v; ev(KEY[cc], { t: at, kind: "vel", vel: velOf(v) }); }
    }
    if (dmc.playing && dmc.end <= t) dmc.playing = false;
  };
  // The triangle's linear counter reloaded at `at` from $4008: held (the
  // control bit) at its value — on, or 0 silent — else counting down.
  const triReload = (at) => {
    const v = r[0x08] & 0x7f;
    ch[2].linEnd = r[0x08] & 0x80 ? (v ? Infinity : -Infinity) : v ? at + v * QUARTER : -Infinity;
  };
  const resolveB = (t) => {
    const st = ch[2], pb = st.pendingB;
    st.pendingB = null;
    if (!st.on) return;
    const step = st.pitch - pb.from, g = pb.glide;
    const gliding = g && pb.t - g.t <= 1.5 * FRAME && Math.sign(step) === g.way && Math.abs(step) < 3;
    if (!gliding) ev(KEY[2], onEvent(2, t, "retrig"));
  };
  const load = (c, t) => {
    ch[c].lenEnd = haltOf(c) ? Infinity : t + APU_LENGTHS[r[c === 2 ? 0x0b : c === 3 ? 0x0f : 4 * c + 3] >> 3] * 2 * QUARTER;
  };
  return {
    name: mmc5 ? "MMC5" : "2A03",
    write(a, d, t) {
      if (a > 0x17) return;
      if (mmc5 && (a === 0x10 || a === 0x11)) { skip("MMC5 PCM"); return; }
      if (mmc5 && (a === 1 || a === 5 || (a > 7 && a !== 0x15))) return;
      if (ch[2].pendingB && t - ch[2].pendingB.t > SETUP_T) resolveB(ch[2].pendingB.t);
      advance(t);
      lastT = t;
      r[a] = d;
      if (a === 0x17) { QUARTER = (RATE * (d & 0x80 ? 37282 : 29830)) / (4 * clock); fcT0 = t; nextHalf = null; return; }
      if (a < 0x10) {
        const c = a >> 2, reg = a & 3;
        // The sweep: its divider reloaded at the next half frame; its mute now.
        if (c < 2 && reg === 1) { sweep[c].reload = true; sync(c, t); return; }
        if (c === 2 && reg === 0) {
          // The linear counter. With its control bit set the reload flag
          // stays set, so the counter is the reload value every quarter
          // frame: up while it is nonzero, silent at 0. The bit cleared, it
          // counts the reload down from there. A $400B's reload is taken at
          // the next quarter frame, from $4008 as it is then: a $4008 written
          // just after it (a driver's order) is the one read.
          if (t - (ch[2].reloadAt ?? -Infinity) < QUARTER) triReload(ch[2].reloadAt);
          else if (d & 0x80) ch[2].linEnd = d & 0x7f ? Infinity : -Infinity;
          else if (!Number.isFinite(ch[2].linEnd)) ch[2].linEnd = t + (d & 0x7f) * QUARTER; // the flag still set: reloaded
          if (Number.isFinite(ch[2].lenEnd) && d & 0x80) ch[2].lenEnd = Infinity;
          sync(2, t);
          return;
        }
        if (reg === 0 && c !== 2) {
          // A halt set holds the length counter where it is. An envelope
          // not yet stepped takes the divider from here (a driver writing
          // $4003 before $4000).
          if (d & 0x20 && Number.isFinite(ch[c].lenEnd)) ch[c].lenEnd = Infinity;
          if (ch[c].env && ch[c].env.next === 0) ch[c].env.div = (d & 15) + 1;
          sync(c, t);
          return;
        }
        if (reg === 3) {
          // The length load: the envelope started over, the pulse's phase
          // too — a new note.
          if (enable & (1 << c)) load(c, t);
          if (c !== 2) { ch[c].env = { t0: t, div: (ctlOf(c) & 15) + 1, next: 0 }; sync(c, t, true); return; }
          // The triangle's phase runs on through it: a new note, but not
          // in a glide — a pitch moved the frame before, going on the same
          // way a step (a drum's fall crossing a high byte).
          // Decided on the pitch the burst settles on: a driver may write
          // the low byte after it (resolveB).
          ch[2].reloadAt = t;
          triReload(t);
          const st = ch[2];
          if (!st.on) { sync(2, t, true); return; }
          const lowFirst = t - st.pitchAt <= SETUP_T;
          st.pendingB = { t, from: lowFirst ? st.burstPitch ?? st.pitch : st.pitch, glide: lowFirst ? st.lastGlide : st.glide };
          sync(2, t);
          if (lowFirst) resolveB(t);
          return;
        }
        sync(c, t);
        if (c === 2 && reg === 2 && ch[2].pendingB) resolveB(t);
        return;
      }
      if (a === 0x15) {
        enable = d & (mmc5 ? 3 : 0x1f);
        for (let c = 0; c < KEY.length; c++) { if (!(d & (1 << c))) ch[c].lenEnd = -Infinity; sync(c, t); }
        if (mmc5) return;
        if (!(d & 0x10)) { if (dmc.playing) pcm.stop("DPCM", 0, t); dmc.playing = false; }
        else if (!dmc.playing) {
          // The sample is the memory as it stands now (a later block may
          // rewrite it: a bank switched), from $C000 up, wrapping to $8000.
          const start = 0xc000 + r[0x12] * 64, len = r[0x13] * 16 + 1, idx = r[0x10] & 15, loop = !!(r[0x10] & 0x40);
          const bytes = ram(start, len); // none before the first block: a hit with no sample
          pcm.start({ t, src: "DPCM", ch: 0, rom: bytes ? NES_RAM : null, start: 0, end: len, bytes, loopStart: loop ? 0 : null,
            rate: DMC_RATES[idx], db: 0, pan: false, dac0: dmc.dac });
          dmc.playing = true;
          dmc.end = loop ? Infinity : t + (RATE * len * 8 * DMC_PERIODS[idx]) / clock;
        }
        return;
      }
      if (a === 0x11) {
        // The DAC written directly: a level ahead of a sample, or, written
        // on and on, a PCM the CPU plays itself (not imported).
        if ((d & 0x7f) !== dmc.dac && t - dmc.dacAt < 0.002 * RATE) skip("2A03 $4011 PCM");
        dmc.dac = d & 0x7f;
        dmc.dacAt = t;
      }
    },
    end: (t) => advance(t),
  };
}

// The Famicom Disk System's channel (chips/fds.js), VGM 0xB4 $20-$7F (the
// 2A03's clock with bit 31): $20 the gain (bit 7 direct, else its envelope's
// speed and way), $22 / $23 the 12-bit pitch (bit 7 halts the wave, bit 6
// the envelopes), $24 the modulation's depth (the same), $26 / $27 its rate
// (bit 7 halts it, opening its table to $28), $29 the wave memory's write
// enable and the master volume, $2A the envelopes' speed, $3F ($4023) the
// sound's enable, $40-$7F the memory. A note sounds while the wave runs at
// a pitch, its gain up. The envelopes step every 8 × (speed + 1) × $2A
// clocks between writes (synth-fc.js Fds), a level envelope on the note. The
// wave is read where the memory closes; the modulation as the note starts
// (its table, rate and depth: the song's :lfo-wave, :lfo-freq, :lfo-pmd),
// its pitch the wave's own — the bend it makes is left to the chip. A $25
// of 0 in the burst (the counter back to 0, as a driver starts each note's
// vibrato alike) is the note's `reset`: its :lfo-wave written again, which
// starts the counter over (chips/fds.js); another value is not the
// language's (skipped).
const FDS_MOD_OF = [0, 1, 2, 4, "reset", -4, -2, -1]; // $28's codes as :lfo-wave's steps
const FDS_MASTER_DB = [1, 2 / 3, 2 / 4, 2 / 5].map((v) => 20 * Math.log10(v));
export function fdsChip(clock, { ev, skip }) {
  const KEY = "FDS";
  const wave = new Uint8Array(64), table = new Array(32).fill(0);
  let pitch = 0, waveHalt = false, envHalt = false, waveOpen = false, master = 0, envMaster = 0xe8, io = true;
  let modFreq = 0, modHalt = true, modPos = 0, resetAt = -Infinity;
  // The volume envelope [0] and the modulation's [1]: its gain, speed, way,
  // whether direct, and the time of its last step.
  const env = [0, 1].map(() => ({ gain: 0, speed: 0, up: false, off: true, at: 0 }));
  let on = false, gainNow = 0, pitchNow = null, velAt = -Infinity, pitchAt = -Infinity, modAt = -Infinity, burstFrom = null, waveNow = null;
  const level = () => (io && !waveHalt && pitch > 0 ? Math.min(32, env[0].gain) : 0);
  const vel = (g) => velOfDb(20 * Math.log10(g / 32) + FDS_MASTER_DB[master]);
  const pitchOfNow = () => pitchOf((clock * pitch) / 2 ** 22);
  const steps = () => waveOf([...wave], 63);
  const lfo = (t) => (!modHalt && modFreq && env[1].gain
    ? { table: table.map((c) => FDS_MOD_OF[c]), freq: modFreq, depth: Math.min(63, env[1].gain), reset: t - resetAt <= SETUP_T } : null);
  const strike = (t, kind) => {
    on = true;
    gainNow = level();
    pitchNow = burstFrom = pitchOfNow();
    waveNow = steps();
    ev(KEY, { t, kind, pitch: pitchNow, vel: vel(gainNow), wave: waveNow, lfo: lfo(t), kindOf: "wave" });
  };
  const running = (e) => !e.off && !envHalt && !waveHalt && envMaster > 0;
  // The envelopes' steps up to `t`, each a level the note moves to.
  const advance = (t) => {
    for (const e of env) {
      if (!running(e)) { e.at = t; continue; }
      const period = (RATE * 8 * (e.speed + 1) * envMaster) / clock;
      while (e.at + period <= t) {
        e.at += period;
        if (e.up ? e.gain >= 32 : e.gain <= 0) { e.at = t; break; }
        e.gain += e.up ? 1 : -1;
        if (e === env[0]) sync(e.at, true);
      }
    }
  };
  // What a change did to the note: started, ended, struck again, or moved.
  // A driver strikes a note by writing its pitch and its gain together, in
  // either order: the gain up, or the pitch a semitone or more from where
  // the burst found it — or the gain alone jumping up (a note on the same
  // pitch), or that jump with the modulation set (a note of its own).
  const sync = (t, stepped = false) => {
    const g = level();
    if (!on) { if (g > 0) strike(t, "on"); return; }
    if (g === 0) { on = false; ev(KEY, { t, kind: "off" }); return; }
    const p = pitchOfNow(), pCh = p !== pitchNow, gCh = g !== gainNow;
    if (pCh && t - pitchAt > SETUP_T) burstFrom = pitchNow;
    if (pCh) pitchAt = t;
    const jump = t - pitchAt <= SETUP_T && Math.abs(p - burstFrom) >= 0.5;
    const struck = !stepped && ((gCh && (g > gainNow + 4 || (t - pitchAt <= SETUP_T && (g > gainNow || jump)))) ||
      (pCh && t - velAt <= SETUP_T && (g > gainNow || jump)) || (pCh && jump && t - modAt <= SETUP_T));
    if (gCh && !stepped) velAt = t;
    if (struck) { strike(t, "retrig"); return; }
    if (gCh) { gainNow = g; ev(KEY, { t, kind: "vel", vel: vel(g) }); }
    if (pCh) { pitchNow = p; ev(KEY, { t, kind: "pitch", pitch: p }); }
  };
  return {
    name: "FDS",
    write(a, d, t) {
      advance(t);
      if (a >= 0x40) { if (waveOpen) wave[a - 0x40] = d & 63; return; }
      const envWrite = (e) => {
        e.speed = d & 63; e.up = !!(d & 0x40); e.off = !!(d & 0x80); e.at = t;
        if (e.off) e.gain = d & 63;
      };
      if (a === 0x20) { envWrite(env[0]); sync(t); }
      else if (a === 0x22) { pitch = (pitch & 0xf00) | d; sync(t); }
      else if (a === 0x23) {
        pitch = (pitch & 0xff) | ((d & 15) << 8);
        waveHalt = !!(d & 0x80);
        envHalt = !!(d & 0x40);
        sync(t);
      } else if (a === 0x24) envWrite(env[1]);
      else if (a === 0x25) { if (d & 0x7f) skip("FDS modulation counter set to a value but 0 (its phase)"); else resetAt = t; }
      else if (a === 0x26) modFreq = (modFreq & 0xf00) | d;
      else if (a === 0x27) { modFreq = (modFreq & 0xff) | ((d & 15) << 8); modHalt = !!(d & 0x80); }
      else if (a === 0x28 && modHalt) { table[modPos] = d & 7; modPos = (modPos + 1) & 31; }
      else if (a === 0x29) {
        const closed = waveOpen && !(d & 0x80);
        waveOpen = !!(d & 0x80);
        if (master !== (d & 3)) { master = d & 3; if (on) ev(KEY, { t, kind: "vel", vel: vel(gainNow) }); }
        // The memory rewritten under a sounding note: its timbre moving.
        if (closed && on) {
          const w = steps();
          if (w.join() !== waveNow.join()) { waveNow = w; ev(KEY, { t, kind: "wave", wave: w }); }
        }
      } else if (a === 0x2a) { envMaster = d; for (const e of env) e.at = t; } // the timers start over (synth-fc.js)
      else if (a === 0x3f) { io = !!(d & 2); sync(t); }
      // The modulation moved under a note (read where it starts): after a
      // pitch's jump in the same burst, that note's.
      if (a >= 0x24 && a <= 0x28) {
        modAt = t;
        if (on && t - pitchAt <= SETUP_T && Math.abs(pitchNow - burstFrom) >= 0.5) strike(t, "retrig");
        else if (on) ev(KEY, { t, kind: "lfo", lfo: lfo(t) });
      }
    },
    end: (t) => advance(t),
  };
}

// A channel keyed by its level, as the VRC6's and the N163's are (no key
// bit: a driver sounds a note by its volume): what each change did to the
// note — started, ended, struck again, or moved. A driver strikes a note by
// writing its pitch and its level together, in either order: the level up,
// or the pitch a semitone or more from where the burst found it — or the
// level alone jumping up past `jumpUp` steps (a note on the same pitch).
// `s` is the channel as it stands, null silent: {level, vel, pitch, duty?, wave?}.
function levelKeyed(ev, key, kindOf, jumpUp) {
  let on = false, level = 0, pitch = null, duty = null, wave = null;
  let velAt = -Infinity, pitchAt = -Infinity, burstFrom = null;
  const strike = (t, kind, s) => {
    on = true;
    ({ level, pitch, duty = null, wave = null } = s);
    burstFrom = pitch;
    ev(key, { t, kind, pitch, vel: s.vel, kindOf, ...(duty != null ? { duty } : {}), ...(wave ? { wave } : {}) });
  };
  return {
    sync(t, s) {
      if (!on) { if (s) strike(t, "on", s); return; }
      if (!s) { on = false; ev(key, { t, kind: "off" }); return; }
      const pCh = s.pitch !== pitch, lCh = s.level !== level;
      if (pCh && t - pitchAt > SETUP_T) burstFrom = pitch;
      if (pCh) pitchAt = t;
      const jump = t - pitchAt <= SETUP_T && Math.abs(s.pitch - burstFrom) >= 0.5;
      const struck = (lCh && (s.level > level + jumpUp || (t - pitchAt <= SETUP_T && (s.level > level || jump)))) ||
        (pCh && t - velAt <= SETUP_T && (s.level > level || jump));
      if (lCh) velAt = t;
      if (struck) { strike(t, "retrig", s); return; }
      if (lCh) { level = s.level; ev(key, { t, kind: "vel", vel: s.vel }); }
      if (pCh) { pitch = s.pitch; ev(key, { t, kind: "pitch", pitch }); }
      if (s.duty != null && s.duty !== duty) { duty = s.duty; ev(key, { t, kind: "duty", duty }); }
      if (s.wave && s.wave.join() !== wave?.join()) { wave = s.wave; ev(key, { t, kind: "wave", wave }); }
    },
  };
}

// The VRC6 (chips/vrc6.js), at its CPU addresses — no VGM command writes
// it, so only an NSF reaches it: $9000 / $A000 a pulse's duty (6-4, in
// sixteenths less one), its volume (3-0) and bit 7 its 100 % duty (a level
// held: no tone), $9001-$9002 / $A001-$A002 its 12-bit period and enable
// (the clock / 16 / (period + 1)); $B000 the saw's rate (5-0), $B001-$B002
// its period (the clock / 14 / (period + 1)); $9003 bit 0 halts all three.
// Its levels are linear: a pulse's 4 bits, the saw's rate over 63 (past 42
// it wraps, a harsher tone at the same level — as the language reads it).
function vrc6Chip(clock, { ev }) {
  const r = new Uint8Array(12); // (high nibble − 9) × 4 + the low two bits
  const keyed = [0, 1, 2].map((c) => levelKeyed(ev, c < 2 ? `VRC6 SQ${c + 1}` : "VRC6 saw", "psg", c < 2 ? 4 : 16));
  const velOf = (v, full) => (v > 0 ? velOfDb(20 * Math.log10(v / full)) : 0);
  const stateOf = (c) => {
    const ctl = r[4 * c], hi = r[4 * c + 2];
    const period = ((hi & 15) << 8) | r[4 * c + 1];
    const hz = clock / ((c < 2 ? 16 : 14) * (period + 1));
    const level = c < 2 ? (ctl & 0x80 ? 0 : ctl & 15) : ctl & 63;
    if (!(hi & 0x80) || r[3] & 1 || level === 0 || hz > TONE_MAX_HZ) return null;
    return c < 2 ? { level, vel: velOf(level, 15), pitch: pitchOf(hz), duty: ((ctl >> 4) & 7) + 1 }
      : { level, vel: velOf(level, 63), pitch: pitchOf(hz) };
  };
  return {
    name: "VRC6",
    write(addr, d, t) {
      const i = (((addr >> 12) - 9) << 2) | (addr & 3);
      if (i < 0 || i > 11) return;
      r[i] = d;
      if (i === 3) { for (let c = 0; c < 3; c++) keyed[c].sync(t, stateOf(c)); return; }
      keyed[i >> 2].sync(t, stateOf(i >> 2));
    },
  };
}

// The N163 (chips/n163.js), at its CPU addresses — no VGM command writes it:
// $F800 selects a byte of its 128 (bit 7 steps on after each), $4800 writes
// (or reads) it. Channel n's registers are 8 bytes at $40 + 8 (n − 1): its
// 18-bit frequency, its wave's length (256 − $x4 & $FC samples) and start (a
// sample address, $x6), its volume ($x7); $7F's bits 6-4 are how many run,
// less one, channel 8 down. A tone is the clock × f / (15 × 65536 × length
// × count). A row is the chip's channel ("N163 CH8", on n163-wave1 — the
// language's wave1 is the chip's channel 8). The wave is the 4-bit samples
// as the note starts and as the memory is rewritten under it (a frame's
// writes at once, `frame`), on 32 steps however long it is: a shorter one
// stretched, a longer one read every few (skipped, said), the pitch its own.
function n163Chip(clock, { ev, skip }) {
  const ram = new Uint8Array(128);
  let at = 0, waveDirty = false;
  const keyed = Array.from({ length: 8 }, (_, i) => levelKeyed(ev, `N163 CH${i + 1}`, "wave", 4));
  const count = () => ((ram[0x7f] >> 4) & 7) + 1;
  const sample = (n) => (ram[(n >> 1) & 127] >> ((n & 1) * 4)) & 15;
  const waveOfCh = (b) => {
    const len = 256 - (ram[b + 4] & 0xfc), start = ram[b + 6];
    if (len > 32) skip("N163 waves of more than 32 samples (read every few, on 32 steps)");
    return waveOf(Array.from({ length: 32 }, (_, i) => sample((start + Math.floor((i * len) / 32)) & 0xff)), 15);
  };
  const stateOf = (i) => {
    const b = 0x40 + 8 * i;
    if (i < 8 - count()) return null; // not running
    const f = ram[b] | (ram[b + 2] << 8) | ((ram[b + 4] & 3) << 16);
    const len = 256 - (ram[b + 4] & 0xfc);
    const level = ram[b + 7] & 15;
    const hz = (clock * f) / (15 * 65536 * len * count());
    if (!level || !f || hz > TONE_MAX_HZ) return null;
    return { level, vel: velOfDb(20 * Math.log10(level / 15)), pitch: pitchOf(hz), wave: waveOfCh(b) };
  };
  const syncAll = (t) => { for (let i = 0; i < 8; i++) keyed[i].sync(t, stateOf(i)); waveDirty = false; };
  return {
    name: "N163",
    write(addr, d, t) {
      if (addr >= 0xf800) { at = d; return; }
      const a = at & 127;
      ram[a] = d;
      if (at & 0x80) at = 0x80 | ((a + 1) & 127);
      if (a === 0x7f) syncAll(t);
      else if (a >= 0x40 && (a & 7) !== 6) keyed[(a - 0x40) >> 3].sync(t, stateOf((a - 0x40) >> 3));
      else waveDirty = true;
    },
    read() {
      const a = at & 127;
      if (at & 0x80) at = 0x80 | ((a + 1) & 127);
      return ram[a];
    },
    frame(t) { if (waveDirty) syncAll(t); },
  };
}

/**
 * The Famicom's sound chips at their CPU addresses, for an NSF's run
 * (import-nsf.js): `exp` its header's expansions ({vrc6, vrc7, fds, mmc5,
 * n163, s5b}), `ram(start, len)` the CPU's memory as it stands (a DMC
 * hit's sample). Each chip starts at its first write, as parseVgm's do.
 * `write(addr, d, t)` a write at sample `t`; `read(addr)` a chip register
 * the CPU reads back (the N163's memory; else null); `frame(t)` after each
 * play call; `finish(end, meta)` → what parseVgm returns.
 */
export function nesChips({ exp = {}, ram, clock = 1789773 }) {
  const events = new Map(), kinds = new Map(), chips = [], skipped = new Map();
  const ev = (k, e) => {
    if (!events.has(k)) events.set(k, []);
    events.get(k).push(e);
    if (e.kindOf) kinds.set(k, e.kindOf);
  };
  const skip = (name) => skipped.set(name, (skipped.get(name) ?? 0) + 1);
  const pcm = pcmChips({ segaClock: 4000000, segaIntf: 0, opnbClock: 8000000, opnaClock: 7987200, ramWrite: () => {} });
  const MAKE = {
    apu: () => apuChip(clock, { ev, skip, pcm, ram }),
    mmc5: () => apuChip(clock, { ev, skip, pcm, ram, mmc5: true }),
    fds: () => fdsChip(clock, { ev, skip }),
    vrc6: () => vrc6Chip(clock, { ev }),
    vrc7: () => opllChip(3579545, { ev, vrc7: true }),
    n163: () => n163Chip(clock, { ev, skip }),
    s5b: () => ayChip("5B", clock / 2, { ev }),
  };
  const made = new Map();
  const chip = (k) => {
    if (!made.has(k)) { const m = MAKE[k](); made.set(k, m); chips.push(m.name); }
    return made.get(k);
  };
  let opllAt = 0, ayAt = 0;
  return {
    write(a, d, t) {
      if (a >= 0x4000 && a <= 0x4017) { if (a !== 0x4014 && a !== 0x4016) chip("apu").write(a - 0x4000, d, t); }
      else if (exp.fds && a >= 0x4040 && a <= 0x407f) chip("fds").write(a - 0x4000, d, t);
      else if (exp.fds && a >= 0x4080 && a <= 0x409e) chip("fds").write(a - 0x4080 + 0x20, d, t);
      else if (exp.fds && a === 0x4023) chip("fds").write(0x3f, d, t);
      else if (exp.mmc5 && a >= 0x5000 && a <= 0x5015) chip("mmc5").write(a - 0x5000, d, t);
      else if (exp.vrc6 && ((a >= 0x9000 && a <= 0x9003) || (a >= 0xa000 && a <= 0xa002) || (a >= 0xb000 && a <= 0xb002))) chip("vrc6").write(a, d, t);
      else if (exp.vrc7 && a === 0x9010) opllAt = d;
      else if (exp.vrc7 && a === 0x9030) chip("vrc7").write(opllAt, d, t);
      else if (exp.n163 && ((a >= 0x4800 && a <= 0x4fff) || a >= 0xf800)) chip("n163").write(a >= 0xf800 ? 0xf800 : 0x4800, d, t);
      else if (exp.s5b && a >= 0xc000 && a <= 0xdfff) ayAt = d & 15;
      else if (exp.s5b && a >= 0xe000) chip("s5b").write(ayAt, d, t);
    },
    read(a) {
      if (exp.n163 && a >= 0x4800 && a <= 0x4fff) return chip("n163").read();
      return null;
    },
    frame(t) { made.get("n163")?.frame(t); },
    finish(end, meta = {}) {
      for (const m of made.values()) m.end?.(end);
      // The run went on past the song's end (to see its loop come round): what it wrote there is not the song's.
      for (const [k, evs] of events) events.set(k, evs.filter((e) => e.t < end));
      const pcmRoms = new Map();
      const pcmHits = pcm.finish(end, pcmRoms);
      return { chips, skipped, clockNotes: [], events, kinds, totalSamples: end, loopSample: null, title: null, author: null,
        game: null, system: null, dac: false, dacBank: new Uint8Array(0), dacHits: [], pcmRoms, pcmHits, rhythmHits: [],
        opllRhythmHits: [], ...meta };
    },
  };
}

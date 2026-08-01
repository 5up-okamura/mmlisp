// Run the assembled MMLispDRV binary in the first-party Z80 emulator with the
// Mega Drive Z80 memory map, playing the host (68000) role:
//   - load the driver at 0x0000 (8KB RAM), the MMB into the banked window
//     at 0x8000;
//   - boot until the driver halts and reports ready (0xD2);
//   - enqueue START_TRACK mailbox commands for every track in the MMB;
//   - fire one vblank interrupt per frame, collecting YM/PSG register writes
//     stamped with the frame number — the same {frame, port, addr, data}
//     shape drv-player.js captureRegisterLog emits.
import { readFileSync, writeFileSync } from "node:fs";
import { Z80Cpu } from "./z80cpu.mjs";

const RAM_SIZE = 0x2000;
const MB_BASE = 0x18f0; // mailbox (published); tracks the driver DATA_BASE
const MB_HEAD = MB_BASE + 0x20;
const MB_TSTAT = MB_BASE + 0x22; // 16 per-track status bytes (driver.md §6.1)
const MB_READY = MB_BASE + 0x32;

export function runTrace(
  driverBin,
  mmbBytes,
  {
    frames,
    maxStepsPerFrame = 2_000_000,
    commands = [],
    // Overlay support: a second ROM blob at a distinct bank the driver loads
    // cold code from. When absent, the window always serves the MMB (the M1
    // model) and the bank register is tracked but otherwise inert.
    overlay = null,
    overlayBank = null,
    // PCM sample bank (plan-se.md): a third ROM blob at its own bank the mixer
    // latches per frame. The host publishes its number in G_SMP_BANK; when
    // absent, no PCM banking happens.
    sampleBank = null,
    sampleBankNumber = 2,
    // The ROM bank the MMB itself rides. Deliberately non-zero: a host places
    // the MMB wherever rescomp aligns it (drv/sgdk/README.md), so the driver
    // must latch the bank the START_TRACK command carries before it reads the
    // window. Bank 0 as the default would let an unlatched read pass.
    mmbBank = 4,
    // Auto-start every track at frame 0 (the M1 default). With `false`
    // (plan-se.md SE gate) no track auto-starts; the `commands` schedule drives
    // START_TRACK / START_SE, so the SE track can be held back until mid-song.
    autoStart = true,
    // Cycle profiling. Pass buildDriver()'s symbol map to get, per frame, the
    // Z80 cycles the frame cost and where they went. A frame is 59,659 cycles;
    // overrunning costs a whole frame (the next /INT is missed), which is
    // audible as half-speed tempo and a detuned PCM feed — so this is the tool
    // for "it plays but it drags". Off by default: it costs ~2x runtime.
    profile = null,
    // With `profile`, also bucket the routine costs of the frames that exceed
    // this many cycles. The interesting frames are not the median ones — the
    // median frame is cheap and the deadline is missed on the note-onset
    // spikes, and a whole-run average hides what makes those spikes.
    profileSplitAt = 0,
  } = {},
) {
  if (driverBin.length > MB_BASE) {
    throw new Error(
      `driver image ${driverBin.length} bytes overruns the data floor at 0x${MB_BASE.toString(16)}`,
    );
  }
  const ram = new Uint8Array(RAM_SIZE);
  ram.set(driverBin, 0);
  const writes = [];
  let frame = 0;
  const latch = [0, 0];
  // Mega Drive Z80 bank register: a 9-bit shift register at 0x6000. Each write
  // inserts bit0 of the value at bit 8 and shifts right; 9 writes set the bank
  // (the top 9 bits of the 68k address the 0x8000-0xFFFF window maps to).
  let bankReg = 0;

  const cpu = new Z80Cpu({
    read: (a) => {
      a &= 0xffff;
      if (a < RAM_SIZE) return ram[a];
      if (a === 0x4000) return 0; // YM status: never BUSY in the harness
      if (a >= 0x8000) {
        const off = a & 0x7fff;
        if (overlay && bankReg === overlayBank) return overlay[off] ?? 0;
        if (sampleBank && bankReg === sampleBankNumber) return sampleBank[off] ?? 0;
        if (bankReg === mmbBank) return mmbBytes[off] ?? 0;
        // Any other bank is NOT the MMB. Returning the MMB here regardless of
        // the bank register (what this harness used to do) hides every missing
        // bank latch: on hardware those reads hit unrelated ROM. 0xFF is the
        // "wrong bank" marker — a driver that reads the window without latching
        // now diverges here instead of only on a Mega Drive.
        return 0xff;
      }
      return 0xff;
    },
    write: (a, v) => {
      a &= 0xffff;
      v &= 0xff;
      if (a < RAM_SIZE) {
        ram[a] = v;
        return;
      }
      switch (a) {
        case 0x4000: latch[0] = v; return;
        case 0x4001: writes.push({ frame, port: 0, addr: latch[0], data: v }); return;
        case 0x4002: latch[1] = v; return;
        case 0x4003: writes.push({ frame, port: 1, addr: latch[1], data: v }); return;
        case 0x7f11: writes.push({ frame, port: 2, addr: 0, data: v }); return;
        case 0x6000: bankReg = ((bankReg >> 1) | ((v & 1) << 8)) & 0x1ff; return;
        default: return;
      }
    },
  });

  // Publish the overlay ROM bank BEFORE releasing reset: the boot code itself now
  // lives in the ovl_boot overlay, so the reset stub loads it using G_OVL_BANK
  // (MB_BASE+0x34), and ovl_boot's RAM clear preserves that global. On hardware
  // the 68k writes this into Z80 RAM while holding the Z80 in reset.
  if (overlay) {
    ram[MB_BASE + 0x34] = overlayBank & 0xff;
    ram[MB_BASE + 0x35] = (overlayBank >> 8) & 0xff;
  }
  // Publish the PCM sample bank number (G_SMP_BANK = MB_BASE+0x39) the same way,
  // so the mixer can latch it. 0 = none (no PCM banking).
  if (sampleBank) {
    ram[MB_BASE + 0x39] = sampleBankNumber & 0xff;
    ram[MB_BASE + 0x3a] = (sampleBankNumber >> 8) & 0xff;
  }

  // Boot until the idle halt.
  let steps = 0;
  while (!cpu.halted && steps++ < maxStepsPerFrame) cpu.step();
  if (!cpu.halted) throw new Error("driver did not reach the idle loop");
  if (ram[MB_READY] !== 0xd2) {
    throw new Error(`driver_ready = 0x${ram[MB_READY].toString(16)}, want 0xD2`);
  }

  // 68k role: START_TRACK for every track in the MMB track table — unless the
  // caller drives starts explicitly (SE gate), where the command schedule posts
  // START_TRACK / START_SE itself and the ring starts empty.
  const tracks = readTrackTable(mmbBytes);
  if (autoStart) {
    // The ring holds 8 cells but only 7 entries: head==tail means empty, so at
    // 8 the head wraps onto the tail and the driver drains nothing. A song with
    // more tracks than that is legal — the host just has to spread the starts
    // over frames — so drive it with a command schedule instead of autoStart.
    if (tracks.length > 7) {
      throw new Error(
        `${tracks.length} tracks exceeds the 7-entry mailbox ring; ` +
          `pass autoStart:false and post START_TRACK over several frames`,
      );
    }
    tracks.forEach((t, i) => {
      const cell = MB_BASE + i * 4;
      ram[cell + 1] = t.trackId; // a0
      ram[cell + 2] = mmbBank & 0xff; // bank low
      ram[cell + 3] = (mmbBank >> 8) & 0xff; // bank high
      ram[cell] = 0x01; // cmd byte last (ring discipline)
    });
    ram[MB_HEAD] = tracks.length & 7;
  }

  // Host mailbox schedule: post commands into the ring just before the frame's
  // interrupt so the Z80 drains them at the top of that frame (§4 step 1).
  const cmdByFrame = new Map();
  for (const c of commands) {
    if (!cmdByFrame.has(c.frame)) cmdByFrame.set(c.frame, []);
    cmdByFrame.get(c.frame).push(c);
  }
  const postCommand = (c) => {
    const head = ram[MB_HEAD];
    const cell = MB_BASE + head * 4;
    // START_TRACK carries the MMB's ROM bank in a1/a2 — a real host always
    // supplies it, so a schedule that omits it gets the harness's mmbBank
    // rather than bank 0 (which no longer maps to the MMB).
    const isStart = c.cmd === 0x01;
    ram[cell + 1] = c.a0 ?? 0;
    ram[cell + 2] = c.a1 ?? (isStart ? mmbBank & 0xff : 0);
    ram[cell + 3] = c.a2 ?? (isStart ? (mmbBank >> 8) & 0xff : 0);
    ram[cell] = c.cmd; // cmd byte last (ring discipline)
    ram[MB_HEAD] = (head + 1) & 7;
  };

  // Profiling: attribute each instruction's cycles to the nearest preceding
  // symbol. Overlay code all lives at one address, so it is bucketed by the
  // overlay index the driver has loaded (G_CUR_OVL) rather than by symbol.
  const symEntries = profile
    ? profile instanceof Map
      ? [...profile]
      : Object.entries(profile)
    : null;
  const OVERLAY_SLOT =
    symEntries?.find(([n]) => n === "OVERLAY_SLOT")?.[1] ?? 0x17de;
  const G_CUR_OVL = MB_BASE + 0x38;
  const symTab = symEntries
    ? symEntries
        .filter(([n, a]) => typeof a === "number" && a > 0 && a < OVERLAY_SLOT &&
          // tables.z80's LUT offsets are plain `equ` constants, not addresses.
          // Small ones land inside the code region and would otherwise steal
          // the cycles of whatever routine actually spans them.
          !n.endsWith("_OFF"))
        .sort((a, b) => a[1] - b[1])
    : null;
  const symAddrs = symTab?.map(([, a]) => a);
  const byRoutine = new Map();
  const byRoutineHeavy = new Map();
  const thisFrame = new Map();
  let heavyFrames = 0;
  const frameCycles = [];
  const siteFor = (pc) => {
    if (pc >= OVERLAY_SLOT) return `ovl${ram[G_CUR_OVL]}`;
    let lo = 0;
    let hi = symAddrs.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (symAddrs[mid] <= pc) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return symTab[best][0];
  };

  // Frame loop.
  const markerLog = []; // per-frame snapshot of each track's MB_TSTAT id bits
  for (frame = 0; frame < frames; frame++) {
    for (const c of cmdByFrame.get(frame) ?? []) postCommand(c);
    cpu.intRequest();
    let s = 0;
    let cycles = 0;
    while (s++ < maxStepsPerFrame) {
      if (profile) {
        const pc = cpu.pc;
        const c = cpu.step();
        cycles += c;
        const site = siteFor(pc);
        byRoutine.set(site, (byRoutine.get(site) ?? 0) + c);
        if (profileSplitAt) thisFrame.set(site, (thisFrame.get(site) ?? 0) + c);
      } else {
        cpu.step();
      }
      if (cpu.halted && !cpu.intPending) break;
    }
    if (profile) frameCycles.push(cycles);
    if (profileSplitAt) {
      if (cycles > profileSplitAt) {
        heavyFrames++;
        for (const [k, v] of thisFrame) {
          byRoutineHeavy.set(k, (byRoutineHeavy.get(k) ?? 0) + v);
        }
      }
      thisFrame.clear();
    }
    if (!cpu.halted) throw new Error(`frame ${frame} did not finish`);
    markerLog.push(
      Array.from({ length: tracks.length }, (_, i) => ram[MB_TSTAT + i] & 0x3f),
    );
  }

  // stackMin = the lowest SP reached across boot + every frame (the stack
  // watermark; tools/budget.mjs turns it into "bytes used vs STACK_FLOOR").
  return {
    frames,
    writes,
    ram,
    markerLog,
    stackMin: cpu.spMin,
    ...(profile ? { frameCycles, byRoutine } : {}),
    ...(profileSplitAt ? { byRoutineHeavy, heavyFrames } : {}),
  };
}

function readTrackTable(b) {
  const u16 = (o) => b[o] | (b[o + 1] << 8);
  const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  if (!(b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x42 && b[3] === 0x30)) {
    throw new Error("not an MMB file");
  }
  const sectionCount = u16(8);
  const headerSize = u16(10);
  for (let i = 0; i < sectionCount; i++) {
    const at = headerSize + i * 12;
    if (u16(at) === 0x0001) {
      const off = u32(at + 4);
      const count = u16(off);
      const tracks = [];
      for (let t = 0; t < count; t++) {
        const e = off + 2 + t * 5;
        tracks.push({ trackId: b[e], channelId: b[e + 1] });
      }
      return tracks;
    }
  }
  throw new Error("MMB has no TRACK_TABLE");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const fIdx = args.indexOf("--frames");
  const frames = fIdx >= 0 ? Number(args.splice(fIdx, 2)[1]) : 600;
  const [binPath, mmbPath, outPath] = args;
  if (!binPath || !mmbPath) {
    console.error(
      "usage: node run-trace.mjs <driver.bin> <song.mmb> [out.json] [--frames N]",
    );
    process.exit(2);
  }
  const trace = runTrace(
    new Uint8Array(readFileSync(binPath)),
    new Uint8Array(readFileSync(mmbPath)),
    { frames },
  );
  const json = JSON.stringify({ frames: trace.frames, writes: trace.writes });
  if (outPath) {
    writeFileSync(outPath, json);
    console.log(`${outPath}: ${trace.writes.length} writes over ${trace.frames} frames`);
  } else {
    console.log(json);
  }
}

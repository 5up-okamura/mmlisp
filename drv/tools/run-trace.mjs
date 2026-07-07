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
        return mmbBytes[off] ?? 0; // MMB bank (the driver latches it as bank 0)
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

  // Boot until the idle halt.
  let steps = 0;
  while (!cpu.halted && steps++ < maxStepsPerFrame) cpu.step();
  if (!cpu.halted) throw new Error("driver did not reach the idle loop");
  if (ram[MB_READY] !== 0xd2) {
    throw new Error(`driver_ready = 0x${ram[MB_READY].toString(16)}, want 0xD2`);
  }

  // 68k role: START_TRACK for every track in the MMB track table.
  const tracks = readTrackTable(mmbBytes);
  if (tracks.length > 8) throw new Error("more tracks than mailbox cells");
  tracks.forEach((t, i) => {
    const cell = MB_BASE + i * 4;
    ram[cell + 1] = t.trackId; // a0
    ram[cell + 2] = 0; // bank low
    ram[cell + 3] = 0; // bank high
    ram[cell] = 0x01; // cmd byte last (ring discipline)
  });
  ram[MB_HEAD] = tracks.length & 7;

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
    ram[cell + 1] = c.a0 ?? 0;
    ram[cell + 2] = c.a1 ?? 0;
    ram[cell + 3] = c.a2 ?? 0;
    ram[cell] = c.cmd; // cmd byte last (ring discipline)
    ram[MB_HEAD] = (head + 1) & 7;
  };

  // Frame loop.
  for (frame = 0; frame < frames; frame++) {
    for (const c of cmdByFrame.get(frame) ?? []) postCommand(c);
    cpu.intRequest();
    let s = 0;
    while (s++ < maxStepsPerFrame) {
      cpu.step();
      if (cpu.halted && !cpu.intPending) break;
    }
    if (!cpu.halted) throw new Error(`frame ${frame} did not finish`);
  }

  return { frames, writes, ram };
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

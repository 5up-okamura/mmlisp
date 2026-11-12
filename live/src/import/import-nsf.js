// ---------------------------------------------------------------------------
// NSF (.nsf, .nsfe) → MMLisp, :target fc
//
// An NSF is a Famicom song's own code — its driver and its data — with an
// init and a play routine: init picks the song, play runs once a frame. So
// the song is run (cpu6502.js) and what it writes to the sound chips is read
// as a VGM's writes are (import-vgm.js nesChips: the 2A03, and the VRC6,
// VRC7, FDS, MMC5, N163 and 5B its header names) — the rows, the dialog and
// the score are the VGM import's. A write lands at its frame's start plus
// the cycles the play routine took to reach it; a DMC hit's sample is the
// memory as the banks map it at that moment.
//
// The memory (nesdev's NSF page): RAM at $0000-$07FF, $6000-$7FFF RAM,
// $8000-$FFFF the program — loaded at its address, or, with any bank byte
// set, in 4 KB banks switched by $5FF8-$5FFF (the FDS's $6000-$FFFF is RAM,
// $5FF6-$5FFF banking all of it). The MMC5's multiplier and ExRAM answer, as
// drivers use them; the N163's memory reads back.
//
// NSF has no length: the song runs till its state comes round again — RAM
// and the banks at a play call as they were at an earlier one, so the driver
// writes from there what it wrote from then: a loop exact by construction
// (not the chips' registers: a note held across the loop point would put it
// a section late) — else till its writes repeat (a driver with a
// counter of its own never comes round: the frames' writes from some point
// on a period over two times, a second at least), else to its NSFe / NSF2
// length or MAX_SECONDS, said. A song that stops (its writes all the same
// from a frame on) ends there, not looping.
//
//   parseNsf(bytes)                  → { songs, start, titles, times, … }
//   nsfSongName(fileName, nsf, song) → `game #03 Title.nsf`, a song as a file
//   runNsf(nsf, song)                → what parseVgm returns (format "NSF")
// ---------------------------------------------------------------------------

import { Cpu6502 } from "./cpu6502.js";
import { nesChips } from "./import-vgm.js";
import { RATE } from "./import-song.js";

const CLOCK_NTSC = 1789773, CLOCK_PAL = 1662607;
export const MAX_SECONDS = 300;
const TRAP = 0x5ff4; // the address a routine returns to (a JSR from there): no chip, no bank
const MIN_LOOP_FRAMES = 60;

const EXP = ["vrc6", "vrc7", "fds", "mmc5", "n163", "s5b"];
const EXP_NAMES = { vrc6: "VRC6", vrc7: "VRC7", fds: "FDS", mmc5: "MMC5", n163: "N163", s5b: "5B" };

const latin = (u8) => {
  let s = "";
  for (const b of u8) { if (!b) break; s += String.fromCharCode(b); }
  return s.trim();
};
// NSFe's strings are UTF-8 (NSF's header text, its own era's, read as is).
const utf8 = (u8) => new TextDecoder("utf-8").decode(u8);

/** NSFe's chunks (the file's, or an NSF2's metadata): [{id, data}]. */
function chunks(u8, p) {
  const out = [];
  while (p + 8 <= u8.length) {
    const len = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24);
    const id = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    if (id === "NEND") break;
    out.push({ id, data: u8.subarray(p + 8, p + 8 + len) });
    p += 8 + len;
  }
  return out;
}

// What NSFe's metadata chunks say, onto `nsf`.
function readMeta(nsf, list) {
  const s32 = (d, i) => d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24);
  for (const { id, data } of list) {
    if (id === "auth") {
      const [game, artist, copyright] = utf8(data).split("\0");
      if (game) nsf.name = game;
      if (artist) nsf.artist = artist;
      if (copyright) nsf.copyright = copyright;
    } else if (id === "tlbl") nsf.titles = utf8(data).split("\0").slice(0, nsf.songs);
    else if (id === "time") nsf.times = Array.from({ length: data.length >> 2 }, (_, i) => s32(data, 4 * i));
    else if (id === "plst") nsf.playlist = [...data];
    else if (id === "RATE" && data.length >= 2) {
      nsf.speedNtsc = data[0] | (data[1] << 8);
      if (data.length >= 4) nsf.speedPal = data[2] | (data[3] << 8);
    }
  }
}

/** An NSF, NSF2 or NSFe file → its header, program and metadata. */
export function parseNsf(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const magic = String.fromCharCode(...u8.subarray(0, 4));
  const u16 = (o) => u8[o] | (u8[o + 1] << 8);
  const nsf = { titles: [], times: [], playlist: null, notes: [] };
  if (magic === "NESM" && u8[4] === 0x1a) {
    nsf.version = u8[5];
    nsf.songs = u8[6] || 1;
    nsf.start = Math.max(1, u8[7]) - 1;
    nsf.load = u16(8); nsf.init = u16(0x0a); nsf.play = u16(0x0c);
    nsf.name = latin(u8.subarray(0x0e, 0x2e));
    nsf.artist = latin(u8.subarray(0x2e, 0x4e));
    nsf.copyright = latin(u8.subarray(0x4e, 0x6e));
    nsf.speedNtsc = u16(0x6e);
    nsf.banks = [...u8.subarray(0x70, 0x78)];
    nsf.banked = nsf.banks.some((b) => b);
    nsf.speedPal = u16(0x78);
    nsf.region = u8[0x7a];
    nsf.exp = u8[0x7b];
    // NSF2: its flags, and its metadata (NSFe's chunks) after the program.
    const len = u8[0x7d] | (u8[0x7e] << 8) | (u8[0x7f] << 16);
    if (nsf.version >= 2 && u8[0x7c] & 0x30) nsf.notes.push("the NSF2's IRQ and non-returning init are not run: its play routine is called a frame at a time");
    nsf.data = nsf.version >= 2 && len ? u8.subarray(0x80, 0x80 + len) : u8.subarray(0x80);
    if (nsf.version >= 2 && len) readMeta(nsf, chunks(u8, 0x80 + len));
  } else if (magic === "NSFE") {
    const list = chunks(u8, 4);
    const info = list.find((c) => c.id === "INFO")?.data;
    const data = list.find((c) => c.id === "DATA")?.data;
    if (!info || !data) throw new Error("NSFe: no INFO or DATA chunk");
    const i16 = (o) => info[o] | (info[o + 1] << 8);
    nsf.version = 0;
    nsf.load = i16(0); nsf.init = i16(2); nsf.play = i16(4);
    nsf.region = info[6]; nsf.exp = info[7];
    nsf.songs = info.length > 8 ? info[8] || 1 : 1;
    nsf.start = info.length > 9 ? info[9] : 0;
    const bank = list.find((c) => c.id === "BANK")?.data;
    nsf.banks = Array.from({ length: 8 }, (_, i) => bank?.[i] ?? 0);
    nsf.banked = !!bank;
    nsf.speedNtsc = 0; nsf.speedPal = 0;
    nsf.name = ""; nsf.artist = ""; nsf.copyright = "";
    nsf.data = data;
    readMeta(nsf, list);
  } else throw new Error("not an NSF file");
  nsf.chips = Object.fromEntries(EXP.map((k, i) => [k, !!(nsf.exp & (1 << i))]));
  if (nsf.exp & 0xc0) nsf.notes.push("an expansion this importer does not know is in the header (bits 6-7)");
  // PAL alone (bit 0 without bit 1) runs at PAL's clock and rate.
  nsf.pal = (nsf.region & 3) === 1;
  return nsf;
}

/** The songs in the order the file plays them (an NSFe playlist), 0-based. */
export const nsfSongOrder = (nsf) => nsf.playlist?.filter((i) => i < nsf.songs) ?? Array.from({ length: nsf.songs }, (_, i) => i);

/**
 * Song `song`'s name as a file of its own — what Live's folder list shows
 * and the score is named by: `game #03 Title.nsf`, its NSFe / NSF2 label
 * where it has one (without the characters a file name cannot hold).
 */
export function nsfSongName(fileName, nsf, song) {
  const ext = fileName.match(/\.[^.]*$/)?.[0] ?? ".nsf";
  const title = (nsf.titles[song] ?? "").replace(/[\\/:*?"<>|]/g, "").trim();
  return `${fileName.slice(0, fileName.length - ext.length)} #${String(song + 1).padStart(2, "0")}${title ? ` ${title}` : ""}${ext}`;
}

/**
 * Song `song` (0-based) run and read → what parseVgm returns, with `notes`
 * on what the run did. `onWrite(addr, value, t)` sees every chip write.
 */
export function runNsf(nsf, song = nsf.start, { maxSeconds = MAX_SECONDS, onWrite = null } = {}) {
  const clock = nsf.pal ? CLOCK_PAL : CLOCK_NTSC;
  const speed = (nsf.pal ? nsf.speedPal : nsf.speedNtsc) || (nsf.pal ? 19997 : 16639); // µs a play call
  const period = (speed * RATE) / 1e6; // samples a frame
  const notes = [...nsf.notes];
  const fds = nsf.chips.fds;

  // The memory: the CPU's 64 KB as mapped now, a bank written in by copying its 4 KB.
  const mem = new Uint8Array(0x10000);
  const pad = nsf.load & 0xfff;
  const image = new Uint8Array(Math.max(4096, Math.ceil((pad + nsf.data.length) / 4096) * 4096));
  image.set(nsf.data, pad);
  const bankRegs = new Uint8Array(10); // $5FF6-$5FFF
  const bank = (slot, n) => { // slot 0 → $6000 … 9 → $F000
    bankRegs[slot] = n;
    const src = (n * 4096) % image.length;
    mem.set(image.subarray(src, src + 4096), 0x6000 + slot * 4096);
  };
  if (nsf.banked) {
    for (let i = 0; i < 8; i++) bank(i + 2, nsf.banks[i]);
    if (fds) { bank(0, nsf.banks[6]); bank(1, nsf.banks[7]); }
  } else {
    if (nsf.load < (fds ? 0x6000 : 0x8000)) throw new Error(`NSF: the program loads at $${nsf.load.toString(16)}, below ${fds ? "$6000" : "$8000"}`);
    mem.set(nsf.data.subarray(0, 0x10000 - nsf.load), nsf.load);
  }

  // The time a write lands: its frame's start and the cycles into the call,
  // never before the write before it (a play call overrunning its frame).
  let frameT = 0, callStart = 0, lastT = 0;
  const cpu = new Cpu6502({ read: () => 0, write: () => {} });
  const now = () => (lastT = Math.max(lastT, frameT + ((cpu.cycles - callStart) * RATE) / clock));
  const chips = nesChips({ exp: nsf.chips, clock, ram: (start, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) { const a = start + i; out[i] = mem[a > 0xffff ? 0x8000 + ((a - 0x10000) & 0x7fff) : a]; }
    return out;
  } });
  // The frame's writes, as its signature.
  let sig1 = 0x811c9dc5, sig2 = 0x9747b28c;
  const mmc5 = { a: 0, b: 0, exram: new Uint8Array(1024) };
  const fdsWave = new Uint8Array(64);
  const toChip = (a, v) => {
    sig1 = Math.imul(sig1 ^ ((a << 8) | v), 16777619);
    sig2 = Math.imul(sig2 ^ ((v << 16) | a), 2246822519) ^ (sig2 >>> 13);
    const t = now();
    onWrite?.(a, v, t); // (the run's own writes, for an A/B against the import)
    chips.write(a, v, t);
  };
  cpu.bus = {
    read(a) {
      if (a < 0x2000) return mem[a & 0x7ff];
      if (a >= 0x6000) return mem[a];
      if (fds && a >= 0x4040 && a <= 0x407f) return fdsWave[a - 0x4040];
      if (nsf.chips.mmc5 && a === 0x5205) return (mmc5.a * mmc5.b) & 0xff;
      if (nsf.chips.mmc5 && a === 0x5206) return (mmc5.a * mmc5.b) >> 8;
      if (nsf.chips.mmc5 && a >= 0x5c00 && a < 0x5ff6) return mmc5.exram[a - 0x5c00];
      return chips.read(a) ?? 0;
    },
    write(a, v) {
      if (a < 0x2000) { mem[a & 0x7ff] = v; return; }
      if (a >= 0x5ff6 && a <= 0x5fff) { if (nsf.banked && (a >= 0x5ff8 || fds)) bank(a - 0x5ff6, v); return; }
      if (a < 0x6000) {
        if (fds && a >= 0x4040 && a <= 0x407f) fdsWave[a - 0x4040] = v & 63;
        if (nsf.chips.mmc5 && a === 0x5205) mmc5.a = v;
        else if (nsf.chips.mmc5 && a === 0x5206) mmc5.b = v;
        else if (nsf.chips.mmc5 && a >= 0x5c00) mmc5.exram[a - 0x5c00] = v;
        if (a >= 0x4000) toChip(a, v);
        return;
      }
      // $6000-$7FFF RAM (the FDS's to $DFFF); above it the cartridge's chips.
      if (a < 0x8000 || (fds && a < 0xe000)) mem[a] = v;
      if (a >= 0x8000) toChip(a, v);
    },
  };

  // The player's start (nesdev): RAM cleared, the APU silent and its
  // channels on, the FDS's sound enabled, then init with the song.
  for (let a = 0x4000; a <= 0x4013; a++) cpu.bus.write(a, 0);
  cpu.bus.write(0x4015, 0);
  cpu.bus.write(0x4015, 0x0f);
  cpu.bus.write(0x4017, 0x40);
  if (fds) { cpu.bus.write(0x4023, 0x02); cpu.bus.write(0x408a, 0xe8); }
  callStart = cpu.cycles;
  if (cpu.call(nsf.init, { a: song, x: nsf.pal ? 1 : 0, y: 0, trap: TRAP, limit: clock * 10 }) < 0)
    throw new Error(`NSF: init did not return${cpu.error ? ` (${cpu.error})` : " within 10 s"}`);
  frameT = 0; // what init wrote is the song's first moment

  // The state at a play call: RAM, the $6000 page, the banks.
  const words = [new Int32Array(mem.buffer, 0, 512), new Int32Array(mem.buffer, 0x6000, 2048)];
  const stateKey = () => {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (const w of words) for (let i = 0; i < w.length; i++) { h1 = Math.imul(h1 ^ w[i], 16777619); h2 = Math.imul(h2 + w[i], 2246822519) ^ (h2 >>> 15); }
    for (const b of bankRegs) h1 = Math.imul(h1 ^ b, 16777619);
    return `${h1 >>> 0}:${h2 >>> 0}`;
  };
  const timeMs = nsf.times[song] > 0 ? nsf.times[song] : 0;
  const maxFrames = Math.ceil(((timeMs ? Math.min(timeMs / 1000, maxSeconds) : maxSeconds) * RATE) / period);
  const seen = new Map();
  const sigs = [];
  let loop = null, stoppedAt = null;
  for (let k = 0; k < maxFrames; k++) {
    const key = stateKey();
    if (seen.has(key)) { loop = { from: seen.get(key), to: k }; break; }
    seen.set(key, k);
    frameT = k * period;
    callStart = cpu.cycles;
    sig1 = 0x811c9dc5; sig2 = 0x9747b28c;
    if (cpu.call(nsf.play, { trap: TRAP, limit: clock }) < 0) {
      notes.push(`the play routine stopped at frame ${k}${cpu.error ? ` (${cpu.error})` : " (it did not return within a second)"}: the song ends there`);
      stoppedAt = k;
      break;
    }
    chips.frame(now());
    sigs.push(`${sig1 >>> 0}:${sig2 >>> 0}`);
  }
  const N = sigs.length;
  // Where the writes stop changing: every frame from there the same as the last.
  let still = N;
  while (still > 0 && sigs[still - 1] === sigs[N - 1]) still--;
  // A loop of P frames may start anywhere in [lo, hi] (the frames before
  // the state came round written alike, a driver's scratch RAM settling a
  // frame late): at the first frame there that writes, and not what the
  // frame before wrote — where the driver acts, a note starting — not on a
  // held note, which the score's loop would strike again.
  const NONE = `${0x811c9dc5}:${0x9747b28c}`; // a frame that writes nothing
  const settle = (lo, hi) => {
    for (let f = lo; f <= hi; f++) if (sigs[f] !== NONE && (f === 0 || sigs[f] !== sigs[f - 1])) return f;
    return lo;
  };
  let end = N, loopFrom = null;
  if (loop) {
    // Come round on frames all alike: the song stopped where they started.
    const P = loop.to - loop.from, alike = sigs.slice(loop.from, loop.to).every((s) => s === sigs[loop.from]);
    let lo = loop.from;
    while (lo > 0 && sigs[lo - 1] === sigs[lo - 1 + P]) lo--;
    if (alike) end = lo;
    else { loopFrom = settle(lo, loop.from); end = loopFrom + P; }
  } else if (stoppedAt == null && N - still >= MIN_LOOP_FRAMES) end = still; // it stopped
  else if (stoppedAt == null) {
    // The writes' period: the earliest start from which they repeat to the
    // end over two periods at least, the shortest period of those.
    let best = null;
    for (let P = MIN_LOOP_FRAMES; 2 * P <= N; P++) {
      let s = N - P;
      while (s > 0 && sigs[s - 1] === sigs[s - 1 + P]) s--;
      if (N - s >= 2 * P && (!best || s < best.s)) best = { s, P };
    }
    if (best) { loopFrom = settle(best.s, N - best.P); end = loopFrom + best.P; }
    else if (!timeMs) notes.push(`no loop found in ${Math.round((N * period) / RATE)} s: the song is cut there`);
  }
  const total = Math.max(1, Math.round(end * period));
  const label = nsf.titles[song] || (nsf.songs > 1 ? `Track ${song + 1}` : null);
  return chips.finish(total, {
    format: "NSF", loopSample: loopFrom != null ? Math.round(loopFrom * period) : null,
    title: label, game: nsf.name || null, author: nsf.artist || null, system: "Famicom", notes,
    nsfChips: EXP.filter((k) => nsf.chips[k]).map((k) => EXP_NAMES[k]),
  });
}

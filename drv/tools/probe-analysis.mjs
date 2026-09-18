// Instrument-only clocks. None of these records is available to either CPU.
import { COOP, windowBand } from "./cooperative.mjs";

export const KIND = { DAC: 1, GRAB: 2, RELEASE: 3, VINT: 4, DACEN: 5,
  DACBUS: 7, STOP: 8, RESUME: 9, NOTIFY: 10, COPY: 11, POLL: 12, COMMIT: 13,
  HINT: 14, MARK: 15, MARKW: 16, Z80VDP: 17, Z80RAM: 18, HOSTW: 19,
  // Every YM2612 access, by the CPU that made it (R24 §55.3). The window a
  // 68000 FM transaction has to fit in is the gap between the Z80's OWN
  // accesses, and until R24 the instrument saw only the $2A data write.
  YMZ80: 20, YM68K: 21,
  // Every PSG write, by the CPU that made it (R25 §57.3). The PSG is in the
  // VDP's address space, so the 68000 reaches it with no BUSREQ at all — kept
  // apart from the YM records so the two judgments never share a row.
  PSGZ80: 22, PSG68K: 23 };
/** One YM access as the instrument saw it: which port, read or write, byte. */
export const ymAccess = (e) => ({ time: e.time, port: (e.value >>> 14) & 3,
  read: !!(e.value & 0x2000), byte: e.value & 0xff,
  // Port 0/2 are the ADDRESS halves and 1/3 the DATA halves; part 0 is
  // channels 1-3 and part 1 channels 4-6.
  kind: (e.value >>> 14) & 1 ? "data" : "addr", part: ((e.value >>> 15) & 1) });

export function readProbe(buf) {
  if (buf.length % 8) throw new Error("truncated probe record");
  const events = [];
  for (let i = 0; i < buf.length; i += 8)
    events.push({ kind: buf[i], value: buf.readUInt16LE(i + 2), time: buf.readUInt32LE(i + 4) });
  const of = (kind) => events.filter((e) => e.kind === kind);
  // Events from distinct emulated CPUs need not be in timestamp order.
  // Runs are restricted to < 70 seconds until per-source epoch handling exists.
  const pair = (begin, end) => {
    const pairs = []; let open;
    for (const e of events) {
      if (e.kind === begin) open ??= e.time;
      if (e.kind === end && open !== undefined) {
        pairs.push([open, e.time]); open = undefined;
      }
    }
    return pairs;
  };
  return { events, dac: of(KIND.DACBUS), ym: of(KIND.DAC),
    grabs: pair(KIND.GRAB, KIND.RELEASE), stops: pair(KIND.STOP, KIND.RESUME),
    // Offset 0 is the cooperative window's one-way notification; offsets 1..7
    // are the diagnostic record a decoding build publishes, one field an
    // address, so a missing or repeated field is visible as itself.
    notifications: of(KIND.NOTIFY).filter((e) => (e.value >>> 8) === 0),
    records: of(KIND.NOTIFY).filter((e) => (e.value >>> 8) !== 0)
      .map((e) => ({ time: e.time, field: (e.value >>> 8) - 1, value: e.value & 0xff })),
    // Every Z80 write to the watched globals page, with no cycle spent by the
    // engine to publish it: the instrument watches the RAM (R7 §20.2 B).
    // TWO watched ranges, told apart by bit 7 of the offset byte: the globals
    // page (0..$7f of $1F00) and the 32-byte publication region ($1E40). One
    // event kind, two offset spaces, and a consumer that forgets to say which
    // one it means gets nothing rather than the other one's bytes.
    ramWrites: of(KIND.Z80RAM).map((e) => {
      const a = (e.value >>> 8) & 0xff;
      return { time: e.time, region: a & 0x80 ? "pub" : "glob",
        addr: a & 0x80 ? a & 0x1f : a & 0x7f, value: e.value & 0xff };
    }),
    // The 68000's own writes into the publication region — the host half of the
    // runtime protocol. It reaches Z80 RAM by a different path from the Z80, so
    // the memory-map watch above cannot see these at all.
    hostWrites: of(KIND.HOSTW).map((e) => ({ time: e.time,
      addr: (e.value >>> 8) & 0x1f, value: e.value & 0xff })),
    copies: of(KIND.COPY), polls: of(KIND.POLL),
    ymZ80: of(KIND.YMZ80).map(ymAccess), ym68k: of(KIND.YM68K).map(ymAccess),
    psgZ80: of(KIND.PSGZ80), psg68k: of(KIND.PSG68K),
    commits: of(KIND.COMMIT), hints: of(KIND.HINT), marks: of(KIND.MARK),
    hv: of(KIND.MARKW), z80vdp: of(KIND.Z80VDP) };
}

// Which generation a time belongs to, by the observed notification bracket —
// the one thing here that needs no model at all.
const find = (gens, t) => {
  let lo = 0, hi = gens.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, g = gens[mid];
    if (t < g.notify1) hi = mid - 1;
    else if (t > g.notify0) lo = mid + 1;
    else return g;
  }
  return null;
};

/**
 * The 68000's own timeline (§12.2 A/D): when the VDP raised each horizontal
 * interrupt, when the handler actually got there, and what the load cost.
 * Marks are bus writes with a real price, so this only ever describes a ROM
 * that was BUILT with them.
 */
export const FAULT_MARK = 0x7f, LOAD_TICK_MARK = 6;

                                // instrument failing to describe the run.


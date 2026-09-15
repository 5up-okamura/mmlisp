// TWO TRANSPORTS, PRICED AGAINST THE WRITER THAT ALREADY EXISTS (R27 §61.6-§61.7).
//
//   node drv/experimental/dac-stream/transport.mjs [--frames N] [--score NAME]
//
// The writer emits ten FM writes a lap at ten fixed slot positions, and the
// 68000 reaches Z80 RAM only inside a BUSREQ whose total between two H
// observations may not pass 1,500 master. Everything below is those two
// constraints applied to the semantic corpus, one score at a time.
//
// THERE ARE TWO PIPELINES AND EITHER CAN BE THE ONE THAT BINDS:
//
//   the WIRE    68000 -> Z80 RAM, in bytes, inside somebody's bus grab
//   the WRITER  Z80 RAM -> the chip, in register writes, ten a lap
//
// A voice cache moves work between them: it makes a patch two bytes on the
// wire instead of a hundred and twenty, and it does not make it one chip write
// instead of thirty. So the comparison has to carry both numbers or it will
// choose a transport that cannot deliver a note.
import { NTSC, buildConfig } from "../../engine/config.mjs";
import { MASTER_PER_CYCLE } from "./case-config.mjs";
import { SLOT_SUBS } from "../../../live/src/slot-builder.js";
import { scoreList, recordScore, classify, expand, globalChannel,
  keyChannel, keyIsOn } from "./semantic.mjs";
import { writerPlan, ENTRY_BYTES, PRODUCER_BYTES } from "../../engine/ym-writer.mjs";
import { basename } from "node:path";

// ── What the machine already told us ──────────────────────────────────────
export const MASTER_HZ = NTSC.masterHz;
export const LAP_MASTER = 430080;                 // 80 slots x 5,376 master
export const LAP_HZ = MASTER_HZ / LAP_MASTER;     // 124.84 observations a second
export const STOP_BUDGET = 1500;                  // master, between two H observations

// One byte into Z80 RAM is `move.b (a0)+,(a1)+` — twelve 68000 cycles, at the
// master-clocks-a-cycle the calibration case measures with the display on
// (R20 §48.5). It is the only per-byte cost there is: the bus is already held.
export const WIRE_BYTE_MASTER = 12 * MASTER_PER_CYCLE;

// The mailbox's own two grabs, WORST CASE, from the 60-second run of R26 §60.5:
// a snapshot read is 440..926 master for six bytes and a publish 830..1,432 for
// six bytes plus the ack, the live counter and the choice. One grab a lap,
// alternating, so nearly every observation already carries one.
export const MAILBOX_READ_WORST = 926, MAILBOX_READ_BEST = 440;
export const MAILBOX_PUBLISH_WORST = 1432, MAILBOX_PUBLISH_BEST = 830;
export const MAILBOX_BYTES = 6;
// …and therefore what a grab costs BEFORE its payload: the read's worst less
// its six bytes. A transport that takes its own grab pays this again.
export const GRAB_FIXED_MASTER = MAILBOX_READ_WORST - MAILBOX_BYTES * WIRE_BYTE_MASTER;

/**
 * HOW MANY WIRE BYTES AN OBSERVATION CAN CARRY.
 *
 * Riding an existing grab costs nothing but the bytes; taking a new one pays
 * the fixed cost again, which at 403 master is most of what is left. Both are
 * computed, because "ride the read" is a design decision and not an assumption
 * — R24 §55 already found it was the only host-YM arrangement that fitted.
 */
// …and the arrangement R25 §57 already measured but did not use: the whole
// handshake — the ack, the live counter, the payload and the commit — in ONE
// grab of 373..1,354 master, at one transfer an observation. It costs the
// mailbox nothing (124.8 updates a second is more than the 60 asked for) and it
// frees the OTHER lap completely, which is where a YM transport can take a grab
// of its own instead of riding somebody else's leftovers.
export const MAILBOX_MERGED_WORST = 1354, MAILBOX_MERGED_BEST = 373;

export function wireBudget(mode = "worst") {
  const ride = (used) => Math.max(0, Math.floor((STOP_BUDGET - used) / WIRE_BYTE_MASTER));
  const own = (used) => Math.max(0,
    Math.floor((STOP_BUDGET - used - GRAB_FIXED_MASTER) / WIRE_BYTE_MASTER));
  if (mode === "merged") {
    // One lap carries the merged handshake and the next carries nothing at all.
    const a = { ride: ride(MAILBOX_MERGED_WORST), own: own(MAILBOX_MERGED_WORST) };
    const b = { ride: own(0), own: own(0) };
    return { mode, readLap: a, pubLap: b, perLap: (a.ride + b.own) / 2,
      perSec: ((a.ride + b.own) / 2) * LAP_HZ,
      byteMaster: WIRE_BYTE_MASTER, fixed: GRAB_FIXED_MASTER };
  }
  const worst = mode === "worst";
  const read = worst ? MAILBOX_READ_WORST : MAILBOX_READ_BEST;
  const pub = worst ? MAILBOX_PUBLISH_WORST : MAILBOX_PUBLISH_BEST;
  const readLap = { ride: ride(read), own: own(read) };
  const pubLap = { ride: ride(pub), own: own(pub) };
  // The two alternate, so a pair of laps carries the sum of them.
  const perLap = (readLap.ride + pubLap.ride) / 2;
  return { mode, readLap, pubLap, perLap, perSec: perLap * LAP_HZ,
    byteMaster: WIRE_BYTE_MASTER, fixed: GRAB_FIXED_MASTER };
}

// ── The two candidates ────────────────────────────────────────────────────
//
// `raw` is the baseline §61.6 asks to be measured rather than assumed away: the
// producer fills the writer's own entries, four producer-owned bytes a write.
//
// `semantic` sends the five commands. The header packs the opcode, the channel
// and the operator/port, so a command is two or three bytes; a VOICE_SET is a
// header and a voice number once the body is cached, and the body itself the
// first time — thirty values, since the register sequence of a patch is fixed
// and the Z80 holds it as code rather than data.
export const VOICE_BODY_WRITES = 30;
export const VOICE_BODY_BYTES = VOICE_BODY_WRITES;    // values only; regs are implied
//
// AND THE Z80 PAYS FOR EVERY BYTE THE PRODUCER DOES NOT WRITE. An entry's four
// producer-owned bytes have to arrive somehow: either the 68000 writes them
// inside its grab, or the Z80 builds them out of a command — a fetch and a
// store each, and neither register file has anything spare, so both are
// absolute and self-modified. That is 26 cycles a byte and it is charged here
// rather than left at zero (§61.7).
export const EXPAND_BYTE_CYCLES = 13 + 13;             // ld a,(nn) + ld (nn),a
export const EXPAND_DECODE_CYCLES = 40;                // the header, per command

export const CANDIDATES = {
  raw: {
    name: "raw baseline — the producer fills the writer's entries",
    wire: (c, st) => PRODUCER_BYTES.length * rawWrites(c, st),
    expand: () => 0,
    cache: false,
  },
  hybrid: {
    // The producer writes entries for everything that is not a patch, and only
    // a voice body is expanded from the cache. The wire pays four bytes a write
    // for the steady traffic and the Z80 pays nothing for it.
    name: "hybrid — raw entries, cached patches",
    wire: (c, st) => (c.op === "VOICE_SET"
      ? (st.cached.has(c.voice) ? 2 : 2 + VOICE_BODY_BYTES)
      : PRODUCER_BYTES.length * rawWrites(c, st)),
    expand: (c, st) => (c.op === "VOICE_SET"
      ? EXPAND_DECODE_CYCLES + rawWrites(c, st) * PRODUCER_BYTES.length * EXPAND_BYTE_CYCLES : 0),
    cache: true,
  },
  semantic: {
    name: "semantic + patch prefetch/cache",
    wire: (c, st) => {
      if (c.op === "VOICE_SET") return st.cached.has(c.voice) ? 2 : 2 + VOICE_BODY_BYTES;
      if (c.op === "PITCH") return 3;
      if (c.op === "TL") return 2;
      if (c.op === "KEY") return 2;
      return 3;                                      // RAW_GLOBAL: header, reg, value
    },
    expand: (c, st) => EXPAND_DECODE_CYCLES
      + rawWrites(c, st) * PRODUCER_BYTES.length * EXPAND_BYTE_CYCLES,
    cache: true,
  },
};

/** The CHIP writes a command costs, which no transport can reduce. */
export function rawWrites(c, st) {
  if (c.op === "VOICE_SET") return st.bodies.get(c.voice) ?? VOICE_BODY_WRITES;
  if (c.op === "PITCH") return 2;
  return 1;
}

/**
 * The ten site times inside a lap, in master clocks from the top of it — taken
 * from the laid-out schedule, not from the slot numbers, because the slots are
 * 358 and 359 cycles alternately and a site's place inside the lap is what the
 * latency is measured against.
 */
export function siteTimes(cfg, plan) {
  const start = [];
  let t = 0;
  for (let i = 0; i < cfg.cycleSlots; i++) {
    start.push(t);
    t += cfg.slotCycles[i % cfg.groupSlots];
  }
  // A site's write lands after the slot's DAC write and the mixer — measured in
  // R26 §60.5 at 244 Z80 cycles into the slot, which is where the BUSY window
  // put it.
  const INTO_SLOT = 244;
  return plan.at.map((i) => (start[i] + INTO_SLOT) * NTSC.z80Div);
}

/**
 * ONE SCORE THROUGH ONE CANDIDATE (R27 §61.7).
 *
 * Two FIFOs in series, stepped a lap at a time. The wire delivers whatever its
 * budget allows into a delivered queue; the writer takes ten writes a lap out
 * of it. Order is preserved by construction — which is the point of a FIFO, and
 * why the counts §61.7 asks for (out of order, duplicated, lost) are zero here
 * and the number that is NOT zero is the delay.
 *
 * `prefetch` moves a VOICE_SET's request time earlier when the channel is not
 * sounding and the score gives it room — §61.4 allows exactly that and nothing
 * else, so the amount moved is bounded by the lead the score really had.
 */
export function simulate(score, candidate, { sites, prefetch = false, cacheSlots = 6,
  mode = "worst", capOverride = null }) {
  const cand = CANDIDATES[candidate];
  const { commands, voices } = classify(score.writes.filter((w) => w.port < 2));
  const bodies = new Map();
  for (const [, v] of voices) bodies.set(v.id, v.body.length);
  const st = { cached: new Set(), bodies };
  const frameMaster = NTSC.frameMaster;
  const budget = wireBudget(mode);

  // The request time of each command, and the prefetch rule.
  const on = new Array(6).fill(false);
  const reqs = commands.map((c) => {
    const t = (c.frame + c.sub / SLOT_SUBS) * frameMaster;
    return { c, ref: t, req: t };
  });
  if (prefetch) {
    // A patch may be moved earlier only over a stretch in which its channel is
    // silent. The stretch is found from the KEY stream, so the amount moved is
    // the lead the score really had and never an invention.
    const keyOff = new Map();                     // channel -> when it last went quiet
    for (const r of reqs) {
      const c = r.c;
      if (c.op === "KEY") {
        const ch = keyChannel(c.value);
        if (keyIsOn(c.value)) on[ch] = true;
        else { on[ch] = false; keyOff.set(ch, r.ref); }
        continue;
      }
      if (c.op !== "VOICE_SET") continue;
      const ch = globalChannel(c.port, c.channel);
      if (on[ch]) continue;                       // an ACTIVE change may not move
      r.req = keyOff.has(ch) ? keyOff.get(ch) : 0;
    }
    // Moving a request earlier may not reorder the stream: the wire is a FIFO.
    for (let i = 1; i < reqs.length; i++)
      if (reqs[i].req < reqs[i - 1].req) reqs[i].req = reqs[i - 1].req;
  }

  // Each command's wire cost and chip cost, in request order.
  const q = reqs.map((r) => {
    const wire = cand.wire(r.c, st);
    const expand = cand.expand(r.c, st);
    if (cand.cache && r.c.op === "VOICE_SET") st.cached.add(r.c.voice);
    return { ...r, wire, expand, writes: rawWrites(r.c, st), hit: null };
  });
  // The cache, replayed properly: LRU over `cacheSlots`, so a miss is a miss
  // and the wire pays the body again.
  if (cand.cache) {
    const lru = [];
    let hits = 0, misses = 0;
    for (const e of q) {
      if (e.c.op !== "VOICE_SET") continue;
      const at = lru.indexOf(e.c.voice);
      if (at >= 0) { lru.splice(at, 1); hits++; e.hit = true; e.wire = 2; }
      else { misses++; e.hit = false; e.wire = 2 + VOICE_BODY_BYTES; }
      lru.push(e.c.voice);
      if (lru.length > cacheSlots) lru.shift();
    }
    st.hits = hits; st.misses = misses;
  }

  const laps = Math.ceil(((score.frames + 1) * frameMaster) / LAP_MASTER) + 4000;
  let i = 0;                                     // next command to admit to the wire
  let owed = 0;                                  // bytes still owed for q[wireAt]
  let wireAt = 0;                                // the command the wire is paying for
  const delivered = [];                          // {e, writesLeft}
  let drained = null;                            // when the cold start finished
  const wireBacklog = [], writerBacklog = [];
  let maxWireBytes = 0;
  const done = [];
  for (let L = 0; L < laps; L++) {
    const t0 = L * LAP_MASTER, t1 = t0 + LAP_MASTER;
    while (i < q.length && q[i].req < t1) i++;    // requests are visible this lap
    // WIRE. Six bytes in the lap that carries a snapshot read, none in the one
    // that carries a publication.
    let cap = capOverride !== null ? capOverride
      : (L % 2 === 0) ? budget.readLap.ride
      : (budget.mode === "merged" ? budget.pubLap.own : budget.pubLap.ride);
    while (cap > 0 && wireAt < i) {
      if (owed === 0) owed = q[wireAt].wire;
      const take = Math.min(cap, owed);
      cap -= take; owed -= take;
      if (owed === 0) {
        q[wireAt].deliveredAt = t1;
        delivered.push({ e: q[wireAt], left: q[wireAt].writes });
        wireAt++;
      }
    }
    let pending = 0;
    for (let k = wireAt; k < i; k++) pending += q[k].wire;
    pending += owed;
    maxWireBytes = Math.max(maxWireBytes, pending);
    wireBacklog.push(pending);
    // WRITER. Ten sites, and a site emits one write.
    let left = sites.length;
    let s = 0;
    while (left > 0 && delivered.length) {
      const head = delivered[0];
      head.left--; left--;
      const at = t0 + sites[s % sites.length];
      s++;
      if (head.left === 0) { head.e.doneAt = at; done.push(head.e); delivered.shift(); }
    }
    writerBacklog.push(delivered.reduce((t, d) => t + d.left, 0));
    // WHEN THE COLD START IS OVER: the first moment both pipelines are empty.
    // Every score in the corpus loads all six channels in its first frame, and
    // 180 chip writes at ten a lap is 144 ms whatever the wire does — so the
    // steady figures are measured from here and the cold start is reported as
    // its own number (§61.7).
    if (drained === null && !delivered.length && owed === 0 && wireAt > 0
      && q[wireAt - 1].c.frame >= 1) drained = t1;
    if (wireAt >= q.length && !delivered.length && i >= q.length) break;
  }
  const undone = q.filter((e) => e.doneAt === undefined);
  const lat = done.map((e) => e.doneAt - e.ref);
  const keyLat = done.filter((e) => e.c.op === "KEY").map((e) => e.doneAt - e.ref);
  // …AND THE SAME WITHOUT THE PROLOGUE. Every score in the corpus loads all six
  // channels in its first frame, and a product loads those before it starts, so
  // a delay that belongs to the cold start is reported apart from one that
  // happens while the music is running (§61.7).
  const steadyDone = done.filter((e) => e.ref > (drained ?? 0));
  const steadyLat = steadyDone.map((e) => e.doneAt - e.ref);
  const steadyKey = steadyDone.filter((e) => e.c.op === "KEY").map((e) => e.doneAt - e.ref);
  const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[
    Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);
  const secs = score.frames / 60;
  const wireTotal = q.reduce((t, e) => t + e.wire, 0);
  // THE FIRST TWO FRAMES ARE THE SCORE'S PROLOGUE, and every score in the
  // corpus loads all six channels there. A product loads those before it
  // starts; a transport is sized for what comes after, so the two are reported
  // apart rather than averaged into one rate nobody can act on.
  const steadyCmds = q.filter((e) => e.ref > (drained ?? 0));
  const steadyWire = steadyCmds.reduce((t, e) => t + e.wire, 0);
  const steadySecs = Math.max(1 / 60,
    (score.frames * NTSC.frameMaster - (drained ?? 0)) / MASTER_HZ);
  return { name: score.name, candidate, commands: q.length, undone: undone.length,
    wireTotal, wirePerSec: wireTotal / secs,
    // What the Z80 spends turning commands into entries, per LAP — the number
    // that has to come out of the schedule and is in nobody's reservation.
    expandPerLap: (q.reduce((t, e) => t + e.expand, 0) / secs) / LAP_HZ,
    steadyExpandPerLap: (steadyCmds.reduce((t, e) => t + e.expand, 0) / steadySecs) / LAP_HZ,
    steadyWirePerSec: steadyWire / steadySecs,
    steadyWritesPerSec: steadyCmds.reduce((t, e) => t + e.writes, 0) / steadySecs,
    chipWrites: q.reduce((t, e) => t + e.writes, 0),
    hits: st.hits ?? null, misses: st.misses ?? null,
    wireBacklogMax: maxWireBytes, wireBacklogP95: pct(wireBacklog, 0.95),
    writerBacklogMax: Math.max(0, ...writerBacklog), writerBacklogP95: pct(writerBacklog, 0.95),
    latMax: Math.max(0, ...lat), latP95: pct(lat, 0.95), latMed: pct(lat, 0.5),
    keyMax: Math.max(0, ...keyLat), keyP95: pct(keyLat, 0.95), keyMed: pct(keyLat, 0.5),
    keys: keyLat.length,
    steadyLatMax: Math.max(0, ...steadyLat), steadyLatP95: pct(steadyLat, 0.95),
    steadyKeyMax: Math.max(0, ...steadyKey), steadyKeyP95: pct(steadyKey, 0.95),
    steadyKeys: steadyKey.length,
    // A frame is one 60 Hz tick; a command later than that has missed the
    // frame the reference driver put it in.
    lateFrames: steadyLat.filter((x) => x > NTSC.frameMaster).length,
    lateKeys: steadyKey.filter((x) => x > NTSC.frameMaster).length,
    // Does the backlog come back to zero, or does the score outrun the wire?
    coldMaster: drained ?? 0, endsClear: undone.length === 0,
    tailBacklog: wireBacklog.at(-1) ?? 0 };
}

// ── The comparison ────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const FRAMES = Number(arg("frames", 400));
  const ONLY = arg("score", null);
  const SLOTS = Number(arg("cache", 6));
  const cfg = buildConfig({ voices: 2, complete: true, csm: true, csmHost: true,
    levels: 15, workTarget: 0.839, correctorBudget: true, command: true, ymWriter: true });
  const plan = writerPlan(cfg, { sites: 10, base: 0x1e00 - 10 * ENTRY_BYTES });
  const sites = siteTimes(cfg, plan);
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  const ms = (m) => (m / (MASTER_HZ / 1000)).toFixed(1);

  const bw = wireBudget("worst"), bb = wireBudget("best"), bm = wireBudget("merged");
  console.log("── what the bus leaves for a YM transport ──");
  console.log(`  one byte into Z80 RAM costs ${WIRE_BYTE_MASTER.toFixed(1)} master`
    + ` (move.b (a0)+,(a1)+, 12 cycles at ${MASTER_PER_CYCLE.toFixed(3)} master a cycle),`
    + `\n  and a grab of its own costs ${GRAB_FIXED_MASTER.toFixed(0)} master before any of them.`);
  console.log(`  The mailbox already takes one grab a lap, alternating:`
    + ` a read (${MAILBOX_READ_BEST}..${MAILBOX_READ_WORST} master)`
    + ` and a publication (${MAILBOX_PUBLISH_BEST}..${MAILBOX_PUBLISH_WORST}).`);
  for (const b of [bw, bb])
    console.log(`  ${b.mode === "worst" ? "worst-case grabs" : " best-case grabs"}:`
      + ` riding them carries ${b.readLap.ride} B in a read lap and ${b.pubLap.ride} in a`
      + ` publish lap = ${b.perLap} B a lap = ${num(b.perSec.toFixed(0), 5)} B/s`
      + ` (its own grab: ${b.readLap.own} and ${b.pubLap.own})`);
  console.log(`  MERGED handshake (R25 §57, one grab an observation, ${MAILBOX_MERGED_BEST}`
    + `..${MAILBOX_MERGED_WORST} master): ${bm.readLap.ride} B riding it and`
    + ` ${bm.pubLap.own} B in a grab of its own in the free lap`
    + ` = ${bm.perLap} B a lap = ${bm.perSec.toFixed(0)} B/s`);
  console.log(`  The writer takes ${sites.length} of them out to the chip every lap`
    + ` = ${(sites.length * LAP_HZ).toFixed(1)} register writes a second.`);

  const list = scoreList().filter((s) => !ONLY || basename(s).includes(ONLY));
  const scores = list.map((s) => recordScore(s, FRAMES));
  const runs = [];
  for (const [kind, mode, pf] of [["raw", "worst", false], ["raw", "merged", false],
    ["hybrid", "merged", false],
    ["semantic", "worst", false], ["semantic", "merged", false], ["semantic", "merged", true]])
    runs.push({ kind, pf, mode, rows: scores.map((s) =>
      simulate(s, kind, { sites, prefetch: pf, cacheSlots: SLOTS, mode })) });

  console.log(`\n── the wire each candidate needs, against ${bw.perSec.toFixed(0)}`
    + `..${bb.perSec.toFixed(0)} B/s ──`);
  console.log(`  ${pad("candidate", 34)}${num("B/s med", 9)}${num("B/s max", 9)}`
    + `${num("steady med", 12)}${num("steady max", 12)}${num("over worst", 12)}${num("over best", 11)}`);
  for (const r of runs) {
    const all = r.rows.map((x) => x.wirePerSec).sort((a, b) => a - b);
    const st = r.rows.map((x) => x.steadyWirePerSec).sort((a, b) => a - b);
    const overW = r.rows.filter((x) => x.steadyWirePerSec > bw.perSec).length;
    const overB = r.rows.filter((x) => x.steadyWirePerSec > bb.perSec).length;
    console.log(`  ${pad(`${r.kind}${r.pf ? "+pf" : ""} · ${r.mode}`, 34)}`
      + `${num(all[all.length >> 1].toFixed(0), 9)}${num(all.at(-1).toFixed(0), 9)}`
      + `${num(st[st.length >> 1].toFixed(0), 12)}${num(st.at(-1).toFixed(0), 12)}`
      + `${num(`${overW}/${r.rows.length}`, 12)}${num(`${overB}/${r.rows.length}`, 11)}`);
  }

  console.log(`\n── and what that does to the delivery, in ms ──`);
  console.log(`  ${pad("candidate", 34)}${num("lat med", 9)}${num("lat p95", 9)}${num("lat max", 9)}`
    + `${num("key med", 9)}${num("key max", 9)}${num("wire max B", 12)}${num("writer max", 11)}`);
  for (const r of runs) {
    const g = (f) => Math.max(...r.rows.map(f));
    const med = [...r.rows.map((x) => x.latMed)].sort((a, b) => a - b);
    console.log(`  ${pad(`${r.kind}${r.pf ? "+pf" : ""} · ${r.mode}`, 34)}`
      + `${num(ms(med[med.length >> 1]), 9)}${num(ms(g((x) => x.latP95)), 9)}`
      + `${num(ms(g((x) => x.latMax)), 9)}`
      + `${num(ms(g((x) => x.keyMed)), 9)}${num(ms(g((x) => x.keyMax)), 9)}`
      + `${num(g((x) => x.wireBacklogMax), 12)}${num(g((x) => x.writerBacklogMax), 11)}`);
  }
  console.log("  lat = a command's reference time to its last chip write; key = the same for"
    + " a key-on.\n  Every figure is the WORST score of the corpus except the medians.");

  console.log(`\n── with the prologue taken out, and what the Z80 owes for it ──`);
  console.log(`  ${pad("candidate", 24)}${num("cold ms", 9)}${num("lat p95", 9)}${num("lat max", 9)}`
    + `${num("key max", 9)}${num("late cmds", 11)}${num("late keys", 11)}`
    + `${num("expand cyc/lap", 16)}${num("of the free", 12)}`);
  // The ten b11..b14 opportunities the writer does NOT use are what an expander
  // would have to live in — 93 cycles each at the ceiling, measured in §60.
  const FREE_OPPORTUNITIES = 20 - sites.length, ROOM = 93;
  for (const r of runs) {
    const g = (f) => Math.max(...r.rows.map(f));
    const exp = g((x) => x.steadyExpandPerLap);
    console.log(`  ${pad(`${r.kind}${r.pf ? "+pf" : ""} · ${r.mode}`, 24)}`
      + `${num(ms(g((x) => x.coldMaster)), 9)}`
      + `${num(ms(g((x) => x.steadyLatP95)), 9)}${num(ms(g((x) => x.steadyLatMax)), 9)}`
      + `${num(ms(g((x) => x.steadyKeyMax)), 9)}`
      + `${num(r.rows.reduce((t, x) => t + x.lateFrames, 0), 11)}`
      + `${num(r.rows.reduce((t, x) => t + x.lateKeys, 0), 11)}`
      + `${num(exp.toFixed(0), 16)}`
      + `${num(`${(100 * exp / (FREE_OPPORTUNITIES * ROOM)).toFixed(0)}%`, 12)}`);
  }
  console.log(`\n── what would be enough, per lap, searched rather than assumed ──`);
  console.log(`  ${pad("candidate", 24)}${num("keys on time", 14)}${num("all on time", 14)}`
    + `${num("has", 6)}${num("short by", 10)}`);
  for (const r of runs) {
    if (r.mode !== "merged") continue;
    const need = (w) => Math.max(...scores.map((s) =>
      neededPerLap(s, r.kind, { sites, prefetch: r.pf, cacheSlots: SLOTS, mode: r.mode }, w) ?? 999));
    const keys = need("lateKeys"), all = need("lateFrames");
    const has = bm.perLap;
    console.log(`  ${pad(`${r.kind}${r.pf ? "+pf" : ""} · ${r.mode}`, 24)}`
      + `${num(`${keys} B`, 14)}${num(`${all} B`, 14)}${num(`${has} B`, 6)}`
      + `${num(`${(all / has).toFixed(1)}x`, 10)}`);
  }
  console.log(`  The merged handshake leaves ${bm.perLap} B a lap`
    + ` (${bm.perSec.toFixed(0)} B/s). 999 means "not at 256 B a lap either" — the wire is`
    + `\n  not what is short.`);

  console.log(`\n── the writer, with the wire taken out of the way ──`);
  const semRun = { kind: "semantic", pf: true, mode: "merged" };
  const perScore = scores.map((s) => ({ name: s.name,
    keys: sitesNeeded(s, semRun.kind, { sites, prefetch: true, cacheSlots: SLOTS,
      mode: "merged" }, "lateKeys"),
    all: sitesNeeded(s, semRun.kind, { sites, prefetch: true, cacheSlots: SLOTS,
      mode: "merged" }, "lateFrames") }));
  const worstK = perScore.reduce((a, b) => ((b.keys ?? 0) > (a.keys ?? 0) ? b : a));
  const worstA = perScore.reduce((a, b) => ((b.all ?? 0) > (a.all ?? 0) ? b : a));
  console.log(`  sites a lap for every key-on on time: ${worstK.keys}`
    + ` (worst score "${worstK.name}"), against the ${sites.length} the writer has`
    + ` — ${(worstK.keys / sites.length).toFixed(1)}x`);
  console.log(`  sites a lap for EVERY command on time: ${worstA.all}`
    + ` (worst score "${worstA.name}") — ${(worstA.all / sites.length).toFixed(1)}x`);
  console.log(`  At ${sites.length} sites a write is ${(1000 / (sites.length * LAP_HZ)).toFixed(2)} ms`
    + ` apart, and a frame is ${(sites.length * LAP_HZ / 60).toFixed(1)} of them; the reference`
    + `\n  driver's own cap is ${95} writes a frame (slot-builder.js SLOT_MAX_WRITES), which is`
    + ` ${(95 / (sites.length * LAP_HZ / 60)).toFixed(1)}x what the writer can take out.`);

  console.log(`  late = commands (and key-ons) that missed the 60 Hz frame the reference`
    + ` driver put them in.\n  expand = what the Z80 spends building entries out of commands,`
    + ` against the ${FREE_OPPORTUNITIES * ROOM} cycles a lap\n  the ${FREE_OPPORTUNITIES}`
    + ` unused b11..b14 opportunities hold at the ceiling — which is where it would have to go,`
    + `\n  and which is why those opportunities can never also become write sites.`);

  console.log(`\n── the twelve worst scores for the semantic candidate ──`);
  const sem = runs.find((r) => r.kind === "semantic" && r.pf && r.mode === "merged");
  const worst = [...sem.rows].sort((a, b) => b.steadyWirePerSec - a.steadyWirePerSec).slice(0, 12);
  console.log(`  ${pad("score", 22)}${num("wire B/s", 10)}${num("steady", 9)}`
    + `${num("writes/s", 10)}${num("hits", 6)}${num("miss", 6)}${num("lat max", 9)}${num("key max", 9)}`);
  for (const x of worst)
    console.log(`  ${pad(x.name, 22)}${num(x.wirePerSec.toFixed(0), 10)}`
      + `${num(x.steadyWirePerSec.toFixed(0), 9)}${num(x.steadyWritesPerSec.toFixed(0), 10)}`
      + `${num(x.hits, 6)}${num(x.misses, 6)}${num(ms(x.latMax), 9)}${num(ms(x.keyMax), 9)}`);
  const rawRun = runs.find((r) => r.kind === "raw");
  console.log(`\n  raw, for comparison: worst score needs`
    + ` ${Math.max(...rawRun.rows.map((x) => x.steadyWirePerSec)).toFixed(0)} B/s steady`
    + ` and its worst key-on lands`
    + ` ${ms(Math.max(...rawRun.rows.map((x) => x.keyMax)))} ms late.`);
  console.log(`  cache: ${SLOTS} slots x ${VOICE_BODY_BYTES} B = ${SLOTS * VOICE_BODY_BYTES} B`
    + ` of Z80 RAM, plus the expander's code.`);
}

/**
 * HOW MANY WIRE BYTES A LAP WOULD BE ENOUGH — the number §61.7 asks for when
 * nothing fits: not "it does not work" but which resource is short and by how
 * much. Searched rather than solved, because the answer depends on where the
 * bursts fall and not only on the average.
 */
export function neededPerLap(score, candidate, opts, want = "lateKeys") {
  let lo = 1, hi = 256;
  const ok = (cap) => {
    const r = simulate(score, candidate, { ...opts, capOverride: cap });
    return r[want] === 0;
  };
  if (!ok(hi)) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/**
 * …AND HOW MANY WRITE OPPORTUNITIES A LAP WOULD BE ENOUGH, with the wire taken
 * out of the way. The two searches together say which of the two pipelines is
 * the one that is short — and for this corpus it is not the one that looked
 * short (§61.7).
 */
export function sitesNeeded(score, candidate, opts, want = "lateKeys", max = 400) {
  const spread = (n) => Array.from({ length: n }, (_, k) => (k * LAP_MASTER) / n);
  let lo = 1, hi = max;
  const ok = (n) => simulate(score, candidate,
    { ...opts, sites: spread(n), capOverride: 1e9 })[want] === 0;
  if (!ok(hi)) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

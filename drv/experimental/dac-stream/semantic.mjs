// WHAT THE 41 SCORES MEAN, not just how many bytes they are (R27 §61.5).
//
//   node drv/experimental/dac-stream/semantic.mjs [--frames N] [--score NAME]
//
// R25 §57.4 counted the reference driver's FM traffic and R26 priced the
// writer that has to emit it. Neither says what a TRANSPORT would carry,
// because a transport does not carry writes — it carries intentions, and a
// voice patch is one intention worth thirty of them. So the raw stream is
// folded into five semantic commands and the fold is checked by UNFOLDING it
// again and comparing byte for byte against the original.
//
// THE TWO DIRECTIONS ARE TWO FUNCTIONS. `classify()` goes raw -> semantic and
// `expand()` goes semantic -> raw, and neither calls the other; the reference
// the comparison uses is the driver's own output. §61.5 asks for exactly that:
// a check whose expectation does not come from the thing being checked.
//
// The five commands:
//
//   VOICE_SET(port, channel, voice)   a whole patch, folded to an IDENTITY —
//                                     the register/value list itself, with the
//                                     channel taken out of the register
//                                     numbers, so the same patch on channel 1
//                                     and channel 5 is one voice
//   PITCH(port, channel, hi, lo)      the $A4/$A0 pair, in that order, because
//                                     the high byte is latched and the low one
//                                     commits it
//   TL(port, channel, operator, v)    a level that moves at runtime
//   KEY(value)                        $28, the only write that starts a note
//   RAW_GLOBAL(port, reg, value)      everything else, kept rather than dropped
import { readFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "../../tools/mmb-build.mjs";
import { DrvPlayer } from "../../../live/src/drv-player.js";
import { SlotBuilder } from "../../../live/src/slot-builder.js";

const here = dirname(fileURLToPath(import.meta.url));
const drv = join(here, "..", "..");

/**
 * THE 41 SCORES, from the one place that names them (§61.5).
 *
 * `c-gate` is the gate that compares the C port against the reference driver,
 * and its argument list in package.json is where the corpus is defined. Reading
 * it rather than copying it is what stops the two drifting: a score added to
 * the gate is a score this measures, without anyone remembering to.
 */
export function scoreList() {
  const pkg = JSON.parse(readFileSync(join(drv, "package.json"), "utf8"));
  const line = pkg.scripts["c-gate"];
  if (!line) throw new Error("package.json has no c-gate script to take the corpus from");
  const names = line.split(/\s+/).filter((a) => a.endsWith(".mmlisp"));
  if (!names.length) throw new Error("the c-gate script names no scores");
  return names.map((n) => join(drv, n));
}

// ── The register map, once ────────────────────────────────────────────────
// Operator registers are $30..$9F: the low nibble is `op*4 + channel`, where
// channel is 0..2 WITHIN the port. Channel registers are $A0..$B6. Everything
// else on port 0 is a global.
export const OPBASE = [0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90];
const isOp = (r) => r >= 0x30 && r < 0xa0 && (r & 3) !== 3;
const opChannel = (r) => r & 3;
const opNumber = (r) => (r >> 2) & 3;
const isTL = (r) => r >= 0x40 && r < 0x50;
const isAlgPan = (r) => r >= 0xb0 && r < 0xb8 && (r & 3) !== 3;
const algChannel = (r) => r & 3;
const isPitchHi = (r) => (r >= 0xa4 && r < 0xa8) || (r >= 0xac && r < 0xb0);
const isPitchLo = (r) => (r >= 0xa0 && r < 0xa4) || (r >= 0xa8 && r < 0xac);
const pitchChannel = (r) => r & 3;
/** The channel a per-channel register belongs to, or null for a global. */
export function channelOf(reg) {
  if (isOp(reg)) return opChannel(reg);
  if (isAlgPan(reg)) return algChannel(reg);
  if (isPitchHi(reg) || isPitchLo(reg)) return pitchChannel(reg) & 3;
  return null;
}
/** Is this register part of a voice PATCH (as against a runtime control)? */
const isPatch = (r) => isOp(r) || isAlgPan(r);

// A real patch is 30 writes — algorithm, pan, and seven registers for each of
// four operators. A shorter run of the same registers is an edit, not a load,
// and it stays as its own commands.
export const VOICE_MIN = 16;

/**
 * Raw writes -> semantic commands.
 *
 * @param writes {frame, sub, port, addr, data} in emission order
 * @returns {commands, voices} — `voices` maps an identity key to its body
 */
export function classify(writes) {
  const commands = [];
  const voices = new Map();          // key -> {id, body:[[relReg, value]]}
  let pending = null;                // a pitch high waiting for its low
  const flush = () => {
    if (!pending) return;
    commands.push({ op: "RAW_GLOBAL", frame: pending.frame, sub: pending.sub,
      port: pending.port, reg: pending.addr, value: pending.data });
    pending = null;
  };
  for (let i = 0; i < writes.length; i++) {
    const w = writes[i];
    if (w.port !== 0 && w.port !== 1) continue;      // the PSG is not this corpus
    // A PATCH: the longest run of consecutive writes, on one port, all of them
    // patch registers of ONE channel.
    if (isPatch(w.addr)) {
      const ch = channelOf(w.addr);
      let j = i;
      while (j < writes.length && writes[j].port === w.port && isPatch(writes[j].addr)
        && channelOf(writes[j].addr) === ch) j++;
      if (j - i >= VOICE_MIN) {
        flush();
        const body = writes.slice(i, j).map((x) => [x.addr - ch, x.data]);
        const key = body.map(([r, v]) => `${r.toString(16)}:${v.toString(16)}`).join(",");
        if (!voices.has(key)) voices.set(key, { id: voices.size, body });
        commands.push({ op: "VOICE_SET", frame: w.frame, sub: w.sub, port: w.port,
          channel: ch, voice: voices.get(key).id, key, writes: j - i });
        i = j - 1;
        continue;
      }
    }
    if (w.port === 0 && w.addr === 0x28) {
      flush();
      commands.push({ op: "KEY", frame: w.frame, sub: w.sub, value: w.data });
      continue;
    }
    if (isTL(w.addr)) {
      flush();
      commands.push({ op: "TL", frame: w.frame, sub: w.sub, port: w.port,
        channel: opChannel(w.addr), operator: opNumber(w.addr), value: w.data });
      continue;
    }
    if (isPitchHi(w.addr)) { flush(); pending = w; continue; }
    if (isPitchLo(w.addr) && pending && pending.port === w.port
      && pending.addr === w.addr + 4) {
      commands.push({ op: "PITCH", frame: pending.frame, sub: pending.sub, port: w.port,
        channel: pitchChannel(w.addr), reg: w.addr, hi: pending.data, lo: w.data });
      pending = null;
      continue;
    }
    flush();
    commands.push({ op: "RAW_GLOBAL", frame: w.frame, sub: w.sub, port: w.port,
      reg: w.addr, value: w.data });
  }
  flush();
  return { commands, voices };
}

/**
 * Semantic commands -> raw writes. WRITTEN SEPARATELY from `classify`, on
 * purpose: this is the half that makes the fold checkable, and a fold checked
 * against its own inverse-by-construction checks nothing.
 */
export function expand(commands, voices) {
  const bodies = new Map();
  for (const [, v] of voices) bodies.set(v.id, v.body);
  const out = [];
  const put = (c, port, addr, data) =>
    out.push({ frame: c.frame, sub: c.sub, port, addr, data });
  for (const c of commands) {
    if (c.op === "VOICE_SET") {
      const body = bodies.get(c.voice);
      if (!body) throw new Error(`voice ${c.voice} has no body`);
      for (const [rel, value] of body) put(c, c.port, rel + c.channel, value);
    } else if (c.op === "PITCH") {
      put(c, c.port, c.reg + 4, c.hi);
      put(c, c.port, c.reg, c.lo);
    } else if (c.op === "TL") {
      put(c, c.port, 0x40 + c.operator * 4 + c.channel, c.value);
    } else if (c.op === "KEY") {
      put(c, 0, 0x28, c.value);
    } else if (c.op === "RAW_GLOBAL") {
      put(c, c.port, c.reg, c.value);
    } else throw new Error(`unknown command ${c.op}`);
  }
  return out;
}

// ── Reading a score off the reference driver ──────────────────────────────
/** A builder that remembers who wrote what, and in which frame and sub-tick. */
export class Recording extends SlotBuilder {
  constructor(opts) { super(opts); this.log = []; this.frame = 0; this.sub = 0; }
  write(port, addr, data) {
    this.log.push({ frame: this.frame, sub: this.sub, port, addr: addr & 0xff, data: data & 0xff });
    super.write(port, addr, data);
  }
  endSub() { this.sub++; super.endSub(); }
  endFrame() { const b = super.endFrame(); this.frame++; this.sub = 0; return b; }
}

/** One score, played through the reference driver for `frames` frames. */
export function recordScore(path, frames) {
  const { bytes, sampleBank } = buildMmb(path);
  const player = new DrvPlayer();
  player.loadMMB(bytes, sampleBank);
  const builder = new Recording();
  const ref = player.captureSlotLog({ maxFrames: frames, commands: [], builder });
  const n = ref.slots.length;
  return { name: basename(path, ".mmlisp"), frames: n,
    writes: builder.log.filter((x) => x.frame < n) };
}

/** The bytes a raw-baseline transport would carry for one semantic command. */
export const RAW_WRITES = (c, voices) => (c.op === "VOICE_SET"
  ? [...voices.values()].find((v) => v.id === c.voice).body.length
  : c.op === "PITCH" ? 2 : 1);

// ── What a score MEANS, per score (R27 §61.5) ─────────────────────────────
//
// A channel is a GLOBAL number here — port 0 carries channels 0..2 and port 1
// channels 3..5 — because a transport allocates across all six and a per-port
// number would have to be disambiguated at every use.
export const globalChannel = (port, ch) => port * 3 + ch;
/** $28's channel select: 0,1,2 are channels 1-3 and 4,5,6 are 4-6. */
export const keyChannel = (v) => ((v & 4) ? 3 : 0) + (v & 3);
export const keyIsOn = (v) => (v & 0xf0) !== 0;

const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[
  Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);

export const KINDS = ["VOICE_SET", "PITCH", "TL", "KEY", "RAW_GLOBAL"];

export function analyse({ name, frames, writes }) {
  const fm = writes.filter((w) => w.port === 0 || w.port === 1);
  const { commands, voices } = classify(fm);
  const back = expand(commands, voices);
  // THE FOLD, CHECKED. Byte for byte against the driver's own output — the
  // classification version claims to lose nothing, so nothing is what it may
  // lose (§61.5).
  let mismatch = null;
  for (let i = 0; i < Math.max(fm.length, back.length); i++) {
    const a = fm[i], b = back[i];
    if (!a || !b || a.port !== b.port || a.addr !== b.addr || a.data !== b.data) {
      mismatch = { at: i, want: a ?? null, got: b ?? null };
      break;
    }
  }

  // ── voices ────────────────────────────────────────────────────────────
  const held = new Array(6).fill(null);     // the voice each channel holds
  const on = new Array(6).fill(false);      // …and whether it is sounding
  const lastSet = new Map();                // voice id -> the frame it was last set
  const reuse = [], leads = [], sets = [];
  let simultaneous = 0, activeChanges = 0, coldChanges = 0;
  const pendingKey = [];                    // VOICE_SETs waiting for their key-on
  for (const c of commands) {
    if (c.op === "KEY") {
      const ch = keyChannel(c.value);
      if (keyIsOn(c.value)) {
        on[ch] = true;
        // The patch that was loaded for this key-on, if there was one.
        for (let i = pendingKey.length - 1; i >= 0; i--) {
          if (pendingKey[i].ch !== ch) continue;
          leads.push({ ch, frames: c.frame - pendingKey[i].frame, voice: pendingKey[i].voice });
          pendingKey.splice(i, 1);
          break;
        }
      } else on[ch] = false;
      continue;
    }
    if (c.op !== "VOICE_SET") continue;
    const ch = globalChannel(c.port, c.channel);
    if (lastSet.has(c.voice)) reuse.push(c.frame - lastSet.get(c.voice));
    lastSet.set(c.voice, c.frame);
    if (on[ch]) activeChanges++; else coldChanges++;
    pendingKey.push({ ch, frame: c.frame, voice: c.voice });
    held[ch] = c.voice;
    sets.push(c);
    simultaneous = Math.max(simultaneous, new Set(held.filter((v) => v !== null)).size);
  }

  // ── density, per frame and per sub-tick ───────────────────────────────
  const perFrame = Object.fromEntries(KINDS.map((k) => [k, new Array(frames).fill(0)]));
  const subKey = new Map();
  const rawPerFrame = new Array(frames).fill(0);
  const voiceWritesPerFrame = new Array(frames).fill(0);
  for (const c of commands) {
    if (c.frame < frames) perFrame[c.op][c.frame]++;
    const k = `${c.frame}/${c.sub}`;
    subKey.set(k, (subKey.get(k) ?? 0) + 1);
  }
  for (const w of fm) if (w.frame < frames) rawPerFrame[w.frame]++;
  for (const c of commands) if (c.op === "VOICE_SET" && c.frame < frames)
    voiceWritesPerFrame[c.frame] += c.writes;
  const secs = frames / 60;
  const density = Object.fromEntries(KINDS.map((k) => {
    const a = perFrame[k];
    return [k, { total: a.reduce((x, y) => x + y, 0), max: Math.max(0, ...a),
      p95: pct(a, 0.95), perSec: a.reduce((x, y) => x + y, 0) / secs }];
  }));
  // THE HEAVIEST FRAME, split the way a transport would have to split it: the
  // writes that are inside a patch, and everything else.
  let heavy = 0;
  for (let f = 1; f < frames; f++) if (rawPerFrame[f] > rawPerFrame[heavy]) heavy = f;
  const split = { frame: heavy, raw: rawPerFrame[heavy] ?? 0,
    voiceWrites: voiceWritesPerFrame[heavy] ?? 0,
    delta: (rawPerFrame[heavy] ?? 0) - (voiceWritesPerFrame[heavy] ?? 0),
    voices: commands.filter((c) => c.op === "VOICE_SET" && c.frame === heavy).length };

  return { name, frames, raw: fm.length, commands, voices, mismatch,
    distinctVoices: voices.size, voiceSets: sets.length,
    reuseMed: pct(reuse, 0.5), reuseMax: Math.max(0, ...reuse), simultaneous,
    activeChanges, coldChanges,
    leadMin: leads.length ? Math.min(...leads.map((l) => l.frames)) : null,
    leadMed: leads.length ? pct(leads.map((l) => l.frames), 0.5) : null,
    leadMax: leads.length ? Math.max(...leads.map((l) => l.frames)) : null,
    leads, unkeyed: pendingKey.length,
    density, subMax: Math.max(0, ...subKey.values()), split,
    cmdPerSec: commands.length / secs };
}

// ── The report ────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const FRAMES = Number(arg("frames", 400));
  const ONLY = arg("score", null);
  const list = scoreList().filter((s) => !ONLY || basename(s).includes(ONLY));
  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  const rows = list.map((s) => analyse(recordScore(s, FRAMES)));
  const bad = rows.filter((r) => r.mismatch);

  console.log(`── the fold, checked against the driver's own output — ${rows.length} scores,`
    + ` ${FRAMES} frames each ──`);
  for (const r of bad)
    console.log(`  ${r.name}: raw write ${r.mismatch.at} is`
      + ` ${JSON.stringify(r.mismatch.want)} and the expansion says ${JSON.stringify(r.mismatch.got)}`);
  const raw = rows.reduce((t, r) => t + r.raw, 0);
  const cmds = rows.reduce((t, r) => t + r.commands.length, 0);
  console.log(`  ${raw} raw FM writes fold to ${cmds} semantic commands and expand back to`
    + ` ${raw} — ${bad.length ? `${bad.length} SCORES DISAGREE` : "byte for byte, on every score"}`);

  console.log(`\n── voices ──`);
  console.log(`  ${pad("score", 22)}${num("distinct", 9)}${num("sets", 6)}${num("reuse med", 10)}`
    + `${num("max", 6)}${num("held", 6)}${num("on active", 10)}${num("cold", 6)}${num("no key", 7)}`);
  for (const r of rows)
    console.log(`  ${pad(r.name, 22)}${num(r.distinctVoices, 9)}${num(r.voiceSets, 6)}`
      + `${num(r.reuseMed, 10)}${num(r.reuseMax, 6)}${num(r.simultaneous, 6)}`
      + `${num(r.activeChanges, 10)}${num(r.coldChanges, 6)}${num(r.unkeyed, 7)}`);
  const allVoices = new Set();
  for (const r of rows) for (const [k] of r.voices) allVoices.add(k);
  console.log(`  ${pad("ALL", 22)}${num(allVoices.size, 9)}`
    + `${num(rows.reduce((t, r) => t + r.voiceSets, 0), 6)}${num("", 10)}`
    + `${num(Math.max(...rows.map((r) => r.reuseMax)), 6)}`
    + `${num(Math.max(...rows.map((r) => r.simultaneous)), 6)}`
    + `${num(rows.reduce((t, r) => t + r.activeChanges, 0), 10)}`
    + `${num(rows.reduce((t, r) => t + r.coldChanges, 0), 6)}`
    + `${num(rows.reduce((t, r) => t + r.unkeyed, 0), 7)}`);
  console.log("  distinct = voice IDENTITIES, folded from the register/value list with the"
    + " channel taken out;\n  reuse = frames between two loads of the same identity;"
    + " held = the most identities live on the six channels at once;\n  on active = a patch"
    + " written to a channel that was still sounding; no key = a patch never keyed.");

  console.log(`\n── how many commands, and when ──`);
  console.log(`  ${pad("score", 22)}${num("cmd/s", 8)}${num("sub max", 9)}`
    + KINDS.map((k) => num(k.slice(0, 5), 8) + num("max", 5)).join(""));
  for (const r of rows)
    console.log(`  ${pad(r.name, 22)}${num(r.cmdPerSec.toFixed(1), 8)}${num(r.subMax, 9)}`
      + KINDS.map((k) => num(r.density[k].perSec.toFixed(1), 8)
        + num(r.density[k].max, 5)).join(""));
  const secs = rows.reduce((t, r) => t + r.frames, 0) / 60;
  console.log(`  ${pad("ALL", 22)}${num((cmds / secs).toFixed(1), 8)}`
    + `${num(Math.max(...rows.map((r) => r.subMax)), 9)}`
    + KINDS.map((k) => num((rows.reduce((t, r) => t + r.density[k].total, 0) / secs).toFixed(1), 8)
      + num(Math.max(...rows.map((r) => r.density[k].max)), 5)).join(""));
  console.log("  cmd/s is the whole corpus's rate; \"max\" is the most of that command in ONE"
    + " frame;\n  sub max is the most commands in one sub-tick, which is what a transport"
    + " carries in one go.");

  console.log(`\n── the lead a patch gets before its key-on, in frames ──`);
  console.log(`  ${pad("score", 22)}${num("keyed sets", 11)}${num("min", 6)}${num("med", 6)}`
    + `${num("max", 6)}${num("same frame", 11)}`);
  for (const r of rows) {
    if (!r.leads.length) continue;
    console.log(`  ${pad(r.name, 22)}${num(r.leads.length, 11)}${num(r.leadMin, 6)}`
      + `${num(r.leadMed, 6)}${num(r.leadMax, 6)}`
      + `${num(r.leads.filter((l) => l.frames === 0).length, 11)}`);
  }
  const leads = rows.flatMap((r) => r.leads);
  console.log(`  ${pad("ALL", 22)}${num(leads.length, 11)}`
    + `${num(Math.min(...leads.map((l) => l.frames)), 6)}`
    + `${num(pct(leads.map((l) => l.frames), 0.5), 6)}`
    + `${num(Math.max(...leads.map((l) => l.frames)), 6)}`
    + `${num(leads.filter((l) => l.frames === 0).length, 11)}`);
  console.log("  A lead of 0 is a patch and its key-on in the same frame: there is nothing to"
    + "\n  prefetch there, and the transport has to carry the whole body before the note.");

  console.log(`\n── the heaviest frame of each score, split the way a transport must ──`);
  console.log(`  ${pad("score", 22)}${num("frame", 7)}${num("raw", 6)}${num("in patches", 12)}`
    + `${num("delta", 7)}${num("patches", 9)}`);
  const heaviest = [...rows].sort((a, b) => b.split.raw - a.split.raw).slice(0, 12);
  for (const r of heaviest)
    console.log(`  ${pad(r.name, 22)}${num(r.split.frame, 7)}${num(r.split.raw, 6)}`
      + `${num(r.split.voiceWrites, 12)}${num(r.split.delta, 7)}${num(r.split.voices, 9)}`);
  console.log("  (the twelve heaviest; \"in patches\" is what a voice identity replaces and"
    + " \"delta\" is what stays)");
}

// A channel changes hands cleanly (docs/driver.md §2.2, §2.5).
//
// Two rules, one method. A channel's MODULATORS do not outlive its owner, and
// a part an effect displaced comes back exactly when the effect hands the
// channel back — never later, never over someone else.
//
//   node tools/claim-gate.mjs [--pal]
//
// WHY THIS IS NOT THE c-gate. That gate compares the C sequencer against
// drv-player.js, so a rule both of them get wrong passes it — and this rule was
// wrong in both for as long as it existed (driver-decisions.md §6). What a
// leak looks like is not a disagreement between the players; it is register
// traffic that the music never asked for. So each case here is a score and a
// TWIN: the same score with the modulators removed. Over the window where the
// modulators must not be heard, the two slot streams have to be identical, and
// any leak is bytes in one that are not in the other.
//
// A case may give its twin its OWN schedule: the cleanest way to say "the
// effect must leave no trace" is to compare against the run where the effect
// never fired, and that is a different command list over the same notes.
//
// The windows are half-open [from, to) in rendered frames, and they stop where
// the two scores are *supposed* to part company — a restored part's macro
// really does come back, and a channel a sweep has moved really does stay
// where it left it.
//
// ONE WINDOW SERVES BOTH VIDEO STANDARDS. The claims are host commands, so they
// land on the frame the schedule names whatever the clock; the effect that ends
// them is a musical length, so it is 30 frames at 60 Hz and 25 at 50 Hz. The
// windows are therefore cut to whichever bound is tighter — a steal window that
// ends before the PAL restore, a restore window that opens after the NTSC one.
// Writing the scores in `Nf` instead would align the two exactly, but it would
// also make them PAL tests, which they are not (tools/pal-gate.mjs).
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildMmb } from "./mmb-build.mjs";
import { DrvPlayer } from "../../live/src/drv-player.js";
import { SlotBuilder } from "../../live/src/slot-builder.js";
import { existsSync, readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const tests = join(here, "..", "tests");
const pal = process.argv.includes("--pal");
const frameHz = pal ? 50 : 60;
// The schedules put the claim at frame 40 on the NTSC clock; on PAL the same
// frame numbers are the same frames (a host schedule is frames, not beats), so
// the windows hold for both.
const CASES = [
  {
    score: "p3-se-fade",
    from: 60, to: 140,   // after the 8-frame ramp and its terminal stop
    what: "a faded-out effect hands the channel back like a stopped one",
  },
  {
    score: "p3-se-stopped",
    from: 74, to: 140,
    what: "a displaced part stopped by the host is not restored by the effect",
  },
  {
    score: "p3-claim-evict",
    from: 41, to: 120,
    what: "an evicted track's macro and sweep stop at the eviction",
  },
  {
    score: "p3-claim-se-in",
    from: 41, to: 64,   // the effect ends at f65 on PAL, f71 on NTSC
    what: "a displaced part's macro and sweep do not play the effect",
  },
  {
    score: "p3-claim-se-out",
    from: 74, to: 130,  // opens after the NTSC restore, the later of the two
    what: "an effect's macro and sweep do not play the restored part",
  },
];
const MAX_FRAMES = 140;
// The ledger is checked for longer: an effect that ends late (a CH3 hold in
// p3-se-ch3 lasts to f151) must be seen giving its hold back.
const INVARIANT_FRAMES = 240;

function slots(stem) {
  const path = join(tests, `${stem}.mmlisp`);
  const { bytes: mmb, sampleBank, diagnostics } = buildMmb(path, { frameHz });
  for (const d of diagnostics ?? []) {
    if (d.severity === "error") throw new Error(`${stem}: ${d.code}: ${d.message}`);
  }
  // A twin with its own sidecar runs its own schedule; otherwise both halves
  // share the case's, which belongs to the case rather than to the file.
  const own = join(tests, `${stem}.cmds.json`);
  const shared = join(tests, `${stem.replace(/-twin$/, "")}.cmds.json`);
  const sidecar = JSON.parse(readFileSync(existsSync(own) ? own : shared, "utf8"));
  const drv = new DrvPlayer();
  drv.loadMMB(mmb, sampleBank);
  return drv.captureSlotLog({
    maxFrames: MAX_FRAMES, commands: sidecar.commands ?? [],
    autoStart: sidecar.autoStart !== false, builder: new SlotBuilder(),
  }).slots;
}

// ── The bookkeeping invariant ──────────────────────────────────────────────
// A twin diff answers "was there traffic nobody asked for". It cannot answer
// "is the ledger still consistent", because a stranded part is SILENT — it
// simply never plays again, and its effect still holds a pointer to it that
// will one day restore it over somebody else. So this is checked directly, on
// every frame of every schedule that involves an effect:
//
//   a part is suspended  <=>  exactly one RUNNING effect names it,
//
// which is the whole of §2.5's lifetime rule in one line. Every path that ends
// an effect (its own end, a stop, a fade) and every path that takes a channel
// away (a claim, a preempt) has to keep it true.
const INVARIANT_SCORES = [
  "m3-se", "m3-se-prio", "p3-se-strand", "p3-se-fade", "p3-se-stopped",
  "p3-se-overlap", "p3-se-pcm-macro", "p3-se-def", "p3-se-ch3", "p3-se-ch3-op",
  "p3-se-patch",
  "p3-claim-se-in", "p3-claim-se-out",
];

function checkInvariant(stem) {
  const path = join(tests, `${stem}.mmlisp`);
  const { bytes: mmb, sampleBank } = buildMmb(path, { frameHz });
  const sidecar = JSON.parse(readFileSync(join(tests, `${stem}.cmds.json`), "utf8"));
  const drv = new DrvPlayer();
  drv.loadMMB(mmb, sampleBank);
  drv._slotSink = new SlotBuilder();
  drv._audioContext = null;
  drv._writeCb = (p, a, v) => { if (!(p === 0 && a === 0x2a)) drv._slotSink.write(p, a, v); };
  drv._reset(sidecar.autoStart !== false);
  const byFrame = new Map();
  for (const c of sidecar.commands ?? []) {
    if (!byFrame.has(c.frame)) byFrame.set(c.frame, []);
    byFrame.get(c.frame).push(c);
  }
  for (let f = 0; f < INVARIANT_FRAMES; f++) {
    for (const c of byFrame.get(f) ?? []) drv._applyMailbox(c.cmd, c.a0 ?? 0, c.a1 ?? 0, c.a2 ?? 0);
    drv.stepFrame();
    drv._slotSink.endFrame();
    // CH3 is held whole: while an effect holds it, the song's CH3 parts are
    // suspended under that ONE hold, and the hold needs a running part of the
    // effect there — else nothing will ever end it and give CH3 back.
    const ch3 = drv._ch3;
    const ch3Parts = drv._trk.filter((x) => x.isSe && x.running && drv._ch3Group(x.channelId));
    if (ch3.active && !ch3Parts.some((x) => x.seIndex === ch3.se)) {
      return `f${f}: effect ${ch3.se} holds CH3 with no part of it running there`;
    }
    if (!ch3.active && ch3Parts.length) {
      return `f${f}: track ${ch3Parts[0].index} plays on CH3 as an effect with no hold`;
    }
    for (const t of drv._trk) {
      if (drv._ch3Group(t.channelId)) {
        if (t.suspended && !ch3.active) return `f${f}: CH3 track ${t.index} is suspended with no effect holding CH3`;
        continue;
      }
      const holders = drv._trk.filter((x) => x.isSe && x.running && x.displaced === t.index);
      if (t.suspended && holders.length !== 1) {
        return `f${f}: track ${t.index} is suspended with ${holders.length} effects holding it`;
      }
      if (!t.suspended && holders.length) {
        return `f${f}: effect ${holders[0].index} still names track ${t.index}, which is not suspended`;
      }
      // …and no track that is not a running effect may still name one. This is
      // the other half: a stale pointer is silent until the track is fired
      // again somewhere else, and then it restores a part over a stranger.
      if (!(t.isSe && t.running) && t.displaced != null) {
        return `f${f}: track ${t.index} is not a running effect but still names track ${t.displaced}`;
      }
    }
  }
  return null;
}

// ── The patch comes back ───────────────────────────────────────────────────
// An effect's end puts back the patch the channel had — as the chip had it,
// not as some voice number would rebuild it (§2.5). The song's patch in these
// scores has no voice to rebuild from (a partial def-fm, then a mid-song :tl1
// and :pan), so the register shadow of the channel's patch — $30-$9C and $B0/$B4,
// with the carriers' composed $40 left out — must read the same the frame
// before the claim and once the effect is over.
const PATCH_CASES = [
  { score: "p3-se-patch", port: 0, off: 0, before: 69, after: 199 },
];

function patchAt(stem, c) {
  const { bytes: mmb, sampleBank } = buildMmb(join(tests, `${stem}.mmlisp`), { frameHz });
  const sidecar = JSON.parse(readFileSync(join(tests, `${stem}.cmds.json`), "utf8"));
  const drv = new DrvPlayer();
  drv.loadMMB(mmb, sampleBank);
  drv._audioContext = null;
  drv._writeCb = () => {};
  drv._reset(sidecar.autoStart !== false);
  const read = () => {
    const out = [];
    for (let a = 0x30; a < 0xa0; a += 4) out.push(drv._shadow[c.port].get(a + c.off));
    // $40 of a modulator is its raw level; a carrier's is composed, so compare
    // the voiced level the structured shadow keeps instead.
    out.push(...drv._fm[c.port * 3 + c.off].ops.map((o) => o.voicedTl));
    out.push(drv._shadow[c.port].get(0xb0 + c.off), drv._shadow[c.port].get(0xb4 + c.off));
    return out.join(",");
  };
  const snaps = {};
  for (let f = 0; f <= c.after; f++) {
    for (const cmd of sidecar.commands ?? []) {
      if (cmd.frame === f) drv._applyMailbox(cmd.cmd, cmd.a0 ?? 0, cmd.a1 ?? 0, cmd.a2 ?? 0);
    }
    drv.stepFrame();
    if (f === c.before || f === c.after) snaps[f] = read();
  }
  return snaps;
}

const hex = (s) => Array.from(s).map((x) => x.toString(16).padStart(2, "0")).join(" ");
let failures = 0;
for (const c of CASES) {
  const a = slots(c.score);
  const b = slots(`${c.score}-twin`);
  const leaked = [];
  for (let f = c.from; f < c.to; f++) {
    const x = a[f] ?? new Uint8Array(0), y = b[f] ?? new Uint8Array(0);
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) leaked.push(f);
  }
  if (!leaked.length) {
    console.log(`ok    ${c.score} — ${c.what} (f${c.from}..${c.to})`);
    continue;
  }
  failures++;
  const f = leaked[0];
  console.log(`FAIL  ${c.score} — ${c.what}`);
  console.log(`      ${leaked.length} frames of traffic the music never asked for, from f${f}:`);
  console.log(`        score: ${hex(a[f] ?? [])}`);
  console.log(`        twin : ${hex(b[f] ?? [])}`);
}
for (const stem of INVARIANT_SCORES) {
  const bad = checkInvariant(stem);
  if (bad) {
    failures++;
    console.log(`FAIL  ${stem} — the suspend ledger is inconsistent`);
    console.log(`        ${bad}`);
  } else {
    console.log(`ok    ${stem} — a part is suspended exactly while one effect holds it`);
  }
}

for (const c of PATCH_CASES) {
  const s = patchAt(c.score, c);
  if (s[c.before] === s[c.after]) {
    console.log(`ok    ${c.score} — the effect's end puts the channel's patch back`);
  } else {
    failures++;
    console.log(`FAIL  ${c.score} — the patch after the effect is not the one before it`);
    console.log(`        f${c.before}: ${s[c.before]}`);
    console.log(`        f${c.after}: ${s[c.after]}`);
  }
}

const total = CASES.length + INVARIANT_SCORES.length + PATCH_CASES.length;
console.log(`\n${total - failures} passed · ${failures} failed${pal ? " (PAL)" : ""}`);
if (failures) process.exit(1);

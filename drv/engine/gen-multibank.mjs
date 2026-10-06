// One/two-voice block renderer for the banked MMB profile. Legacy images keep
// using gen-stream.mjs. A block is built voice by voice, with a complete ROM
// bank selection between voices. The DAC consumes an older, finished block.
//
// Samples remain pre-baked signed bytes; END/WRAP retain the 16-byte contract.
// Each individual blob stays inside a bank; the combined library need not.
import { buildConfig, PCMN_L, pcm1Base } from "./config.mjs";
import { balanced, expanderCost } from "./gen-stream.mjs";
import { op, cost, laySlot, placementTable } from "./schedule.mjs";
import { buildClamp, buildRungs } from "./lut.mjs";

export const MB = Object.freeze({
  voices: 2, block: 16, lead: 32,
  // These four STORE opcodes are unused in a two-voice light image.
  bankOp: [0x1c, 0x1e],
  ptr: [0x1e00, 0x1e02], bank: [0x1e04, 0x1e06], target: 0x1e08,
});
const hx = (x) => `$${x.toString(16)}`;

export function multibankConfig(period = 354, xpSteps = 15, voices = 2) {
  return buildConfig({ voices, loops: true, stepVoices: 0,
    complete: true, pairs: true, signedSource: true, production: true,
    workTarget: 1, meanTarget: 1, sampleMaster: period * 15,
    lapBlocks: 5, xpSteps, lead: MB.lead });
}

export function generateMultibank(cfg = multibankConfig()) {
  if (![1, 2].includes(cfg.voices) || cfg.cycleSlots !== 80 || cfg.groupSlots !== 1)
    throw new Error("multibank prototype requires one or two voices and 80 equal slots");
  const base = pcm1Base(cfg);
  const state = (key, v) => hx(base + PCMN_L[key](v));
  const routines = [], jobs = [];
  const routine = (label, ops, action) => op(ops.flatMap((x) => x.asm), cost(ops), { what: label, action });
  const gen = (v, which) => {
    const start = which === "start";
    const key = start ? "startGen" : "endGen";
    const last = start ? "lastStart" : "lastEnd";
    const mask = start ? "startMask" : "applyMask";
    return [op(`ld a,(${state(key, v)})`, 13), op("ld b,a", 4),
      op(`ld a,(${state(last, v)})`, 13), op("sub b", 4), op("add a,$ff", 7),
      op("sbc a,a", 4), op(`ld (${state(mask, v)}),a`, 13),
      op("ld a,b", 4), op(`ld (${state(last, v)}),a`, 13)];
  };
  const mixers = [];
  const samples = (v) => {
    const max = v ? 3 : 6;
    const term = (i) => [op("ld a,(de)", 7 + cfg.windowWait), op("inc de", 6),
      op("ld l,a", 4), op([`mb_level_${v}_${i}:`, "ld h,$13"], 7), op("ld a,(hl)", 7),
      ...(v ? [op("ld l,a", 4), op("ld a,(bc)", 7), op("add a,l", 4),
        op("ld l,a", 4), op("ld a,0", 7), op(`adc a,${cfg.ram.clamp[0] >> 8}`, 7),
        op("ld h,a", 4), op("ld a,(hl)", 7)] : []),
      op("ld (bc),a", 7), op("inc c", 4)];
    const calls = [];
    for (let n = 1; n <= max; n++) {
      routines.push(`mb_mix_${v}_${n}:`, "exx", `jp mb_terms_${v}_${n}`);
      calls[n] = op(`call mb_mix_${v}_${n}`, 17 + 4 + 10 + n * cost(term(0)) + 4 + 10,
        { what: `mix voice ${v}, ${n} samples`, action: { kind: "mix", v, n } });
    }
    for (let n = max; n > 0; n--) routines.push(`mb_terms_${v}_${n}:`, ...term(n).flatMap((x) => x.asm));
    routines.push("exx", "ret");
    mixers[v] = calls;
    return max;
  };

  for (let v = 0; v < cfg.voices; v++) {
    // Generation reads and commit pieces precede this voice's source fetches.
    // The host observes the advertised IDLE fence before reusing staged bytes.
    jobs.push([routine(`mb_gen_start_${v}`, gen(v, "start"), { kind: "genStart", v })],
      [routine(`mb_gen_end_${v}`, gen(v, "end"), { kind: "genEnd", v })]);
    jobs.push([routine(`mb_apply_${v}`, [op("exx", 4),
      op(`ld a,(${state("applyMask", v)})`, 13),
      op(`ld hl,${state("startMask", v)}`, 10), op("or (hl)", 7),
      ...balanced("z", [op(`ld hl,(${state("stEnd", v)})`, 16),
        op(`ld (${state("liveEnd", v)}),hl`, 16),
        op(`ld hl,(${state("stWrap", v)})`, 16),
        op(`ld (${state("liveWrap", v)}),hl`, 16)], `mb apply ${v}`), op("exx", 4)], { kind: "apply", v })]);
    jobs.push([routine(`mb_start_${v}`, [op("exx", 4),
      op(`ld a,(${state("startMask", v)})`, 13), op("or a", 4),
      ...balanced("z", [op(`ld hl,(${state("stSrc", v)})`, 16),
        op(`ld (${hx(MB.ptr[v])}),hl`, 16),
        op(`ld hl,(${hx(base + MB.bankOp[v])})`, 16),
        op(`ld (${hx(MB.bank[v])}),hl`, 16)], `mb start ${v}`), op("exx", 4)], { kind: "start", v })]);
    const max = samples(v);
    jobs.push([op(`ld a,(${state("level", v)})`, 13, { action: { kind: "level", v } }),
      ...Array.from({ length: max }, (_, i) => op(`ld (mb_level_${v}_${i + 1}+1),a`, 13))]);
    // The DAC owns A across slot boundaries. Reload the low bank byte for
    // each half instead of carrying a partially shifted value through a pad.
    // No ROM read can occur until all three ordered jobs have completed.
    for (const start of [0, 4]) {
      const part = [op(`ld a,(${hx(MB.bank[v])})`, 13)];
      for (let i = 0; i < start; i++) part.push(op("rrca", 4));
      for (let i = 0; i < 4; i++) {
        part.push(op("ld ($6000),a", 13));
        if (i < 3) part.push(op("rrca", 4));
      }
      jobs.push(part);
    }
    jobs.push([op(`ld a,(${hx(MB.bank[v] + 1)})`, 13), op("ld ($6000),a", 13)]);
    jobs.push([op("exx", 4, { action: { kind: "begin", v } }), op(`ld de,(${hx(MB.ptr[v])})`, 20),
      op(`ld bc,(${hx(MB.target)})`, 20), op("exx", 4)]);
    jobs.push({ voice: v, samples: 15 });
    // Match the original compare after sample 15, before sample 16.
    jobs.push([op("exx", 4, { action: { kind: "compare", v } }),
      op(`ld hl,${state("liveEnd", v)}`, 10), op("ld a,e", 4), op("sub (hl)", 7),
      op("inc l", 4), op("ld a,d", 4), op("sbc a,(hl)", 7), op("sbc a,a", 4),
      op("cpl", 4), op(`ld (${state("parkMask", v)}),a`, 13), op("exx", 4)]);
    // The isolated final sample otherwise pays CALL/JP/RET overhead.
    // Read the already patched level operand rather than adding another
    // self-modifying site to every block's level update.
    const lastTerm = [op("exx", 4), op("ld a,(de)", 7 + cfg.windowWait),
      op("inc de", 6), op("ld l,a", 4),
      op(`ld a,(mb_level_${v}_1+1)`, 13), op("ld h,a", 4), op("ld a,(hl)", 7),
      ...(v ? [op("ld l,a", 4), op("ld a,(bc)", 7), op("add a,l", 4),
        op("ld l,a", 4), op("ld a,0", 7), op(`adc a,${cfg.ram.clamp[0] >> 8}`, 7),
        op("ld h,a", 4), op("ld a,(hl)", 7)] : []),
      op("ld (bc),a", 7), op("inc c", 4), op("exx", 4)];
    jobs.push([cfg.voices === 2
      ? routine(`mb_final_${v}`, lastTerm, { kind: "mix", v, n: 1 }) : mixers[v][1]]);
    jobs.push([routine(`mb_wrap_${v}`, [op("exx", 4),
      op(`ld a,(${state("parkMask", v)})`, 13), op("or a", 4),
      ...balanced("z", [op(`ld de,(${state("liveWrap", v)})`, 20)], `mb wrap ${v}`),
      op(`ld (${hx(MB.ptr[v])}),de`, 20),
      ...(v === cfg.voices - 1 ? [op(`ld (${hx(MB.target)}),bc`, 20)] : []), op("exx", 4)], { kind: "wrap", v })]);
  }

  // Pack ordered PCM jobs and expander pieces together. Greedy PCM-first
  // packing strands the expander even when the total work fits. This bounded
  // DP keeps every reachable job boundary for each output slot and pair phase.
  const xp = expanderCost(cfg);
  const tokens = jobs.flatMap((job) => job.samples
    ? Array.from({ length: job.samples }, () => ({ voice: job.voice })) : [job]);
  const prefixes = (start) => {
    const best = new Map([[start, { cycles: 0, ops: [] }]]);
    for (let i = start; i < tokens.length; i++) {
      const prev = best.get(i);
      if (!prev) continue;
      const choices = [];
      if (Array.isArray(tokens[i])) choices.push({ end: i + 1, ops: tokens[i] });
      else {
        const v = tokens[i].voice;
        for (let n = 1; n < mixers[v].length && i + n <= tokens.length; n++) {
          if (Array.isArray(tokens[i + n - 1]) || tokens[i + n - 1].voice !== v) break;
          choices.push({ end: i + n, ops: [mixers[v][n]] });
        }
      }
      for (const c of choices) {
        const cycles = prev.cycles + cost(c.ops);
        if (cycles > cfg.periodCycles - 18) continue;
        if (!best.has(c.end) || best.get(c.end).cycles > cycles)
          best.set(c.end, { cycles, ops: [...prev.ops, ...c.ops] });
      }
    }
    return best;
  };
  const candidates = tokens.map((_, i) => prefixes(i));
  candidates.push(new Map([[tokens.length, { cycles: 0, ops: [] }]]));
  const work = [], sites = [];
  const stepsPerBlock = cfg.xpSteps === 8 ? [2, 1, 2, 1, 2]
    : Array.from({ length: 5 }, (_, b) => Math.round((b + 1) * cfg.xpSteps / 5) - Math.round(b * cfg.xpSteps / 5));
  for (let block = 0; block < 5; block++) {
    const need = 2 * stepsPerBlock[block];
    let frontier = new Map([["0:0", { pos: 0, piece: 0, path: [], used: 0 }]]);
    for (let slot = 0; slot < 16; slot++) {
      const next = new Map();
      const capacity = cfg.periodCycles - 18 - (block === 4 && slot === 15 ? 10 : 0);
      for (const st of frontier.values()) for (const take of [0, 1, 2]) {
        if (st.piece + take > need) continue;
        if (need - st.piece - take > 2 * (15 - slot)) continue;
        const parts = Array.from({ length: take }, (_, k) => (st.piece+k)%2);
        // B is short and has no branch. Inline it in the two-voice image
        // to save CALL/RET cycles for command throughput; A keeps YM timing.
        const x = parts.map((part) => part && cfg.voices === 2
          ? op(["ld (ix+0),0", "ld a,ixl", "add a,2", "ld ixl,a",
              `ld (${hx(base + PCMN_L.fifoLo)}),a`], xp.bCycles - 27, { what: "expander B" })
          : op(part ? "call xp_b" : "call xp_a",
              part ? xp.bCycles : xp.aCycles, { what: part ? "expander B" : "expander A" }));
        for (const [pos, pcm] of candidates[st.pos]) {
          const used = pcm.cycles + cost(x), pad = capacity - used;
          if (pad < 0 || [1, 2, 3, 5, 9].includes(pad)) continue;
          const key = `${pos}:${st.piece + take}`;
          if (next.has(key) && next.get(key).used <= st.used + used) continue;
          next.set(key, { pos, piece: st.piece + take, used: st.used + used,
            path: [...st.path, { ops: [...pcm.ops, ...x], xp: parts }] });
        }
      }
      frontier = next;
    }
    const found = frontier.get(`${tokens.length}:${need}`);
    if (!found) throw new Error(`PCM + pairs do not fit block ${block} at period ${cfg.periodCycles}`);
    for (const item of found.path) {
      for (const part of item.xp) {
        if (part === 0) sites.push({ a: work.length });
        if (part === 1) sites.at(-1).b = work.length;
      }
      work.push(item.ops);
    }
  }

  const lines = ["; EXPERIMENTAL block-banked PCM engine", "org 0", "di", "im 1", "ld sp,$2000",
    // Do not erase staged commands. Live state, FIFO and output are initialized.
    "ld hl,$1c00", "ld b,0", "ld a,$80", "mb_silence:", "ld (hl),a", "inc l", "djnz mb_silence",
    "ld hl,$1d00", "ld b,0", "xor a", "mb_fifo:", "ld (hl),a", "inc l", "djnz mb_fifo"];
  for (let v = 0; v < cfg.voices; v++) {
    lines.push("xor a");
    for (const key of ["lastStart", "lastEnd", "startMask", "applyMask", "parkMask"])
      lines.push(`ld (${state(key, v)}),a`);
    lines.push("ld hl,0", `ld (${state("liveEnd", v)}),hl`, `ld (${hx(MB.bank[v])}),hl`,
      "ld hl,$ff00", `ld (${state("liveWrap", v)}),hl`, `ld (${hx(MB.ptr[v])}),hl`,
      "ld a,$13", `ld (${state("level", v)}),a`);
  }
  lines.push(`ld hl,${hx(cfg.ram.ring[0] + MB.lead)}`, `ld (${hx(MB.target)}),hl`,
    "ld ix,$1d00", "ld iy,$1f00", "xor a", `ld (${hx(base + PCMN_L.fifoLo)}),a`,
    "ld a,$d2", `ld (${hx(base + PCMN_L.ready)}),a`,
    "ld a,$2a", "ld ($4000),a", "ld hl,$1c00", "ld de,$4001", "ld a,(hl)", "inc l", "stream:");
  const slots = work.map((ops, i) => laySlot({ index: i, cycles: cfg.periodCycles,
    dacWrite: op("ld (de),a", 7), work: ops,
    tail: [op("ld a,(hl)", 7), op("inc l", 4), ...(i === 79 ? [op("jp stream", 10)] : [])],
    fill: { dead: ["a", "b", "bc"] } }));
  for (let i = 0; i < slots.length; i++) {
    lines.push(`slot${i}:`);
    lines.push(...slots[i].ops.flatMap((x) => x.asm).map((line) =>
      line.replace(/pcmsk\d+|pcmdn\d+/g, (label) => `${label}_slot${i}`)));
  }
  lines.push(...routines, xp.text, "code_end:", "assert code_end <= $1100, \"multibank code exceeds RAM\"",
    "ds $1100-$,0");
  for (const table of [buildClamp(), buildRungs()])
    for (let i = 0; i < table.length; i += 16) lines.push(`db ${[...table.slice(i, i + 16)].join(",")}`);
  const actions = work.map((ops) => ops.flatMap((o) => o.action ? [o.action] : []));
  const at = (kind, v) => actions.flatMap((aa, slot) => aa.some((a) => a.kind === kind && a.v === v) ? [slot] : []);
  const nextAt = (slots, after, strict = true) => {
    for (let lap = Math.floor(after / 80); ; lap++)
      for (const s of slots) if (lap * 80 + s >= after + (strict ? 1 : 0)) return lap * 80 + s;
  };
  let idleAfterGen = 0;
  for (const { a } of sites) for (let v = 0; v < cfg.voices; v++) for (const start of [false, true]) {
    const seen = nextAt(at(start ? "genStart" : "genEnd", v), a);
    const applied = nextAt(at(start ? "start" : "apply", v), seen, false);
    let between = 0;
    for (let lap = Math.floor(a / 80); lap * 80 <= applied; lap++)
      for (const site of sites) if (lap * 80 + site.a > a && lap * 80 + site.a < applied) between++;
    idleAfterGen = Math.max(idleAfterGen, between);
  }
  return { text: lines.join("\n") + "\n", slots, placement: placementTable(slots), sites,
    idleAfterGen, actions, cfg };
}

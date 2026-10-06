// Timing is graded independently of register/sample values. Match writes to
// the score first, then compare each voice's intervals with the video clock.
export function analyzeMultibankTiming(score, trace, readyTime, pcmLog, dac, image, clockOrigin = readyTime) {
  const masterHz = image.cfg.machine.masterHz, frameMaster = image.cfg.machine.frameMaster;
  const ms = (master) => master * 1000 / masterHz;
  const quantile = (values, q) => values[Math.floor((values.length - 1) * q)] ?? null;
  const stats = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return { count: sorted.length, minMs: sorted[0] ?? null, medianMs: quantile(sorted, .5),
      p95Ms: quantile(sorted, .95), maxMs: sorted.at(-1) ?? null,
      spreadMs: sorted.length ? sorted.at(-1) - sorted[0] : null };
  };
  const row = (frame, time, channel) => ({ frame, channel, time,
    lagMs: ms(time - clockOrigin - frame * frameMaster) });
  let port = 0;
  const wantedFm = [], wantedPsg = [], wantedPcm = [];
  for (const item of score.items) {
    if (item.intent?.kind === "start") wantedPcm.push({ frame: item.frame, v: item.intent.v });
    for (const [op, value] of item.pairs) {
      if (op === 0x20) port = value;
      else if (op >= 0x22) wantedFm.push({ port, reg: op, value, frame: item.frame });
    }
    for (const value of item.psg ?? []) wantedPsg.push({ frame: item.frame, value });
  }
  const latch = [0, 0], fm = [];
  let at = 0;
  for (const e of trace.ymZ80) {
    if (e.read) continue;
    if (e.kind === "addr") { latch[e.part] = e.byte; continue; }
    if (e.time < readyTime || (e.part === 0 && latch[0] === 0x2a)) continue;
    const expected = wantedFm[at++];
    if (!expected || expected.port !== e.part || expected.reg !== latch[e.part] || expected.value !== e.byte)
      throw new Error("timing analysis requires a matching FM stream");
    if (expected.reg === 0x28 && (expected.value & 0xf0)) {
      const ch = (expected.value & 3) + ((expected.value & 4) ? 3 : 0);
      fm.push(row(expected.frame, e.time, `fm${ch + 1}`));
    }
  }
  const seenPsg = trace.psg68k.filter((e) => e.time >= readyTime);
  if (seenPsg.length !== wantedPsg.length) throw new Error("timing analysis requires a complete PSG stream");
  const psg = seenPsg.map((e, i) => {
    if ((e.value & 255) !== wantedPsg[i].value) throw new Error("timing analysis requires a matching PSG stream");
    return row(wantedPsg[i].frame, e.time, "psg");
  });
  const pcm = [];
  const starts = pcmLog.filter((e) => e.kind === "start");
  for (let v = 0; v < 2; v++) {
    const want = wantedPcm.filter((e) => e.v === v), got = starts.filter((e) => e.v === v);
    if (want.length !== got.length) throw new Error("timing analysis requires all PCM starts");
    for (let i = 0; i < want.length; i++) {
      // The block renderer builds the first source sample into this future
      // output block. This measures playback, not the earlier staged STORE.
      const outputSlot = Math.floor(got[i].slot / 16) * 16 + image.cfg.lead;
      if (dac[outputSlot]) pcm.push(row(want[i].frame, dac[outputSlot].time, `pcm${v + 1}`));
    }
  }
  const summarize = (rows, after = 60, through = Infinity) => {
    const warm = rows.filter((r) => r.frame > after && r.frame <= through);
    const intervals = [], previous = new Map();
    for (const r of warm) {
      const prev = previous.get(r.channel);
      if (prev && r.frame !== prev.frame)
        intervals.push({ channel: r.channel, frame: r.frame, seconds: r.frame * frameMaster / masterHz,
          errorMs: r.lagMs - prev.lagMs });
      previous.set(r.channel, r);
    }
    return { latency: stats(warm.map((r) => r.lagMs)),
      intervalError: stats(intervals.map((r) => Math.abs(r.errorMs))),
      worstIntervals: intervals.sort((a, b) => Math.abs(b.errorMs) - Math.abs(a.errorMs)).slice(0, 10),
      byChannel: Object.fromEntries([...new Set(warm.map((r) => r.channel))]
        .map((ch) => [ch, stats(warm.filter((r) => r.channel === ch).map((r) => r.lagMs))])) };
  };
  const firstFrame = Math.min(...fm.map((r) => r.frame));
  const firstKeys = fm.filter((r) => r.frame === firstFrame);
  return { warmupFrames: 60, frameMs: ms(frameMaster), fm: summarize(fm), pcm: summarize(pcm), psg: summarize(psg),
    startup: { fm: summarize(fm, 1, 60), pcm: summarize(pcm, 1, 60), psg: summarize(psg, 1, 60),
      firstFmFrame: Number.isFinite(firstFrame) ? firstFrame : null,
      firstFmSpreadMs: firstKeys.length ? ms(Math.max(...firstKeys.map((r) => r.time))-Math.min(...firstKeys.map((r) => r.time))) : null } };
}

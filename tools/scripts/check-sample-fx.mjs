#!/usr/bin/env node
// Checks the def :sample `:fx` chain (live/src/sample-fx.js): each effect
// does what its name says on a synthetic signal, the compiler resolves and
// rejects `:fx` forms, an import's chain and an extending `(def-pcm name base …)` compose,
// and the bank (and the keyboard audition's bank) bakes the processed signal.
import { applySampleEffects } from "../../live/src/sample-fx.js";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb, bakeAuditionBank } from "../../live/src/export-mmb.js";

const RATE = 22050;
let failed = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const tone = (sec, amp, hz = 220) =>
  Float32Array.from({ length: Math.round(sec * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE));
const peak = (x, from = 0, to = x.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
};
const db = (g) => 20 * Math.log10(g);
const run = (x, chain) => {
  const warns = [];
  const y = applySampleEffects(x, RATE, chain, (code) => warns.push(code));
  return { y, warns };
};

// gain / normalize
{
  const { y } = run(tone(0.1, 0.25), [{ type: "gain", db: 6 }]);
  check("gain +6 dB", Math.abs(db(peak(y) / 0.25) - 6) < 0.05, `${db(peak(y) / 0.25).toFixed(2)} dB`);
  const n = run(tone(0.1, 0.1), [{ type: "normalize", peak: -1 }]).y;
  check("normalize to -1 dBFS", Math.abs(db(peak(n)) + 1) < 0.01, `${db(peak(n)).toFixed(3)} dB`);
  const z = run(new Float32Array(100), [{ type: "normalize", peak: 0 }]).y;
  check("normalize leaves silence silent", peak(z) === 0);
}

// comp: a steady tone 12 dB over threshold settles near T + 12/R
{
  const x = tone(0.5, Math.pow(10, -6 / 20));
  const { y } = run(x, [{ type: "comp", threshold: -18, ratio: 4, attack: 0.001, release: 0.05, knee: 0, makeup: 0 }]);
  const settled = db(peak(y, y.length >> 1));
  check("comp 4:1 settles near -15 dB", Math.abs(settled - -15) < 1.5, `${settled.toFixed(2)} dB`);
  const quiet = run(tone(0.2, 0.05), [{ type: "comp", threshold: -18, ratio: 4, attack: 0.001, release: 0.05, knee: 0, makeup: 0 }]).y;
  check("comp leaves a signal under threshold alone", Math.abs(peak(quiet) - 0.05) < 1e-3);
}

// limit: +12 dB into a 0 dBFS / -3 dBFS ceiling never exceeds it
{
  const x = tone(0.3, 0.9);
  for (const ceiling of [0, -3]) {
    const { y } = run(x, [{ type: "gain", db: 12 }, { type: "limit", ceiling, release: 0.05 }]);
    const c = Math.pow(10, ceiling / 20);
    check(`limit holds ${ceiling} dBFS`, peak(y) <= c + 1e-6, `peak ${peak(y).toFixed(4)}`);
  }
}

// crush: N bits leave at most 2^N - 1 levels
{
  const { y } = run(tone(0.1, 1), [{ type: "crush", bits: 3 }]);
  const levels = new Set(Array.from(y, (v) => v.toFixed(6)));
  check("crush 3 bits: <= 7 levels", levels.size <= 7, `${levels.size} levels`);
}

// hpf / lpf: a 12 dB/oct cut, a tone well inside the band passes; a cutoff
// past the sample's Nyquist warns and filters just under it
{
  const level = (hz, chain) => {
    const y = run(tone(0.5, 0.5, hz), chain).y;
    return db(peak(y, y.length >> 1) / 0.5);
  };
  const lowCut = level(100, [{ type: "hpf", freq: 1000 }]);
  check("hpf 1000: 100 Hz down > 30 dB", lowCut < -30, `${lowCut.toFixed(1)} dB`);
  const highPass = level(5000, [{ type: "hpf", freq: 1000 }]);
  check("hpf 1000: 5 kHz passes", Math.abs(highPass) < 0.5, `${highPass.toFixed(2)} dB`);
  const highCut = level(5000, [{ type: "lpf", freq: 500 }]);
  check("lpf 500: 5 kHz down > 30 dB", highCut < -30, `${highCut.toFixed(1)} dB`);
  const lowPass = level(50, [{ type: "lpf", freq: 500 }]);
  check("lpf 500: 50 Hz passes", Math.abs(lowPass) < 0.5, `${lowPass.toFixed(2)} dB`);
  const corner = level(1000, [{ type: "lpf", freq: 1000 }]);
  check("lpf: -3 dB at the cutoff", Math.abs(corner + 3) < 0.5, `${corner.toFixed(2)} dB`);
  const past = run(tone(0.1, 0.5), [{ type: "lpf", freq: 20000 }]);
  check("lpf past Nyquist warns", past.warns.includes("W_SAMPLE_FX_FREQ"));
}

// drive: full scale stays full scale, a quieter signal comes up, silence
// stays silent
{
  const full = run(tone(0.1, 1), [{ type: "drive", db: 12 }]).y;
  check("drive keeps full scale at full scale", Math.abs(peak(full) - 1) < 1e-3, `peak ${peak(full).toFixed(4)}`);
  const quiet = run(tone(0.1, 0.25), [{ type: "drive", db: 12 }]).y;
  check("drive brings a quiet signal up", peak(quiet) > 0.5, `peak ${peak(quiet).toFixed(3)}`);
  const z = run(new Float32Array(100), [{ type: "drive", db: 12 }]).y;
  check("drive leaves silence silent", peak(z) === 0);
}

// fade: trimmed at at+len, silent at the end, linear is monotone
{
  const x = new Float32Array(RATE).fill(0.5); // 1 s DC
  const { y } = run(x, [{ type: "fade", at: 0.2, len: 0.1, curve: "linear" }]);
  check("fade trims to at+len", y.length === Math.round(0.3 * RATE), `${y.length} frames`);
  check("fade leaves the head alone", y[Math.round(0.1 * RATE)] === 0.5);
  check("fade reaches silence", Math.abs(y[y.length - 1]) < 0.5 / 1000);
  let mono = true;
  for (let i = Math.round(0.2 * RATE) + 1; i < y.length; i++) if (y[i] > y[i - 1]) mono = false;
  check("linear fade is monotone", mono);
  const d = run(x, [{ type: "fade", at: null, len: 0.25, curve: "ease-out-expo" }]).y;
  check("fade with no :at ends at the sample's end", d.length === x.length);
  const past = run(x, [{ type: "fade", at: 2, len: 0.1, curve: "linear" }]);
  check("fade past the end warns and does nothing",
    past.warns.includes("W_SAMPLE_FX_FADE_PAST_END") && past.y.length === x.length);
}

// reverb: grows by exactly :tail, rings after the dry ends, fades to silence;
// :mix 0 is the dry signal; :predelay holds the wet back
{
  const x = new Float32Array(Math.round(0.05 * RATE));
  x[0] = 1; // an impulse
  const chain = (p) => [{ type: "reverb", size: 0.5, damp: 0.5, mix: 0.3, predelay: 0, tail: 0.3, ...p }];
  const { y } = run(x, chain({}));
  check("reverb grows by :tail", y.length === x.length + Math.round(0.3 * RATE), `${y.length} frames`);
  const ring = peak(y, x.length, x.length + Math.round(0.05 * RATE));
  check("reverb rings past the dry end", ring > 1e-3, ring.toExponential(2));
  check("reverb tail fades to silence", peak(y, y.length - 20) < 1e-4, peak(y, y.length - 20).toExponential(2));
  const dry = run(x, chain({ mix: 0 })).y;
  check("reverb :mix 0 is dry", dry[0] === 1 && peak(dry, 1) === 0);
  const late = run(x, chain({ mix: 1, predelay: 0.02 })).y;
  const lead = Math.round(0.02 * RATE);
  check("reverb :predelay holds the wet back", peak(late, 1, lead) === 0 && peak(late, lead) > 0);
}

// the documented loudness idioms make a full-scale drum LOUDER with the
// defaults (comp alone, or a comp whose loss a small gain does not repay,
// makes it quieter — the chain the docs once recommended)
{
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 31) - 1;
  const n = Math.round(0.25 * RATE);
  const drum = Float32Array.from({ length: n }, (_, i) => rnd() * Math.exp(-i / (0.04 * RATE)));
  const gp = 1 / peak(drum);
  for (let i = 0; i < n; i++) drum[i] *= gp; // full scale, as the presets are
  const rms = (x) => { let q = 0; for (const v of x) q += v * v; return 10 * Math.log10(q / x.length); };
  const chainOf = (fx) => compileMMLisp(`(def-pcm s :file "/x.wav" :fx [${fx}])`, "t.mmlisp").ir.metadata.samples[0].fx;
  for (const fx of ["(comp :threshold -30 :ratio 8) (normalize)", "(gain 12) (limit)"]) {
    const { y } = run(drum, chainOf(fx));
    const up = rms(y) - rms(drum);
    check(`${fx} is louder on a drum`, up > 3 && peak(y) <= 1 + 1e-6, `${up >= 0 ? "+" : ""}${up.toFixed(1)} dB`);
  }
}

// the compiler: resolution and rejection
{
  const ok = compileMMLisp(`(def-score :pcm-voices 1)
(def-pcm s :file "/x.wav" :fx [(gain 3) (comp :ratio 2 :attack 2ms) (fade :len 8)])
(pcm1 s :tempo 120 :len 4 c)`, "t.mmlisp");
  const fx = ok.ir.metadata.samples[0].fx;
  check("compiler resolves the chain",
    fx.length === 3 && fx[0].db === 3 && fx[1].attack === 0.002 && fx[1].threshold === -18
      && fx[2].len === 0.25 && fx[2].curve === "linear" && fx[2].at === null,
    JSON.stringify(fx));
  const filt = compileMMLisp(`(def-pcm s :file "/x.wav" :fx [(hpf 80) (lpf :freq 6000) (drive 6)])`, "t.mmlisp");
  const ff = filt.ir.metadata.samples[0].fx;
  check("compiler resolves hpf / lpf / drive",
    filt.diagnostics.length === 0 && ff[0].freq === 80 && ff[1].freq === 6000 && ff[2].db === 6,
    JSON.stringify(ff));
  const instant = compileMMLisp(`(def-pcm s :file "/x.wav" :fx [(comp :attack 0ms) (fade :at 0ms :len 5ms)])`, "t.mmlisp");
  check("an instant attack and a fade :at 0 are accepted",
    instant.diagnostics.length === 0 && instant.ir.metadata.samples[0].fx.length === 2,
    instant.diagnostics.map((d) => d.code).join(","));
  const cases = [
    [":fx (gain 3)", "E_SAMPLE_FX"],
    [":fx [(bogus)]", "E_SAMPLE_FX_UNKNOWN"],
    [":fx [(reverb)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(reverb :tail 0ms)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(reverb :tail 100ms :size 2)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(gain)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(comp :ratio 0.5)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(comp :bogus 1)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(crush 9)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(hpf)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(lpf 0)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(drive -3)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(fade :len 10ms :curve sin)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(normalize :peak 3)]", "E_SAMPLE_FX_PARAM"],
    [":fx [(fade :len 0ms)]", "E_SAMPLE_FX_PARAM"],
  ];
  for (const [keys, code] of cases) {
    const { diagnostics } = compileMMLisp(`(def-pcm s :file "/x.wav" ${keys})`, "t.mmlisp");
    const codes = diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
    check(`${keys} -> ${code}`, codes.length === 1 && codes[0] === code, codes.join(","));
  }
}

// the bank bakes the processed signal: a -20 dBFS tone normalized to 0 dBFS
// reaches full scale in the baked bytes, and a fade shortens the entry
{
  const bank = (effect) => {
    const { ir } = compileMMLisp(`(def-score :pcm-voices 1)
(def-pcm s :file "/x.wav" ${effect})
(pcm1 s :tempo 120 :len 4 c)`, "t.mmlisp");
    const { sampleBank } = encodeMmb(ir, { samples: { s: { data: tone(0.5, 0.1), baseRate: RATE } } });
    const bytes = sampleBank.bytes ?? sampleBank;
    const len = bytes[4 + 8] | (bytes[4 + 9] << 8) | (bytes[4 + 10] << 16) | (bytes[4 + 11] << 24);
    const off = bytes[4 + 4] | (bytes[4 + 5] << 8) | (bytes[4 + 6] << 16) | (bytes[4 + 7] << 24);
    const base = 4 + 24;
    let m = 0;
    for (let i = 0; i < len; i++) m = Math.max(m, Math.abs((bytes[base + off + i] << 24) >> 24));
    return { len, peak: m };
  };
  const plain = bank("");
  const norm = bank(":fx [(normalize)]");
  const faded = bank(":fx [(fade :at 100ms :len 100ms)]");
  check("baked bytes carry the normalize", plain.peak <= 13 && norm.peak >= 126, `${plain.peak} -> ${norm.peak}`);
  check("baked entry shrinks with a fade", faded.len < plain.len / 2, `${plain.len} -> ${faded.len} B`);
}

// an import's :fx runs ahead of each def's own; an extending sample inherits
// file, slice and both chains, overriding what it writes
{
  const kit = `(def-pcm kick :file "wav/kick.wav" :frames 900 :fx [(gain -3)])
(def-pcm snare :file "wav/snare.wav")
(def-pcm snare-kit snare :fx [(crush 6)])`;
  const { ir, diagnostics } = compileMMLisp(`(def-score :pcm-voices 1)
(import "kit/set.mmlisp" :fx [(comp) (limit)])
(def-pcm kick-short kick :frames 400)
(def-pcm snare-hot snare :fx [(gain 3)])
(def-pcm snare-own snare :file "mine.wav")
(def-fm lead init-fm :alg 4)
(pcm1 kick :tempo 120 :len 4 c kick-short c snare-hot c snare-own c snare-kit c)
(fm1 lead c)`, "t.mmlisp", { imports: new Map([["kit/set.mmlisp", kit]]) });
  const by = (n) => ir.metadata.samples.find((d) => d.name === n);
  const chain = (n) => by(n)?.fx.map((e) => e.type).join(" ");
  check("import chain composes without errors", !diagnostics.some((d) => d.severity === "error"),
    diagnostics.map((d) => d.code).join(","));
  check("import chain runs before the def's", chain("kick") === "comp limit gain", chain("kick"));
  check("def-pcm with a base inherits the file and both chains",
    by("kick-short")?.resolvedFile === "kit/wav/kick.wav" && chain("kick-short") === "comp limit gain",
    `${by("kick-short")?.resolvedFile} / ${chain("kick-short")}`);
  check("def-pcm with a base overrides what it writes", by("kick-short")?.frames === 400 && chain("snare-hot") === "comp limit gain",
    `${by("kick-short")?.frames} / ${chain("snare-hot")}`);
  check("def-pcm with a base: its own :file reads from its own folder", by("snare-own")?.resolvedFile === "mine.wav",
    by("snare-own")?.resolvedFile);
  check("an extending sample inside the kit keeps the kit's chain", chain("snare-kit") === "comp limit crush", chain("snare-kit"));
  check("an FM :extend stays an FM voice", !by("lead"));
  const src = { data: tone(0.2, 0.3), baseRate: RATE };
  const { sampleBank, entryIds } = bakeAuditionBank(ir, { kick: src }, "kick", 67);
  check("the audition bakes the one note", sampleBank.length === 0x8000 && entryIds["kick|67"] !== undefined
    && Object.keys(entryIds).length === 1, JSON.stringify(entryIds));
}

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("sample-fx: all checks passed");

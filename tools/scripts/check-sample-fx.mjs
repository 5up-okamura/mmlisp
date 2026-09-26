#!/usr/bin/env node
// Checks the def :sample `:effect` chain (live/src/sample-fx.js): each effect
// does what its name says on a synthetic signal, the compiler resolves and
// rejects `:effect` forms, an import's chain and an extending `(sample base …)` compose,
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

// the compiler: resolution and rejection
{
  const ok = compileMMLisp(`(def pcm-voices 1)
(def s (sample :file "/x.wav" :effect [(gain 3) (comp :ratio 2 :attack 2ms) (fade :len 8)]))
(pcm1 s :tempo 120 :len 4 c)`, "t.mmlisp");
  const fx = ok.ir.metadata.samples[0].effect;
  check("compiler resolves the chain",
    fx.length === 3 && fx[0].db === 3 && fx[1].attack === 0.002 && fx[1].threshold === -18
      && fx[2].len === 0.25 && fx[2].curve === "linear" && fx[2].at === null,
    JSON.stringify(fx));
  const instant = compileMMLisp(`(def s (sample :file "/x.wav" :effect [(comp :attack 0ms) (fade :at 0ms :len 5ms)]))`, "t.mmlisp");
  check("an instant attack and a fade :at 0 are accepted",
    instant.diagnostics.length === 0 && instant.ir.metadata.samples[0].effect.length === 2,
    instant.diagnostics.map((d) => d.code).join(","));
  const cases = [
    [":effect (gain 3)", "E_SAMPLE_FX"],
    [":effect [(reverb)]", "E_SAMPLE_FX_UNKNOWN"],
    [":effect [(gain)]", "E_SAMPLE_FX_PARAM"],
    [":effect [(comp :ratio 0.5)]", "E_SAMPLE_FX_PARAM"],
    [":effect [(comp :bogus 1)]", "E_SAMPLE_FX_PARAM"],
    [":effect [(crush 9)]", "E_SAMPLE_FX_PARAM"],
    [":effect [(fade :len 10ms :curve sin)]", "E_SAMPLE_FX_PARAM"],
    [":effect [(normalize :peak 3)]", "E_SAMPLE_FX_PARAM"],
    [":effect [(fade :len 0ms)]", "E_SAMPLE_FX_PARAM"],
  ];
  for (const [keys, code] of cases) {
    const { diagnostics } = compileMMLisp(`(def s (sample :file "/x.wav" ${keys}))`, "t.mmlisp");
    const codes = diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
    check(`${keys} -> ${code}`, codes.length === 1 && codes[0] === code, codes.join(","));
  }
}

// the bank bakes the processed signal: a -20 dBFS tone normalized to 0 dBFS
// reaches full scale in the baked bytes, and a fade shortens the entry
{
  const bank = (effect) => {
    const { ir } = compileMMLisp(`(def pcm-voices 1)
(def s (sample :file "/x.wav" ${effect}))
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
  const norm = bank(":effect [(normalize)]");
  const faded = bank(":effect [(fade :at 100ms :len 100ms)]");
  check("baked bytes carry the normalize", plain.peak <= 13 && norm.peak >= 126, `${plain.peak} -> ${norm.peak}`);
  check("baked entry shrinks with a fade", faded.len < plain.len / 2, `${plain.len} -> ${faded.len} B`);
}

// an import's :effect runs ahead of each def's own; an extending sample inherits
// file, slice and both chains, overriding what it writes
{
  const kit = `(def kick (sample :file "wav/kick.wav" :frames 900 :effect [(gain -3)]))
(def snare (sample :file "wav/snare.wav"))
(def snare-kit (sample snare :effect [(crush 6)]))`;
  const { ir, diagnostics } = compileMMLisp(`(def pcm-voices 1)
(import "kit/set.mmlisp" :effect [(comp) (limit)])
(def kick-short (sample kick :frames 400))
(def snare-hot (sample snare :effect [(gain 3)]))
(def snare-own (sample snare :file "mine.wav"))
(def lead (voice init-fm :alg 4))
(pcm1 kick :tempo 120 :len 4 c kick-short c snare-hot c snare-own c snare-kit c)
(fm1 lead c)`, "t.mmlisp", { imports: new Map([["kit/set.mmlisp", kit]]) });
  const by = (n) => ir.metadata.samples.find((d) => d.name === n);
  const chain = (n) => by(n)?.effect.map((e) => e.type).join(" ");
  check("import chain composes without errors", !diagnostics.some((d) => d.severity === "error"),
    diagnostics.map((d) => d.code).join(","));
  check("import chain runs before the def's", chain("kick") === "comp limit gain", chain("kick"));
  check("(sample base …) inherits the file and both chains",
    by("kick-short")?.resolvedFile === "kit/wav/kick.wav" && chain("kick-short") === "comp limit gain",
    `${by("kick-short")?.resolvedFile} / ${chain("kick-short")}`);
  check("(sample base …) overrides what it writes", by("kick-short")?.frames === 400 && chain("snare-hot") === "comp limit gain",
    `${by("kick-short")?.frames} / ${chain("snare-hot")}`);
  check("(sample base …)'s own :file reads from its own folder", by("snare-own")?.resolvedFile === "mine.wav",
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

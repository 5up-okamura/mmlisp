#!/usr/bin/env node
// The song importers on a folder of real songs, kept out of the repo: each
// file's score (and its diagnostics when compiled) is written under
// <out>/<set>/, so two sets — before and after a change — diff file by file.
//
//   node scripts/import-snapshot.mjs --out <dir> --set base [--only mdx,mgs] <root>...
//   diff -r <dir>/base <dir>/now
//
// A root is a folder searched for .mdx .mgs .muc .mid .dmf .fur, or one
// file. MDX finds its PDX, and a .muc its voice .dat and PCM .bin, beside
// it by the names the file gives. `--limit N` takes at most N files of each
// kind, spread evenly over the sorted list.
import fs from "node:fs";
import path from "node:path";
import { parseMdx, analyzeMdx, mdxToMmlisp } from "../../live/src/import-mdx.js";
import { parseMgs, analyzeMgs, mgsToMmlisp } from "../../live/src/import-mgs.js";
import { importMucom } from "../../live/src/import-mucom.js";
import { parseMidi, analyzeMidi, defaultMidiOptions, midiToMmlisp } from "../../live/src/import-midi.js";
import { analyzeTracker, defaultTrackerOptions, trackerToMmlisp } from "../../live/src/import-tracker.js";
import { parseDmf } from "../../live/src/import-dmf.js";
import { parseFur } from "../../live/src/import-fur.js";
import { compileMMLisp, collectImports } from "../../live/src/mmlisp2ir.js";

// A preset an imported score names, read from live/ (and what it imports).
const LIVE = new URL("../../live/", import.meta.url);
function importsOf(src, acc = new Map()) {
  for (const p of collectImports(src)) {
    if (acc.has(p)) continue;
    try { acc.set(p, fs.readFileSync(new URL(p, LIVE), "utf8")); } catch { continue; }
    importsOf(acc.get(p), acc);
  }
  return acc;
}
// The samples a score writes beside itself are not written here.
const UNWRITTEN = new Set(["E_PCM_SAMPLE_REQUIRED"]);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const out = opt("--out");
const set = opt("--set", "now");
const only = opt("--only")?.split(",");
const limit = Number(opt("--limit", 0));
const noCompile = args.includes("--no-compile") && args.splice(args.indexOf("--no-compile"), 1);
if (!out || !args.length) {
  console.error("usage: import-snapshot.mjs --out <dir> --set <name> [--only kinds] [--limit N] [--no-compile] <root>...");
  process.exit(2);
}

const KINDS = { mdx: /\.mdx$/i, mgs: /\.mgs$/i, muc: /\.muc$/i, mid: /\.midi?$/i, dmf: /\.dmf$/i, fur: /\.fur$/i };
const kindOf = (f) => Object.keys(KINDS).find((k) => KINDS[k].test(f));

function walk(p, acc) {
  const st = fs.statSync(p);
  if (st.isFile()) { if (kindOf(p)) acc.push(p); return acc; }
  for (const e of fs.readdirSync(p).sort()) if (!e.startsWith(".")) walk(path.join(p, e), acc);
  return acc;
}

// A file beside `file` by name, case not minding (a DOS song names its PDX
// in capitals or not); a name with no extension tries `ext`.
function beside(file, name, ext) {
  if (!name) return null;
  const dir = path.dirname(file);
  const want = [name, path.extname(name) ? null : name + ext].filter(Boolean).map((n) => path.basename(n).toLowerCase());
  const hit = fs.readdirSync(dir).find((e) => want.includes(e.toLowerCase()));
  return hit ? fs.readFileSync(path.join(dir, hit)) : null;
}

const fileName = (f) => path.basename(f);
const IMPORT = {
  mdx(f, bytes) {
    const mdx = parseMdx(bytes);
    const pdx = beside(f, mdx.pdxName, ".pdx");
    return mdxToMmlisp(mdx, { pdx, structure: true, fileName: fileName(f) }, analyzeMdx(mdx));
  },
  mgs(f, bytes) {
    const mgs = parseMgs(bytes);
    return mgsToMmlisp(mgs, { structure: true, fileName: fileName(f) }, analyzeMgs(mgs));
  },
  muc(f, bytes) {
    const text = new TextDecoder("shift_jis").decode(bytes);
    const meta = (k) => text.match(new RegExp(`^#${k}\\s+(\\S+)`, "mi"))?.[1];
    const dat = beside(f, meta("voice"), ".dat") ?? beside(f, "voice.dat");
    const pcm = beside(f, meta("pcm"), ".bin");
    return importMucom(bytes, dat, pcm);
  },
  mid(f, bytes) {
    const parsed = parseMidi(bytes);
    const a = analyzeMidi(parsed);
    return midiToMmlisp(parsed, { ...defaultMidiOptions(a), structure: true, fileName: fileName(f) }, a);
  },
  async dmf(f, bytes) { return tracker(await parseDmf(bytes), f); },
  async fur(f, bytes) { return tracker(await parseFur(bytes), f); },
};
function tracker(t, f) {
  const a = analyzeTracker(t);
  return trackerToMmlisp(t, { ...defaultTrackerOptions(a), bpm: null, fileName: fileName(f) }, a);
}

const spread = (list) => {
  if (!limit || list.length <= limit) return list;
  return Array.from({ length: limit }, (_, i) => list[Math.floor((i * list.length) / limit)]);
};

const files = [];
for (const root of args) {
  const found = walk(path.resolve(root), []);
  for (const k of Object.keys(KINDS)) {
    if (only && !only.includes(k)) continue;
    for (const f of spread(found.filter((x) => kindOf(x) === k))) files.push({ root: path.resolve(root), f, k });
  }
}

const dir = path.join(out, set);
fs.mkdirSync(dir, { recursive: true });
const counts = {};
const t0 = Date.now();
for (const { root, f, k } of files) {
  // One output a song, named by its path under its root.
  const rel = path.relative(path.dirname(root), f);
  const name = rel.replace(/[\\/]/g, "__") + ".mmlisp";
  const c = (counts[k] ??= { ok: 0, failed: 0, errors: 0 });
  let text;
  try {
    const res = await IMPORT[k](f, fs.readFileSync(f));
    text = res.source;
    const notes = [...(res.warnings ?? []).map((w) => `; warning: ${w}`)];
    if (!noCompile) {
      const { diagnostics } = compileMMLisp(res.source, name, { imports: importsOf(res.source) });
      const bad = diagnostics.filter((d) => (d.severity === "error" || /^E_/.test(d.code)) && !UNWRITTEN.has(d.code));
      if (bad.length) c.errors++;
      const byCode = new Map();
      for (const d of diagnostics) byCode.set(d.code, (byCode.get(d.code) ?? 0) + 1);
      for (const [code, n] of [...byCode].sort()) notes.push(`; diagnostic: ${code} ×${n}`);
    }
    if (notes.length) text += "\n" + notes.join("\n") + "\n";
    c.ok++;
  } catch (e) {
    text = `; import failed: ${e?.message ?? e}\n`;
    c.failed++;
  }
  fs.writeFileSync(path.join(dir, name), text);
}
console.log(`${files.length} songs → ${dir} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
for (const [k, c] of Object.entries(counts)) console.log(`  ${k}: ${c.ok} written (${c.errors} with errors), ${c.failed} failed`);

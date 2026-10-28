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
// kind, spread evenly over the sorted list. `--flat` writes the scores
// unfolded (no repeats or phrase defs), as --moves wants them.
//
//   node scripts/import-snapshot.mjs --out <dir> --moves base,now [--only mgs]
//
// compares two sets' scores compiled — both written --flat, so a note's
// tick is its time: the notes whose pitch moves (a pitch
// macro, or a glide's sweep at the key-on), and the songs where fewer do —
// a notation change that drops a move shows there, which a diff hides in
// the lines it rewrites.
//
//   node scripts/import-snapshot.mjs --out <dir> --regs base,now [--only muc]
//
// plays two sets' scores (the preview's player, 90 s each) and compares
// their register writes: a rewrite that must sound the same writes the same.
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
import { IRPlayer } from "../../live/src/ir-player.js";

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
const moves = opt("--moves")?.split(",");
const flat = args.includes("--flat") && !!args.splice(args.indexOf("--flat"), 1);
const regs = opt("--regs")?.split(",");
if (out && moves) {
  compareMoves(...moves.map((m) => path.join(out, m)));
  process.exit(0);
}
if (out && regs) {
  compareRegs(...regs.map((m) => path.join(out, m)));
  process.exit(0);
}
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
    return mdxToMmlisp(mdx, { pdx, structure: !flat, fileName: fileName(f) }, analyzeMdx(mdx));
  },
  mgs(f, bytes) {
    const mgs = parseMgs(bytes);
    return mgsToMmlisp(mgs, { structure: !flat, fileName: fileName(f) }, analyzeMgs(mgs));
  },
  muc(f, bytes) {
    const text = new TextDecoder("shift_jis").decode(bytes);
    const meta = (k) => text.match(new RegExp(`^#${k}\\s+(\\S+)`, "mi"))?.[1];
    const dat = beside(f, meta("voice"), ".dat") ?? beside(f, "voice.dat");
    const pcm = beside(f, meta("pcm"), ".bin");
    return importMucom(bytes, dat, pcm, { unfold: flat });
  },
  mid(f, bytes) {
    const parsed = parseMidi(bytes);
    const a = analyzeMidi(parsed);
    return midiToMmlisp(parsed, { ...defaultMidiOptions(a), structure: !flat, fileName: fileName(f) }, a);
  },
  async dmf(f, bytes) { return tracker(await parseDmf(bytes), f); },
  async fur(f, bytes) { return tracker(await parseFur(bytes), f); },
};
function tracker(t, f) {
  const a = analyzeTracker(t);
  return trackerToMmlisp(t, { ...defaultTrackerOptions(a), bpm: null, fileName: fileName(f), ...(flat ? { phrases: false } : {}) }, a);
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

// A score's tracks: the ticks of the notes whose pitch moves, of every
// note, and of the notes played legato.
function movingNotes(file) {
  const src = fs.readFileSync(file, "utf8");
  const { ir } = compileMMLisp(src, path.basename(file), { imports: importsOf(src) });
  const tracks = new Map();
  for (const tr of ir.tracks ?? []) {
    const sweepAt = new Set();
    const t = { moving: [], notes: new Set(), legato: new Set() };
    for (const e of tr.events) {
      if (e.cmd === "PARAM_SWEEP" && e.args?.target === "NOTE_PITCH") sweepAt.add(e.tick);
      if (!/NOTE_ON$/.test(e.cmd)) continue;
      t.notes.add(e.tick);
      if (e.args?.legato) t.legato.add(e.tick);
      if (e.args?.pitchMacro || sweepAt.has(e.tick)) t.moving.push(e.tick);
    }
    tracks.set(tr.channel ?? tr.id, t);
  }
  return tracks;
}
// A move is lost where the other set's note there does not move — but not
// a legato note the other set ties on (no note there: the same pitch, the
// head's moves going on), nor one whose move the other set has on a note
// of its own before the next one (a tie's bend it slurs to, glided).
function compareMoves(a, b) {
  const KIND = only && new RegExp(`\\.(${only.join("|")})\\.mmlisp$`, "i");
  let na = 0, nb = 0;
  const fewer = [];
  for (const f of fs.readdirSync(b).sort()) {
    if ((KIND && !KIND.test(f)) || !fs.existsSync(path.join(a, f))) continue;
    const ma = movingNotes(path.join(a, f)), mb = movingNotes(path.join(b, f));
    for (const [ch, ta] of ma) {
      const tb = mb.get(ch) ?? { moving: [], notes: new Set() };
      const moves = new Set(tb.moving);
      na += ta.moving.length; nb += moves.size;
      const keyed = [...ta.notes].sort((x, y) => x - y);
      const next = (t) => keyed.find((k) => k > t) ?? Infinity;
      const lost = ta.moving.filter((t) => !moves.has(t) && !(ta.legato.has(t) && !tb.notes.has(t))
        && !tb.moving.some((m) => m > t && m < next(t)));
      if (lost.length) fewer.push(`${f} ${ch}: ${lost.length} lost, first at tick ${lost[0]}`);
    }
  }
  console.log(`moving notes: ${na} → ${nb}; ${fewer.length} tracks lose moves`);
  for (const l of fewer) console.log("  " + l);
}

// A score's register writes as the preview plays it, a line each.
function registerLog(file) {
  const src = fs.readFileSync(file, "utf8");
  const { ir } = compileMMLisp(src, path.basename(file), { imports: importsOf(src) });
  const player = new IRPlayer(() => {});
  player.loadJSON(ir);
  return player.captureRegisterLog({ maxSec: 90 }).writes.map((w) => `${w.sec.toFixed(4)} ${w.chip ?? ""}${w.port ?? ""}:${w.addr}=${w.data ?? w.val}`);
}
function compareRegs(a, b) {
  const KIND = only && new RegExp(`\\.(${only.join("|")})\\.mmlisp$`, "i");
  let same = 0;
  const parted = [];
  for (const f of fs.readdirSync(b).sort()) {
    if ((KIND && !KIND.test(f)) || !fs.existsSync(path.join(a, f))) continue;
    const la = registerLog(path.join(a, f)), lb = registerLog(path.join(b, f));
    let i = 0;
    while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
    if (i === la.length && i === lb.length) same++;
    else parted.push(`${f}: write ${i} of ${la.length} / ${lb.length}: ${la[i] ?? "(end)"} | ${lb[i] ?? "(end)"}`);
  }
  console.log(`${same} write the same; ${parted.length} part`);
  for (const l of parted) console.log("  " + l);
}

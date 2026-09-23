// Build several scores against ONE sample bank — how a game with many songs
// ships its PCM once.
//
//   node tools/bundle.mjs <manifest.json> <out-dir> [--pal]
//
// A resident score is one MMB, and switching songs is a load (driver.md §2.3);
// what the songs can share is the bank: MMLisp_setSampleBank is remembered and
// re-published by every load. For that to work every song must number its
// samples into the SAME bank and be baked for the SAME engine image, which is
// what this does — every score plans into one bank builder (export-mmb.js
// createSampleBankBuilder), and every score is encoded for the bundle's PCM
// voice count, so a song change never reboots the Z80 either.
//
// The manifest, with paths relative to itself:
//
//   {
//     "pcmVoices": 1,            optional: the image every song boots. Default:
//                                the largest count any song needs
//     "bank": "song.smp",        optional: the bank's file name (default song.smp)
//     "songs": [
//       { "src": "stage1.mmlisp",          a score
//         "name": "stage1",                its file / rescomp symbol (default: the
//                                          source's basename)
//         "remap": { "6": 0, "7": 0 } }    optional: track id -> channel id, the
//                                          effect tracks' channels (mmb-build.mjs
//                                          remapTrackChannels)
//     ]
//   }
//
// Out: <out-dir>/<name>.mmb per song and <out-dir>/<bank>, plus the BIN lines
// a song.res needs. Each song's effect tracks are still authored IN that song
// (the language imports defs, not tracks — language.md §9.2); what the bundle
// removes is the per-song copy of the samples, which is the part that costs.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { compileMMLisp } from "../../live/src/mmlisp2ir.js";
import { encodeMmb, createSampleBankBuilder } from "../../live/src/export-mmb.js";
import { engineImage } from "../../live/src/engine-images.js";
import { loadSamplesForIr } from "./wav.mjs";
import { remapTrackChannels, readImportSources } from "./mmb-build.mjs";

const SILENCE_PAGE = 0x7f00; // the bank's top page is silence (mmb.md §10)

export function loadManifest(path) {
  const abs = resolve(path);
  const manifest = JSON.parse(readFileSync(abs, "utf8"));
  if (!Array.isArray(manifest.songs) || !manifest.songs.length) {
    throw new Error(`${path}: "songs" must be a non-empty array`);
  }
  return { manifest, baseDir: dirname(abs) };
}

/** The TRACK_TABLE of a built MMB, as [{ id, channel, flags }]. */
export function readTrackTable(mmb) {
  const u16 = (o) => mmb[o] | (mmb[o + 1] << 8);
  const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  const sections = u16(8), header = u16(10);
  for (let i = 0; i < sections; i++) {
    const at = header + i * 12;
    if (u16(at) !== 0x0001) continue;
    const off = u32(at + 4);
    const out = [];
    for (let k = 0; k < u16(off); k++) {
      const e = off + 2 + k * 5;
      out.push({ id: mmb[e], channel: mmb[e + 1], flags: mmb[e + 2] });
    }
    return out;
  }
  return [];
}

/** One bank entry, with its blob bytes (mmb.md §10). */
function bankEntry(bank, id) {
  const u16 = (o) => bank[o] | (bank[o + 1] << 8);
  const u32 = (o) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
  const count = u16(0);
  if (id >= count) return null;
  const e = 4 + id * 24;
  const base = 4 + count * 24;
  const off = u32(e + 4), len = u32(e + 8);
  return {
    flags: bank[e + 1], len, srcFrames: u32(e + 12),
    loopStart: u32(e + 16), loopEnd: u32(e + 20),
    blob: bank.subarray(base + off, base + off + len),
  };
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Build the bundle. Returns { pcmVoices, rateHz, bank, songs, diagnostics }:
 * `bank` is the 32 KB image (null when no song plays PCM); each song is
 * { name, src, bytes, ir, tracks, entryIds, diagnostics }.
 */
export function buildBundle(manifest, { baseDir = ".", frameHz } = {}) {
  const diagnostics = [];
  const diag = (severity, code, message, song = null) =>
    diagnostics.push({ severity, code, message, ...(song ? { song } : {}) });

  // ── compile every score ────────────────────────────────────────────────
  const songs = manifest.songs.map((entry) => {
    if (!entry.src) throw new Error("a song needs a \"src\"");
    const src = resolve(baseDir, entry.src);
    const name = entry.name ?? basename(src).replace(/\.mmlisp$/, "").replace(/[^A-Za-z0-9_]/g, "_");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`song name "${name}" is not a C identifier (it becomes the rescomp symbol)`);
    }
    if (!existsSync(src)) throw new Error(`no such score: ${src}`);
    const text = readFileSync(src, "utf8");
    const { ir, diagnostics: cd } = compileMMLisp(text, src, { frameHz, imports: readImportSources(src, text) });
    const errors = cd.filter((d) => d.severity === "error");
    if (errors.length) {
      throw new Error(`${entry.src}: compile failed: ${errors.map((e) => e.message).join("; ")}`);
    }
    const sampleDiags = [];
    const samples = (ir.metadata?.samples ?? []).length ? loadSamplesForIr(ir, sampleDiags) : {};
    return { name, src, entry, ir, samples, diagnostics: [...cd, ...sampleDiags], needs: pcmVoicesNeeded(ir, entry.remap) };
  });
  const names = new Set();
  for (const s of songs) {
    if (names.has(s.name)) throw new Error(`two songs are named "${s.name}"`);
    names.add(s.name);
  }

  // ── one image for every song ───────────────────────────────────────────
  // The bank is baked for one image's rate and a score boots the image its
  // header names, so all of them name the same one. Raising a song's count is
  // safe — the sequencer keeps state for three voices whatever the score uses
  // — and it buys a song change that never reboots the Z80.
  const needed = Math.max(0, ...songs.map((s) => s.needs));
  const pcmVoices = manifest.pcmVoices ?? needed;
  if (!Number.isInteger(pcmVoices) || pcmVoices < 0 || pcmVoices > 3) {
    throw new Error(`"pcmVoices" must be 0..3, got ${manifest.pcmVoices}`);
  }
  for (const s of songs) {
    if (s.needs > pcmVoices) {
      throw new Error(`${s.entry.src} needs ${s.needs} PCM voices; the bundle is ${pcmVoices} (set "pcmVoices")`);
    }
    s.ir.metadata = { ...(s.ir.metadata ?? {}), pcmVoices };
  }
  const rateHz = engineImage(pcmVoices).rateHz;
  const builder = createSampleBankBuilder(rateHz, { dedup: true });

  // ── encode each score into the shared plan ─────────────────────────────
  let anyPcm = false;
  for (const s of songs) {
    const { bytes, pcmEntryIds, diagnostics: ed } = encodeMmb(s.ir, { samples: s.samples, bankBuilder: builder });
    s.diagnostics.push(...ed);
    if (s.entry.remap) {
      const moved = remapTrackChannels(bytes, s.entry.remap);
      const missed = Object.keys(s.entry.remap).filter((id) => !moved.some((m) => m.track === Number(id)));
      if (missed.length) {
        diag("warning", "W_BUNDLE_REMAP_UNUSED",
          `remap names track ${missed.join(", ")}, which this score does not have`, s.name);
      }
      s.moved = moved;
    }
    s.bytes = bytes;
    s.entryIds = pcmEntryIds ?? {};
    s.tracks = readTrackTable(bytes);
    if (Object.keys(s.entryIds).length) anyPcm = true;
    // Standalone, for the self-test below: what this song's bank would have
    // held on its own, at the same image. This is a SECOND full encode of
    // every song — a bundle build is 2N of them — and it is worth it: nothing
    // else can tell "the bundle moved the ids" from "the bundle changed the
    // sound", which is the one thing a shared bank could silently do.
    s.alone = encodeMmb(s.ir, { samples: s.samples });
  }

  // ── finish the bank ────────────────────────────────────────────────────
  let bank = null;
  const { bytes: bankBytes, entryCount } = builder.finish(diag);
  if (anyPcm) {
    if (bankBytes.length > SILENCE_PAGE) {
      throw new RangeError(
        `the shared bank is ${bankBytes.length} bytes; exceeds the ${SILENCE_PAGE} bytes below the ` +
          `32KB window's silence page by ${bankBytes.length - SILENCE_PAGE}. Fewer or shorter samples, ` +
          `or fewer distinct notes per sample (each is a baked blob)`,
      );
    }
    bank = new Uint8Array(0x8000);
    bank.set(bankBytes, 0);
  }

  // ── self-test: bundling moved ids, never sounds ────────────────────────
  // Every (sample, note) a song plays must reach an entry whose bytes, flags
  // and loop points are exactly what the song's own bank would have carried.
  // The gate compares C against the reference on the bundled artifacts; this
  // is the check that the bundled artifacts are the song.
  for (const s of songs) {
    const alone = s.alone;
    delete s.alone;
    if (!alone.sampleBank) continue;
    for (const [key, id] of Object.entries(s.entryIds)) {
      const mine = bankEntry(bank, id);
      const theirs = bankEntry(alone.sampleBank, alone.pcmEntryIds[key]);
      const ok = mine && theirs && mine.flags === theirs.flags && mine.len === theirs.len &&
        mine.loopStart === theirs.loopStart && mine.loopEnd === theirs.loopEnd && sameBytes(mine.blob, theirs.blob);
      if (!ok) diag("error", "E_BUNDLE_ENTRY_MISMATCH", `sample entry ${key} differs from the song's own bank`, s.name);
    }
  }

  return {
    pcmVoices, rateHz, bank, entryCount, blobBytes: builder.blobLength,
    bankBytes: bankBytes.length, headroom: SILENCE_PAGE - bankBytes.length,
    songs: songs.map(({ name, src, bytes, ir, tracks, entryIds, diagnostics, moved }) =>
      ({ name, src, bytes, ir, tracks, entryIds, diagnostics, moved: moved ?? [] })),
    diagnostics,
  };
}

/** The BIN lines a song.res needs for this bundle. */
export function resLines(bundle, bankName = "song.smp") {
  const lines = bundle.songs.map((s) => `BIN ${s.name}_mmb "${s.name}.mmb" 2`);
  if (bundle.bank) lines.push(`BIN song_smp "${bankName}" 32768`);
  return lines;
}

const CHANNEL_NAMES = ["fm1", "fm2", "fm3", "fm4", "fm5", "fm6", "sqr1", "sqr2", "sqr3", "noise"];
export const channelName = (id) =>
  CHANNEL_NAMES[id] ?? (id >= 16 && id <= 19 ? `fm3-${id - 15}` : id >= 20 && id <= 22 ? `pcm${id - 19}` : `ch${id}`);
const channelId = (name) => {
  const i = CHANNEL_NAMES.indexOf(name);
  if (i >= 0) return i;
  let m = /^fm3-([1-4])$/.exec(name);
  if (m) return 15 + Number(m[1]);
  m = /^pcm([1-3])$/.exec(name);
  if (m) return 19 + Number(m[1]);
  return -1;
};

/* The PCM voices a song needs ONCE ITS TRACKS ARE WHERE THE REMAP PUTS THEM.
 * An effect authored on pcm2 and pointed at pcm1 plays on voice 0, so the
 * compiler's own count (the highest pcmN written, which is also what the IR's
 * metadata carries) would boot an image a voice too big. A `(def pcm-voices N)`
 * in a bundled score is superseded by the manifest's "pcmVoices". */
function pcmVoicesNeeded(ir, remap) {
  let n = 0;
  (ir.tracks ?? []).forEach((t, i) => {
    const id = t.id ?? i;
    const ch = remap?.[id] ?? channelId(t.channel ?? "");
    if (ch >= 20 && ch <= 22) n = Math.max(n, ch - 19);
  });
  return n;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const pal = args.includes("--pal");
  const [manifestPath, outDir] = args.filter((a) => !a.startsWith("--"));
  if (!manifestPath || !outDir) {
    console.error("usage: node bundle.mjs <manifest.json> <out-dir> [--pal]");
    process.exit(2);
  }
  const { manifest, baseDir } = loadManifest(manifestPath);
  const bundle = buildBundle(manifest, { baseDir, frameHz: pal ? 50 : 60 });
  mkdirSync(outDir, { recursive: true });
  const bankName = manifest.bank ?? "song.smp";
  for (const s of bundle.songs) {
    writeFileSync(join(outDir, `${s.name}.mmb`), s.bytes);
    const tracks = s.tracks.map((t) => {
      const m = s.moved.find((x) => x.track === t.id);
      return `${t.id}:${m ? `${channelName(m.from)}->` : ""}${channelName(t.channel)}`;
    }).join(" ");
    console.log(`${s.name}.mmb  ${s.bytes.length} B  ${s.tracks.length} tracks — ${tracks}`);
    for (const d of s.diagnostics) console.warn(`    ${d.severity}: ${d.message}`);
  }
  if (bundle.bank) {
    writeFileSync(join(outDir, bankName), bundle.bank);
    console.log(`${bankName}  ${bundle.entryCount} entries, ${bundle.blobBytes} B of blobs, ` +
      `${bundle.headroom} B of headroom, baked for the ${bundle.pcmVoices}-voice image`);
  } else {
    console.log(`no PCM in any song: no bank (every song boots the ${Math.max(1, bundle.pcmVoices)}-voice image)`);
  }
  for (const d of bundle.diagnostics) console.warn(`  ${d.severity}: ${d.message}`);
  console.log(`\nres/song.res:\n  ${resLines(bundle, bankName).join("\n  ")}`);
  if (bundle.diagnostics.some((d) => d.severity === "error") ||
      bundle.songs.some((s) => s.diagnostics.some((d) => d.severity === "error"))) process.exit(1);
}

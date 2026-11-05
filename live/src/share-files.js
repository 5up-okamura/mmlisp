// A share link's files (File > Share…): the imports and wavs a score names
// that a viewer cannot fetch — they came from the user's folder, an archive
// or a drop — carried beside the link as one ZIP, the score at its root. The
// viewer opens it as a folder read in memory (source-folder.js), so every
// path resolves as it did for the sharer. The Worker (live/worker/) checks a
// bundle with bundleEntries before it stores one.
//
// A wav travels as the machines play it: mono, 16-bit, at most CARRY_RATE —
// above every rate a machine's sample part bakes at but the 2A03 DMC's top
// one — so a kit costs tens of KB, not the recording's MB. One a def counts
// in frames (`:offset`, `:frames`) or plays at a `:rate` of its own keeps its
// rate: there a frame is a frame of the file.
import { decodeWav, resample } from "./wav-decode.js";
import { writeZip, readArchive } from "./archive.js";

export const CARRY_RATE = 22050;
export const MAX_SHARE_FILES = 256 * 1024; // the ZIP's bytes
export const MAX_SHARE_ENTRIES = 64;
const MAX_UNPACKED = 8 * 1024 * 1024; // a bundle, never a bomb

/** A path a bundle may hold: relative, inside its folder, a score or a wav. */
export const carriedPath = (path) =>
  typeof path === "string" && /\.(mmlisp|wav)$/i.test(path) && !/^[a-z]+:|^\//i.test(path)
  && !path.split(/[\\/]/).some((s) => s === ".." || s === "");

/** `mono` (Float32Array, −1..1) as a 16-bit mono WAV at `rate` Hz. */
export function wavBytes(mono, rate) {
  const out = new Uint8Array(44 + mono.length * 2);
  const v = new DataView(out.buffer);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + mono.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, mono[i])) * 32767), true);
  return out;
}

/**
 * A wav as it travels: `bytes` (the file) brought to mono 16-bit, and down to
 * CARRY_RATE unless `keepRate`; the file itself where that is no smaller and
 * its rate stands.
 */
export function carriedWav(bytes, { keepRate = false } = {}) {
  const { data, sampleRate } = decodeWav(bytes);
  const rate = keepRate ? sampleRate : Math.min(sampleRate, CARRY_RATE);
  const out = wavBytes(rate === sampleRate ? data : resample(data, sampleRate, rate), rate);
  return rate === sampleRate && out.length >= bytes.length ? bytes : out;
}

/**
 * The ZIP a share carries: the score (`name`, `src`) at its root and `files`
 * ([{ path, bytes }], ready to travel) beside it, as many as fit
 * MAX_SHARE_FILES — the largest left out first. Returns { zip, carried,
 * left }: zip null when nothing is carried; carried and left [{ path, size }].
 */
export async function shareBundle(name, src, files) {
  const kept = files.filter((f) => carriedPath(f.path)).sort((a, b) => a.bytes.length - b.bytes.length);
  const left = files.filter((f) => !carriedPath(f.path));
  const score = { path: (name || "untitled.mmlisp").split("/").pop(), bytes: new TextEncoder().encode(src) };
  while (kept.length) {
    const zip = await writeZip([score, ...kept]);
    if (zip.length <= MAX_SHARE_FILES && kept.length <= MAX_SHARE_ENTRIES) {
      const size = (fs) => fs.map((f) => ({ path: f.path, size: f.bytes.length }));
      return { zip, carried: size(kept), left: size(left) };
    }
    left.push(kept.pop());
  }
  return { zip: null, carried: [], left: left.map((f) => ({ path: f.path, size: f.bytes.length })) };
}

/**
 * A stored bundle's entries [{ path, size, crc }] sorted by path, or null
 * when `bytes` is not one this app writes: a ZIP of at most
 * MAX_SHARE_ENTRIES scores and wavs on carried paths, within the size limits.
 */
export async function bundleEntries(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_SHARE_FILES) return null;
  let entries;
  try { entries = await readArchive(new Blob([bytes])); } catch { return null; }
  if (!entries.length || entries.length > MAX_SHARE_ENTRIES + 1) return null;
  if (!entries.every((e) => carriedPath(e.path) && e.crc != null)) return null;
  if (entries.reduce((n, e) => n + e.size, 0) > MAX_UNPACKED) return null;
  return entries.map(({ path, size, crc }) => ({ path, size, crc })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

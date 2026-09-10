// THE PSG STREAMS A P1 IMAGE REPLAYS (R25 §57.3).
//
// Two of them, and they answer different questions:
//
//   controlled  a sequence written here, exercising a two-byte tone period, a
//               one-byte attenuation and the noise control register, so the
//               order and the values can be matched against a reference that
//               is not the image (step 3)
//   corpus      the 276 bytes `m3-macro-multi` really emits over 97 frames, in
//               the frame and sub-tick order the reference driver put them in
//               (step 4). Produced by `corpus.mjs`; if it has not been run, the
//               controlled stream stands in and the case says so.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, "psg-corpus.json");

// SN76489 bytes. $80|ch<<5|0<<4 latches a tone period's low four bits and the
// plain byte that follows carries the high six; $90|ch<<5|att is one byte on
// its own; $E0|n is the noise control.
const tone = (ch, period) => [0x80 | (ch << 5) | (period & 0x0f), (period >> 4) & 0x3f];
const att = (ch, a) => [0x90 | (ch << 5) | (a & 0x0f)];
const noise = (n) => [0xe0 | (n & 0x07)];

/** Frames of bytes -> the table the 68000 walks: a count, then that many. */
const pack = (frames) => frames.flatMap((f) => [f.length, ...f]);

export const CONTROLLED = pack([
  [...att(0, 0), ...tone(0, 0x0fe)],          // channel 0 loud, a low note
  [...att(1, 4), ...tone(1, 0x07f)],          // channel 1 quieter, an octave up
  [...tone(0, 0x1fd)],                        // …and a period that moves
  [...att(2, 8), ...tone(2, 0x03f)],
  [...noise(4), ...att(3, 2)],                // the noise channel, on
  [...noise(7), ...att(3, 15)],               // …white noise from tone 2, then off
  [...att(0, 15), ...att(1, 15), ...att(2, 15)],
]);

export function psgStream(which = "controlled") {
  if (which !== "corpus") return CONTROLLED;
  if (!existsSync(CORPUS))
    throw new Error("psg-stream: run `node drv/experimental/dac-stream/corpus.mjs` first"
      + " — the corpus stream is measured from the reference driver, not written here");
  const j = JSON.parse(readFileSync(CORPUS, "utf8"));
  const frames = [];
  for (const w of j.writes) { (frames[w.f] ??= []).push(w.b); }
  return pack(Array.from({ length: j.frames }, (_, i) => frames[i] ?? []));
}

# mucom88 PCM import (part K / ADPCM) — "one WAV + slicing" (approved plan)

Status: **approved 2026-07, not started.** Design settled with the user; no code
written yet. Implement from here in a separate implementation chat.

## Context (the "why")

mucom88 songs put drums/PCM on part **K** (YM2608 ADPCM-B). The importer
currently throws it away — `DROP_PARTS = { G:"rhythm", K:"ADPCM" }`
(live/src/import-mucom.js:27) — so every imported song loses its drums.

The PCM lives in a **separate `*pcm.bin`, not the voice `.dat`**; the MML points
at it with a `#pcm <file>` header tag. One bank holds **up to 32 samples**.
MMLisp's `(def … :sample :file "…")` is **one file = one whole sample**
(`parseSampleDef`, live/src/mmlisp2ir.js:1398, has no slicing keys). That
mismatch is the crux of this work.

## Decisions (settled with the user — do not revisit)

- **One WAV + slicing.** Decode the whole bank to a single mono WAV; add
  `:offset` / `:frames` to the language so many defs slice one file. (Rejected:
  writing N separate wavs; inlining base64.)
- **Part K only.** Part G (rhythm) stays dropped — its sounds come from the OPNA
  rhythm ROM, not the PCM bank, so an MD port would need drum samples from
  elsewhere.

## mucom88 PCM bank format (verified against 4 corpus banks)

```
0x0000..0x03FF   directory: 32 entries x 32 bytes
0x0400..EOF      ADPCM body, samples concatenated, 4-byte aligned
```

Entry (little-endian): `0x00` name (16 B, space- or NUL-padded); `0x1A` `pcmopt`
= default volume; `0x1C` `pcmstart` = start **in 4-byte units** relative to the
body start (0x400); `0x1E` `whl` = length in **BYTES**. Entry present iff the
first name byte != 0. `0x10`/`0x12` (adrl/adrh) are **legacy — ignore**.

- Encoding: **YM2608 ADPCM-B (Delta-T), 4-bit, HIGH nibble first, 16000 Hz**.
  The YM2612 has no ADPCM unit, so the importer **must decode** to linear PCM.
  No loop points in the format. Max 32 samples.
- MML: `#pcm <file>` tag; part **K**; **`@n` selects the sample, 1-based**;
  **`v` is 0-255** on K (vs 0-15 on FM/SSG).
- Corpus: /Users/okamura/Library/CloudStorage/Dropbox/GameDev/VGM/mucom88/mucom88win_yk2mml191012/
  (26 .muc each with `#pcm`; shinobipcm.bin 6 entries, mucompcm.bin 16, sq1pcm.bin 25).

## Stage 0 — Calibration (do first; everything depends on it)

**(a) ADPCM-B decoder** (no reference implementation in-repo; inverse of mucom's
encoder):

```
acc = 0; step = 127
per nibble (HIGH nibble first):
  mag = n & 7; sign = n & 8
  delta = (step * (mag*2 + 1)) >> 3
  acc  += sign ? -delta : +delta        // clamp to [-32768, 32767]
  step  = (step * TABLE[mag]) / 64      // TABLE = {57,57,57,57,77,102,128,153}
  step  = clamp(step, 127, 24576)
```

**State resets per sample** (`acc=0, step=127`). The bank therefore **cannot** be
decoded as one linear pass: decode each entry independently and **concatenate
the outputs**. Consequently a def's `:offset` is an **accumulated output-frame
count**, not `pcmstart*4*2`.

**(b) Pitch base.** MMLisp uses `rate = 2^((midi-60)/12)` and clamps MIDI to
36-84 (mmlisp2ir.js:610-687). The corpus K parts use **only o1/o2**, so an
FM-style `:oct N-1` would put every drum at MIDI <= 31 and trip
`W_PCM_PITCH_CLAMP` on every note.

Fix the K octave shift (**hypothesis +3**: o1 -> `:oct 4`, o2 -> `:oct 5`) and
absorb the entire residual into the emitted `:rate`:
`:rate = round(16000 * 2^(-SEMITONE_OFFSET/12))`. `:rate` is defined as "the C4
playback rate in Hz" (docs/language.md:1075), so any constant pitch offset is
expressible there — calibration collapses to **one integer**, found by ear
A/B-ing against mucom88win. Name it `MUCOM_PCM_BASE_RATE` with a comment
recording the derivation.

## Stage 1 — Language: `:offset` / `:frames`

live/src/mmlisp2ir.js
- `parseSampleDef` (:1398-1449): add `offset:null, frames:null`; parse with the
  existing `parseIntLike`. Reject `offset < 0` / `frames <= 0` with a new
  **`E_SAMPLE_SLICE`** diagnostic (same shape as `E_SAMPLE_FILE` at :1443).
- IR metadata (:4778-4790): add `offset` / `frames` to `samples[]`.

**Unit is frames** (not bytes) — consistent with `:loop-start` / `:loop-end`.

**Loop points are slice-relative** (frames from the slice start, not the file
start): a def *is* a sample, so its loop points must not move when `:offset`
changes. The worklet already clamps loop points against `data.length` (= the
slice length), so **no worklet change** (live/worklet.js:329-387).

Docs in the same pass: docs/language.md §16 (:1058-1087) — two key rows, a short
"sample banks" paragraph, and the slice-relative loop note; docs/ir.md §2.2
(:70-80) — two rows; docs/roadmap.md — move K out of "Priority 3 — dropped
channels" (G stays).

## Stage 2 — Slicing at load (**two call sites**)

`syncPcmSamplesToWorklet` alone is **not enough**: `pcmSampleBlobsForMmb`
(live/index.html:2222) calls `decodePcmSample` directly and would bake the whole
90 KB bank into each of 25 MMB blobs. Factor out one helper:

```js
function sliceDecodedSample(decoded, def)   // -> { data, sampleRate }
```

Put it next to `audioBufferToMono` (index.html:2095-2107) and call it from
**both** `syncPcmSamplesToWorklet` (:2259-2265) and `pcmSampleBlobsForMmb`
(:2218-2231). `_pcmSampleCache` stays keyed by **path** (:2073, :2160) so
`decodeAudioData` runs once per bank and every def shares it — that is the whole
point of this design.

- **Use `.slice()`, not `.subarray()`**: `postMessage` (:2277) structured-clones
  a TypedArray *view* by copying its entire backing ArrayBuffer — 25 views would
  send the bank 25 times.
- Clamp `offset`/`frames` to the decoded length and `log(...)` on overflow (the
  existing pattern at :2270-2276). Skip empty slices.
- **Node CLI**: `compileSamplesIntoIr` (tools/scripts/mmlisp2ir.js:231-299) —
  slice `decoded.mono` right after `parseWavFile` (:257) and **before**
  `applyVolumeEffect`, so a reverb tail cannot bleed in from the neighbouring
  sample. Set `compiled.frames` from the slice length (:285).

## Stage 3 — New module `live/src/mucom-pcm.js`

Separate file (vs. putting it in import-mucom.js next to `parseVoiceDat`):
import-mucom.js is 1216 lines of pure *text -> text* with no binary or DSP
concern; the bank is binary decode with zero MML knowledge. Splitting keeps the
ADPCM-B decoder exercisable standalone from node (which the calibration needs)
and reusable if PMD/FMP import ever lands (same OPNA ADPCM-B).

```js
export function parseMucomPcmBank(bytes)
// -> { entries: [{ index, name, defaultVol, start, length }] }

export function decodeAdpcmB(bytes, start, length)   // -> Float32Array (2 frames/byte)

export function decodeMucomPcmBank(bytes)
// -> { pcm: Float32Array, sampleRate: 16000,
//      entries: [{ index, name, defaultVol, offset, frames }] }  // offset = running frame count

export function mucomPcmBankToWav(pcmBytes)          // -> { bytes, entries }   (for the UI)
```

## Stage 4 — WAV writer

`encodeWav(L, R, sampleRate)` already exists (live/src/export-wav.js:140) but is
hardcoded stereo. It has exactly **one caller** (`renderWav` :202, which passes
both channels), so **generalize it minimally**: treat `R === null` as mono
(`channels = R ? 2 : 1`; `blockAlign` and the interleave loop follow). Existing
call unaffected. (drv/tools/wav.mjs only has `loadWav` — nothing to reuse.)

## Stage 5 — Importer (live/src/import-mucom.js)

1. **`#pcm` tag**: header block (:605-616) `else if (key === "pcm") meta.pcmFile = val;`;
   init `pcmFile:null` in `meta` (:532).
2. **Part routing**: add `PCM_PARTS = { K: "pcm1" }` (next to :18-19); reduce
   `DROP_PARTS` (:27) to `{ G:"rhythm" }` — **but only when a bank was supplied**.
   With no `.bin` there are no defs and every K note raises
   `E_PCM_SAMPLE_UNDEFINED`. So: `parseMucom` always tokenizes K (tempo
   recovery), and `mucomToMmlisp` drops the K forms with the existing warning
   when `parsed.pcm` is absent — **exactly the two-pass shape the `.dat` already
   uses**.
3. **Leave the drop list `"RyKkSPwsV"` (:443) alone** — no conflict. Part
   dispatch happens on the **line prefix** in `parseMucom`; a `K` inside a body
   (`K5` = key transpose) stays dropped as it is for FM. Record as a known gap.
   *Related latent bug*: the part regex `^([A-K]+)` (:659) reads `KC112` as parts
   K + C. The corpus always writes `K C112` with whitespace, so it is latent —
   worth a comment now that K is live.
4. **`tokenizeBody`**: no change for `@n` — the `isSsg` guard (:283-290) already
   falls through to `push({t:"voice", n})` for non-SSG parts.
5. **`renderOps`** (:745-972), new ctx fields `isPcm` / `pcmLabels` / `pcmRegistry`:
   - `case "voice"`: when `isPcm`, map `op.n` (**1-based**) to the def name and
     push it as a **bare symbol** (mmlisp2ir.js:3290-3293 rebinds the track's
     sample on a bare reference — the shortest output). Register it in
     `pcmRegistry` so **only referenced samples** get defs (the rule
     `mergeDatVoices` (:1180-1195) already applies to the 256-voice .dat).
     Unknown `@n` -> warnOnce + skip (like the `definedVoices` guard at :925).
   - `case "vel"` / `"velAdj"`: keep `ctx.vel` in mucom's **0-255** domain for K
     and convert at emit: `:vel clamp(round(v*15/255), 0, 15)`. **PCM vel is
     0-15** (mmlisp2ir.js:663; worklet `velGain = vel/15`, worklet.js:333-336).
     **Lossy** — the corpus's v16-v130 collapses onto `:vel 1`-`:vel 8`, so v40
     and v45 become equal. There is no finer PCM volume path today: **record it,
     do not add one.**
   - `case "octSet"` (:776-779): refactor to `ctx.oct = op.n + ctx.octShift`
     (FM `-1` / SSG `0` / PCM `+3`). Same at the octave prefix (:1108).
   - `case "pan"` (:781-784), `"detune"`, `"lfoSet"`, `"porta"`, the `E`
     envelope: warnOnce + drop for K. PCM is a soft-mix voice on the fm6 DAC
     (live/src/ir-utils.js:813-817) and owns no FM channel, so `:pan` is meaningless.
6. **PCM def registry + splice**: follow `echoRegistry` verbatim (:1031,
   :898-914, :1055, :1090-1096):
   ```lisp
   (def kick :sample :file "shinobipcm.wav" :rate 16000 :offset 0 :frames 3904)
   ```
7. **Tempo recovery**: with K rendered, its ops land in `scoreItems` instead of
   `droppedOps`. `findFirstTempo` scans `scoreItems` before `droppedOps`
   (:697-700) and the K line is first in source order in the corpus — so tempo
   still resolves, from a better source. Duplicates are harmless (`case "tempo"`
   only emits when `op.bpm !== ctx.tempo`, :964-966). **When the bank is absent
   and K is dropped, keep feeding its ops to `droppedOps`** so tempo survives.
8. **Name sanitization**: real names include `kick`, `kick+snare`, `hand clap`,
   `C.Cymbal`, `808openhihat`, and `º°×½` (Shift-JIS half-width katakana). Add
   `sanitizeSampleName(name, index)`: lowercase; `[^a-z0-9]` -> `-`; collapse and
   trim dashes; prefix a leading digit; empty -> `pcm<index>`. Reuse the
   collision loop in `buildVoiceLabels` (~:995-1004) and dedupe **across the
   sample, voice, and `*n` macro namespaces** — they share one MMLisp namespace.
9. **Signature**: `importMucom(bytes, datBytes = null, pcmBytes = null)` (:1197).

## Stage 6 — UI (live/index.html)

- Extend `_mucomSong` (:1797) to `{ bytes, fileName, datBytes, pcmBytes }`.
- `importMucom88()` (:1816-1856): reuse the existing 4096-byte Shift-JIS head
  sniff (:1837-1839) with `/^#pcm\s+(\S+)/im`; chain a `.bin` picker after the
  `.dat` one via `pickFileWithInput(['.bin'])` (:1702-1742), same
  optional/cancel-tolerant shape; re-convert with all three inputs.
- **Make the bank WAV reachable** (`_sourceDir` is granted **read-only**, picker
  at :2354, so the importer cannot write next to the score):
  1. **Immediate audition, no disk round-trip.** After decoding, pre-seed
     `_pcmSampleCache` (:2073) under the exact key the score resolves to.
     `loadMucomSource` (:1799-1812) calls `clearSourceDir()`, so
     `resolveSamplePath` (mmlisp2ir.js:243-249) returns the bare
     `"shinobipcm.wav"` — seed that key with `{ data, sampleRate: 16000 }` and
     `decodePcmSample` (:2146-2162) returns it before touching
     `sampleBytesFromSourceDir` or `fetch`. **The song plays the instant it imports.**
     *Cache hygiene*: `_pcmSampleCache` is never cleared today, so a seeded entry
     could later shadow a real file of the same name — add a `clear()` (or
     targeted delete) to `clearSourceDir()` and to Open Folder.
  2. **Persistence.** Immediately offer a save using the `exportVgm` pattern
     (`showSaveFilePicker` + `createWritable`, :2496-2508, `<a download>`
     fallback), `suggestedName = "<bankbase>.wav"`, and `log(...)` telling the
     user to save it beside the score and use `File > Open Folder…` (same
     guidance as :2270-2276).
- Add `importMucomPcmBank()` next to `importMucomVoiceBank()` (:1861-1882) plus a
  menu item (:133-134) — the escape hatch when the chained picker is blocked,
  mirroring the voice-bank item.

## Risks / edge cases

| Risk | Notes |
| --- | --- |
| **ADPCM-B decode correctness** | #1 risk; no reference decoder in-repo. Wrong step table / nibble order -> noise. Mitigate: per-entry state reset, save the WAV, **listen**, A/B vs mucom88win. |
| **Pitch base unknown** | Corpus uses only o1/o2; FM-style `-1` clamps everything. Absorbed into one calibrated `:rate` (Stage 0b). |
| **`v` 0-255 -> `:vel` 0-15** | 16 steps; v40/v45 collapse. Loudness balance vs FM needs a listening test. |
| **`pcmopt` semantics** | Bank default volume (32/50/100). Unclear whether `@n` resets `v` to it; the corpus writes `o1v40 … @1`, implying it does **not** -> ignore it, except to seed the opening `:vel` when the part sets no `v` before its first `@n`. Cheap, reversible. |
| **Name collisions / non-ASCII** | `kick+snare`, `º°×½`. Sanitize + dedupe across sample/voice/`*n`. |
| **3 soft-mix slots vs 32 samples** | **Not a constraint.** K is a single monophonic part -> `pcm1` only; many samples per track already works via bare-symbol rebinding. |
| **Bank WAV size** | Worst case sq1pcm: 89 KB body -> 179,552 frames x 2 B ~= 350 KB. Fine. |

## Verification

No automated test suite (CLAUDE.md) — scripted compiles plus playback.

1. **Bank parser, all 10 banks**: 32-entry directory parses; for every present
   entry `0x400 + pcmstart*4 + whl <= file.length`; no overlaps.
2. **Decoder sanity**: per entry `frames === whl*2`, no NaN, peak in (0, 1], DC
   near zero (a wrong step table drifts). Save `shinobipcm.wav` and **listen to
   entry 1 ("kick")** — the only real check.
3. **WAV round-trip**: feed the emitted WAV back through `parseWavFile`
   (tools/scripts/mmlisp2ir.js:12-56); assert frames, `sampleRate === 16000`,
   `channels === 1`, bit-exact vs the decoder output.
4. **Corpus compile sweep**: `importMucom(muc, dat, pcm)` + `compileMMLisp` over
   all 46 .muc; **zero** error diagnostics (no `E_PCM_SAMPLE_UNDEFINED`, no
   `E_SAMPLE_SLICE`) and **no `W_PCM_PITCH_CLAMP`** (if it fires, Stage 0b is wrong).
5. **Slice isolation**: each `metadata.samples[].compiled.frames` equals its
   `:frames`, not the whole bank — the regression that catches the
   `pcmSampleBlobsForMmb` oversight.
6. **Playback**: `cd live && npm run serve`; import `sin002.muc` (6-entry bank,
   `@1/@2/@6`) — should audition immediately from the seeded cache. Then
   `sin008.muc` (5 samples, dense rebinding) and `Etrian_Odyssey` (25-entry bank).
   Confirm kick/snare are identifiable, no cross-sample bleed at slice boundaries
   (the tell for an off-by-one in the offset accumulation), and K stays in sync
   with FM across the loop.
7. **Tempo regression**: for a song whose only `t`/`T` is on K, compile **with and
   without** the `.bin` and assert the same `:tempo`.
8. **MMB export**: `exportMmb` on a K song -> `buildSampleBank`
   (live/src/export-mmb.js:1114-1140) receives slice-length blobs, no missing-blob
   diagnostic.

## Files

- `live/src/mucom-pcm.js` — **new** (bank parser + ADPCM-B decoder + WAV)
- `live/src/import-mucom.js` — `#pcm` tag, K routing, renderOps, PCM def registry, signature
- `live/src/mmlisp2ir.js` — `:offset`/`:frames` in `parseSampleDef`, IR metadata
- `live/src/export-wav.js` — generalize `encodeWav` to mono
- `live/index.html` — `sliceDecodedSample` shared helper (two call sites), UI chain, cache seed, save
- `tools/scripts/mmlisp2ir.js` — slice on the CLI bake path
- `docs/language.md` §16 / `docs/ir.md` §2.2 / `docs/roadmap.md` — same pass

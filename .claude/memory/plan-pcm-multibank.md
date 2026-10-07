# Multi-bank PCM — the decisions, and what is open

Shipped 2026-10-07 (`feat/pcm-multibank`). What it does is documented:
`docs/pcm-multibank.md` (composers, SGDK users), `docs/driver.md` §5, §5.4,
§6.3 and §11, `docs/mmb.md` §4 and §10.3; the gates are `drv/README.md`. This
file keeps only what those do not say: why it is shaped as it is, the
measurements the decisions rest on, and what is still open.

## Decisions

- **Capacity first (user, 2026-10-05).** More than 32 KiB of samples in one
  song, and voices sounding from different banks at once, over runtime pitch.
  Pitch stays baked per note; runtime pitch (a per-voice read-ahead resampler)
  was studied and not chosen. A single blob still cannot span banks
  (32,512 B); cross-bank streaming of one sample was not built.
- **A block renderer, not the light engine's stream.** Each voice in turn
  builds 16 output samples into the ring after writing the Z80's bank register
  (nine serial writes, LSB first); the DAC plays a block built earlier (lead
  32). The bank switch is what costs the rate: one or two banked voices run at
  the two-voice light rate (10.1 kHz NTSC / 10.0 kHz PAL), three at 6.65 /
  6.59 kHz. A never-started voice reads cartridge bank 0 at `$7F00` with the
  silence rung, so what it reads does not matter; a parked voice reads its
  own data bank's silence page, which the exporter guarantees is zero.
- **The bank travels with the START** (`PCM_START_BANKED`, op 6, bank u16):
  the sequencer resolves the absolute ROM bank from the `.smp`'s address, the
  host sends a bank only when it changed (two STORE ops for voices 0–1 at
  `$1c–$1f`, one for voice 2 at `$21`: seven bits cover the 4 MiB aperture).
  Protocol version 14.
- **The banked host transport**: PCM stores and FM writes in one ordered
  queue (no separate lane), a fresh FIFO read before each plan, up to five
  transfers a frame, the whole 16-pair physical grab reserved (its IDLE
  padding too), PSG released by video frame, a late grab restored rather than
  invalidated. Short unmodulated FM channel groups (≤ 8 writes; never FM3 or
  FM6; never with a global write other than `$22/$24–$28/$2B` in the frame;
  never a split F-number pair) go ahead of bulk patch uploads —
  `banked_writes` in `68k/mmlpairs.c`, its reference `prioritizeFmNotes` in
  `tools/pairs-model.mjs`. Ordinary FM3 is excluded because the converter
  does not know CH3's mode; a probe showed FM3's key-on queued at index 31
  behind a 29-write patch where FM2's sat at index 2.
- **Export**: a single-bank overflow re-enters as multi-bank and says so
  (`I_MMB_MULTIBANK`, with the rate — a one-voice song drops from 14.4 to
  10.1 kHz); `--multibank` / `multibank: true|false` force or forbid it.
  Decreasing-length first-fit placement is adopted only when it saves a whole
  bank; otherwise the sequential offsets stay, so ids and layouts are stable.
- **ROM**: code spans only (zero padding omitted), one shared 2,560-byte
  clamp/rung table block at `$1100` for every image, PAL and NTSC binaries
  shared when identical. The single-bank images changed to the same layout.
- **Memory and docs**: `docs/` is for composers and driver users; research,
  listening logs and per-song benchmarks live here or in ignored `drv/out/`
  artefacts — whose counts are run-specific, not acceptance numbers.

## Measurements the decisions rest on (BlastEm, the SGDK example app)

- Integrated two-voice stress run, 45 s: FM key-on interval error p95
  24.8 ms, max 36.8 ms; bus loss 0.72%. One voice, 30 s: p95 18.4 ms, max
  33.9 ms. A minimal app (no UI) did not improve the maximum.
- After the optimisation pass (empty-transfer poll skipped, shared tables,
  cached FM classification, packing): three-voice NTSC p95 13.2 ms, max
  20.2 ms, bus loss 0.45%; PAL p95 14.9 ms, max 31.7 ms. The classifier
  change does not account for the PAL outlier (a build without it measures
  the same); dense-command jitter is workload- and phase-dependent.
- The user accepted the precomputed two-voice prototype's timing by ear
  (noting a slightly slow passage near 7 s). **The integrated build has had no
  listening test** — do not claim that acceptance for it.
- Service rates (NTSC, pairs/s): single-bank 1,027 / 1,011 / 1,109 for one,
  two, three voices; banked 6,952 / 1,896 / 1,663. The host caps copies at
  16 pairs a video frame single-bank (959/s) and 80 banked (4,794/s).
- Single-bank images with more expander steps assemble and fit the 4,352-byte
  code allocation: one voice 8 → 32 steps (4,107 pairs/s), two 8 → 10, three
  8 → 9, at unchanged rates; two at 12 and three at 10 fail placement. Not
  adopted: the single-bank host's 16-pair cap would still bind, and the
  fences, mirrors and settling would have to be redone.
- A banked three-voice variant with the expander's B half inlined (13 pairs a
  lap instead of 12, a longer generation fence) was assembled and not
  adopted: raw throughput does not establish better onset latency.

## Open

- **Onset jitter under write bursts** — what the user hears as tempo wobble
  where several channels change voice or play at once: decided in
  `plan-onset-jitter.md` (no transport increase; fewer pairs ahead of each
  key-on instead). Why it happens: pairs carry no deadline, so rendering
  ahead (`MMLISP_LEAD`) does not spread writes; the host may not send a
  future frame; once released the Z80 executes pairs serially.
- **Not run on real hardware**; heavy DMA / game workloads not measured.
- **The banked converter has no byte-for-byte JS twin** in `pairs-gate`: it is
  covered by `tests/banked-pairs.c`, the BlastEm run (`banked:sgdk`) and
  `prioritizeFmNotes` as the FM-order reference. `tests/multibank-3v.mmlisp` is
  baselined in `ab-baseline.json` with two known PSG-timing divergences of the
  same class as the other known ones, unrelated to PCM.
- The `multibank:*` tools (`multibank-score/run/rom/render/timing.mjs`) are
  the standalone prototype that preceded the integration, kept for engine-level
  experiments; `multibank:gate` is the instruction-level gate and runs in
  `verify:all`.

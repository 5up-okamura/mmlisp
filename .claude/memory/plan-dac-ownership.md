# fm6 / PCM DAC ownership

Status: **SUPERSEDED 2026-07 — the "last KEY-ON wins" plan below is on hold.**
A follow-up review changed the premise on two counts; read this banner before
acting on anything under it. See [[plan-driver-features]] for the live direction.

## What changed (read first)

1. **mucom is no longer a driver-policy input.** The whole runtime-arbitration
   case rested on "21 of 42 mucom songs collide on fm6+DAC." With mucom dropped
   as a reason to shape driver policy, that justification is gone — the importer
   is just one more voice that decides per-song whether to cede fm6 or move to
   sqr1. No corpus forces the driver's hand.
2. **The budget wall that made 18 B look unaffordable is gone.** DAC ownership
   was entangled with the 13 B resident ceiling; the overlay split (commit
   b069ef8) freed it to 178 B. Cost is no longer the deciding factor.

**New direction (settled, not yet planned in detail): a STATIC rule, not runtime
arbitration.** A PCM-using song cedes fm6, decided at **compile time** — the most
promising shape is `:prio` treating fm6 and pcm1-3 as parallel layers of the one
physical channel (language.md §channel-forms), so the collision is resolved in the
compiler and the driver arbitrates **zero bytes** (and reclaims the ~12 B DAC
release path). Open sub-problems for that: `:prio`'s single-monophonic-stream
flatten can't yet express "fm6 vs the *group* {pcm1,pcm2,pcm3}" exclusion; and
runtime-injected SE (START_TRACK, not in the compiled score) can't be flattened
at compile time, so SE-over-PCM is a hardware fact (fm6 already spent), not a
policy `:prio` can pre-decide.

The measured facts below (cost table, JS-vs-Z80 gate mechanics) stay useful; the
**decision** — last-KEY-ON-wins — does not. Do not implement the staged plan
without re-confirming direction.

---

## (Superseded) original plan — last KEY-ON wins

Status when written: **approved 2026-07, not started.** Design settled with the
user; implement in a separate chat, in the staged order below.

## Context (the "why")

On the Mega Drive, FM channel 6 and the DAC are the same channel — `$2B` bit 7
picks which one reaches the mixer. Something must therefore lose whenever a
score wants both, and today **PCM wins unconditionally**: a PCM note-on writes
`$2B=$80` and fm6 goes silent until every voice ends
(drv-player.js `_pcmNoteOn` / the tail of the mix; Z80 `process_pcm`). An fm6
note-on does not interact with the DAC at all.

That is not a corner case for imports. **21 of the 42 mucom `#pcm` songs use
both part J (fm6) and part K (ADPCM)** — half of them. mucom rides an OPNA,
where FM6 and ADPCM are separate hardware; on the MD they collide by
construction. Worse, mucom offers six FM parts (A–C, H–J), so a 6-FM + ADPCM
song has no free channel to move to: **something must be dropped in those 21
songs, and no policy avoids that.**

The current policy also wastes work: while the DAC is on, fm6's note-ons and
register writes still execute and are simply inaudible.

## Decision (settled with the user — do not revisit)

**Last KEY-ON wins.** Whoever keys on most recently owns the channel:

- **PCM note-on** → take the DAC (`$2B=$80`), fm6 goes quiet. *(today's
  behaviour, unchanged)*
- **fm6 note-on** → release the DAC (`$2B=$00`) and **stop all three PCM
  voices**, fm6 sounds.
- **all PCM voices ended** → release the DAC, fm6 returns. *(unchanged)*

fm6 killing **all** of pcm1–3 (not just one) is intended: they are three soft-mix
voices summed into the one DAC, so the channel is theirs collectively or not at
all.

Rejected: *PCM always wins* (today — fm6 drops out on every drum hit, ~60–400 ms,
throughout half the corpus) and *fm6 always wins* (a bass line plays constantly,
so the drums would be near-permanently muted — strictly worse).

## Cost — measured, not guessed

| | Impact |
| --- | --- |
| **MMB format** | **None.** Runtime behaviour only; no opcode, no field. |
| **Z80 cycles** | **Net negative (i.e. cheaper).** `process_pcm` already opens with `call pcm_any_active / ret z` — no active voice means the whole 175-tick loop and its 175 `$2A` writes are skipped. fm6 taking the channel therefore idles the driver's single most expensive routine. |
| **Z80 size** | A few bytes on the fm6 note-on path: `pcm_any_active`, clear each `PV_ACT`, `$2B=0` via the change-only `ym_write`. All three already exist. |
| **driver.md §14** | **Spec change** — DAC ownership must be written down. |
| **drv ≡ Z80 gate** | **Re-take.** PCM currently passes 17 traces 0-diff; the policy changes what they record. |

Be honest in the writeup: most of the cycle saving is *because the drums stopped*
— it is paid for in music, not free. What is genuinely free is that no channel
computes inaudible notes any more.

## Stages

1. **JS reference + live** — `live/src/drv-player.js` and `live/worklet.js`.
   Add the fm6 note-on hook (release DAC + deactivate voices); the worklet's
   `fm6IsDac` follows from the same state rather than `_pcmVoices.length > 0`.
   **Gate: listen to the 21 J+K songs in the live player before going further** —
   if fm6-cutting-drums turns out worse than today's fm6 dropouts, this is where
   the decision reverses, and reversing after stage 3 costs two gate re-takes.
2. **Spec** — `docs/driver.md` §14: state the ownership rule and that fm6
   preempts all three voices. Note it in `docs/roadmap.md`'s mucom section too,
   since it is what makes the 21 J+K songs playable-ish.
3. **Z80** — `drv/src/ovl_pcm.z80` / `mmlispdrv.z80`, on the fm6 note-on path.
   Then `cd drv && npm run verify:all` must be 0-diff against the updated
   drv-player.

## Verification

- 21 J+K songs play with drums *and* an audible fm6, each preempting the other.
- A PCM-only song is unchanged (no fm6 notes → no preemption).
- An fm6-only song is unchanged (no PCM → `process_pcm` still early-outs).
- `cd drv && npm run verify:all` → 0 trace mismatches.
- Watch the budget: `drv/tools/budget.mjs` should show `process_pcm` *falling* in
  a J+K song, since fm6 idles it.

## Files

- `live/src/drv-player.js` — `_pcmNoteOn`, the mix tail, a new fm6 note-on hook
- `live/worklet.js` — `_startPcmVoice`, `fm6IsDac`, `_mixDacSampleNative`
- `drv/src/ovl_pcm.z80` / `drv/src/mmlispdrv.z80` — `process_pcm`,
  `pcm_any_active`, the fm6 note-on path
- `docs/driver.md` §14, `docs/roadmap.md`

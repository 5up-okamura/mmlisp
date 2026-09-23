# SE (sound effects) — the decisions behind it, and what is still open

**Status (2026-09-22): SE is shipped on the driver.** `mmlispseq.c` carries the
port (suspend / snapshot / restore, priority, the PCM overwrite, both reclaim
hooks — END_OF_TRACK and stop-track), the SGDK host has `MMLisp_startSe`, and
`m3-se` / `m3-se-prio` are in the c-gate list, byte-identical in NTSC and PAL,
and `drv/sgdk/example/demo.mmlisp` exercises all three kinds (FM steal with
priority, PSG steal, PCM overwrite) from the SGDK example's own buttons.
The behaviour is `docs/driver.md` §2.5 and `drv-player.js` (`_startTrack` with
`asSe`, `_snapshotChannel`, `_restoreChannel`, `_reclaimSe`); this file holds
only what neither records.

## Why it is shaped this way (the user, 2026-07-19)

1. **SE is authored in MMLisp** — a short score in the same language.
2. **Concurrency = bundle the control data, share the sample bank.** Chosen
   *explicitly over* runtime cross-MMB banking, which stays deferred
   (`driver.md` §11). If several scores ever become resident at once
   ([plan-multi-score.md](plan-multi-score.md)), this choice is worth
   re-opening — but it is not a prerequisite.
3. **Restore re-keys mid-sustain** rather than waiting for the next note-on:
   dropping audio was the thing to avoid, and an FM envelope cannot resume.
4. **Suspend, not evict.** Eviction stops the owner; the BGM could never resume.
5. **Triggering is a host call, not a source marker** — no language, IR or
   MMB change, and the hard part (suspend/restore) is the same either way.
6. **PCM restore is not time-synced** — restarting the loop from the sample's
   head was accepted; advancing by the elapsed SE frames is a later refinement
   (the engine keeps no position the host can read back, so it would have to
   be counted on the 68000).

## The modulator-leak bug — FIXED 2026-09-23. Kept for the reasoning.

**Resolved:** claiming a channel now clears its macro binds, running slots and
sweeps (`clear_channel_modulators` / `_clearChannelModulators`), the SE
snapshot carries the binds, and the restore puts them back and re-triggers.
The user ruled for re-trigger over resuming the running slots, and accepted
losing an in-flight sweep: *"作曲者が長いスイープのチャンネルをSEに割り当てない
ようにすること"* — an authoring rule, not a driver limit. Gated by
`tools/claim-gate.mjs` (`driver.md` §12.2a), which was verified to FAIL on all
three cases with the fix disabled. What follows is why it was shaped that way.

## The bug as found — a CHANNEL-OWNERSHIP bug, not an SE bug (2026-09-23)

Macro binds are sticky per-channel state (`binds[]` / `bind_count[]` in the C,
`_macroActive[]` in the reference) and **nothing clears them but the stream's
own MACRO_CLEAR.** Not `start_track`, not `stop_track`, not the SE paths. The
running slots (`macro_slots[]`) are the same, and `process_macros` steps them
without consulting any track state, so a channel's macros keep writing whoever
owns it.

Three leaks, all measured on 2026-09-22/23 by diffing the slot stream against
the same score with the macro line removed:

| Leak | Hook it needs | Measured |
| --- | --- | --- |
| Displaced BGM's macro plays the SE | SE claim | a run of `$A4/$A0` the no-macro score never emits |
| SE's macro plays the restored BGM | SE end | 38 differing frames after the SE was over |
| **Evicted track's macro plays the track that took the channel** | START_TRACK claim | 29 differing frames, **no SE involved** |

The third is the one that reframes it: plain eviction (§2.2) already does this,
so the fix belongs at CLAIMING A CHANNEL, beside the vel/vol/gate reset that is
already there, not at an SE-specific hook. The SE path then needs only the
snapshot, for the same reason it snapshots the note: the BGM's bind on a target
is destroyed the instant the SE binds that target, because a bind REPLACES per
target — so "turn the SE's macros off at SE end" cannot put the BGM's back.

A fourth, found while fixing: **a displaced part's SWEEP keeps writing too**
(a long `:vol (linear …)` under a stolen channel faded the effect). Same root,
so sweeps are cleared by the same rule rather than by a second mechanism.

**No byte gate can see any of this**: c-gate compares the C against the
reference, and both were wrong in the same way (`driver-decisions.md` §6). The
twin-score diff is what catches it, and is now `claim-gate`.

Two boundaries worth not re-litigating: **stopping** a track must NOT clear,
because a release-region macro runs after key-off and is the decay tail; and
the restore re-binds but does not re-run a sweep, because a sweep has a
position and the note it shaped re-attacked.

## Two things the port taught

- The reference's channel-claim level reset used to reset only the live `vel`,
  not `velBase`; since every note-on copies base → live, the SE's first note
  took the BGM's velocity. Fixed in `drv-player.js` (the C had it right). Only
  an SE could expose it: START_TRACK gates always set their own velocity.
- The gates' `.cmds.json` sidecar (`autoStart: false`, `remapChannels`,
  `commands`) is applied by `c-gate.mjs` — the remap patches the MMB's track
  table so both players read the same file, and `gate_main --idle` starts
  nothing. It stands in for the bundler.

## Still to do

- **The bundler — DONE as `drv/tools/bundle.mjs` (2026-09-23)**, but not as
  first imagined. What a game with many songs needed was not "BGM + SE in one
  MMB" (one source plus `remap` does that) but "N scores over ONE sample bank",
  see [plan-multi-score.md](plan-multi-score.md). The effect tracks are still
  written in each song's source, on spare channels, and pointed at the BGM's
  channels by the manifest's `remap`.
- **Importable tracks — a language question, open.** `import` brings in defs
  only, by design ("tracks are songs, not defs", language.md §9.2). A game
  with twenty songs and thirty effects repeats thirty track lines per song.
  Text concatenation at build time was rejected: it breaks `:file` and import
  resolution relative to the effect file. If it is wanted, it is a language
  form — `(import "se.mmlisp" :tracks)` or a new `include` — and needs the
  user's ruling, not a tooling workaround.
- **Overlapping SEs on different channels** are already possible in the C —
  the snapshot lives on each suspended track, not in one slot — but no gate
  fires two at once. Add one when a score needs it.
- **Time-synced PCM restore** (decision 6), if a composition ever needs it.

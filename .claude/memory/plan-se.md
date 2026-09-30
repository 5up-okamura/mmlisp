# SE (sound effects) — the decisions behind it, and what is still open

**Status (2026-09-30): SE is shipped and is `def-se` only.** An effect is a
def the game plays by number (PLAY_SE / STOP_SE, `MMLisp_playSe`); its parts
may sit on any channel, CH3's operator and CSM tracks included (CH3 is taken
whole). Restore puts back what the chip had — the patch from the register
shadow, the noise mode, CH3's mode and Timer A. The behaviour is
`docs/driver.md` §2.5 and `language.md` §9.3; the code is `drv-player.js`
(`_playSe`, `_snapshotChannel`, `_restoreChannel`, `_ch3Claim`…) and its C
twin. This file holds only the reasons and rulings neither records.

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

## What the lifecycle actually needed (2026-09-23, second pass)

A review of the committed port found five more, all one shape: **the suspend
ledger was only maintained on the happy path.** A part is suspended and an
effect holds a pointer to it; every path that ends the effect or takes the
channel away has to keep those two facts in step, and only two of the five
paths did.

- START_TRACK over a channel an effect holds evicted the EFFECT and **stranded
  the suspended part** — no reclaim runs, so it never dispatched again and the
  effect kept a pointer that would restore it over a stranger later.
- A **faded-out** effect never reclaimed: `process_fades`' terminal stop and
  `mml_fade_track(…, 0)` were the only stop paths that skipped it.
- `mml_stop_track` matched on `running`, so a **suspended part could not be
  stopped** — the game asked for silence and the effect's end brought it back.
- A preempting effect **inherited** the pointer without the preempted one
  dropping it, and a start that took neither branch (an effect on a free
  channel) kept whatever it displaced last time.

The rule that resolves all of them, now in `driver.md` §2.5: *a part is
suspended exactly while one running effect names it.* `release_suspended`
dissolves the arrangement wherever a channel changes hands outside a reclaim.

**The gate for it is not a twin diff.** A stranded part is SILENT, so no
comparison of register traffic can see it. `claim-gate` therefore also checks
the invariant above directly, every frame of every schedule with an effect in
it. Verified by mutation: disabling any one of the four fixes fails it.

Two boundaries worth not re-litigating: **stopping** a track must NOT clear,
because a release-region macro runs after key-off and is the decay tail; and
the restore re-binds but does not re-run a sweep, because a sweep has a
position and the note it shaped re-attacked.

## Two things the port taught

- The reference's channel-claim level reset used to reset only the live `vel`,
  not `velBase`; since every note-on copies base → live, the SE's first note
  took the BGM's velocity. Fixed in `drv-player.js` (the C had it right). Only
  an SE could expose it: START_TRACK gates always set their own velocity.
- The gates' `.cmds.json` sidecar (`autoStart: false`, `commands`) is applied
  by `c-gate.mjs`, and `gate_main --idle` starts nothing. Since 2026-09-28
  every SE gate is a def-se score driven by PLAY_SE / STOP_SE (the old
  track-id START_SE and the sidecar `remapChannels` are gone — the user:
  "def-seに一本化したい / 古い実装は必要ない"); the conversion was checked
  byte-identical, NTSC and PAL, on all fifteen scores.

## Rulings since def-se (the user, 2026-09-28 … 30)

What the docs state as fact, recorded here for WHO decided it and why:

- **def-se, one way only.** "実際にゲームに使えるドライバーにしたいので解決は必要"
  and "def-seに一本化したい / 古い実装は必要ない". What made it necessary was
  more than repeated lines: an SE was addressed by TRACK ID, which shifts with
  each song's track count, so a game could not hold a constant; and a song
  using every channel had no spare one to author an SE on (16 tracks also
  truncated silently → MML_MAX_TRACKS 32). Three rulings: the bundle injects
  one effects file into every song (over each song importing it); one effect
  may have several parts; the def-se carries a default priority the host may
  override. Mine, not ruled on: an effect is a DEF (so `import` carries it and
  "tracks are songs" stands); a part is on the channel it takes (no remap); an
  effect keeps its own tempo so it sounds alike in every song.
- **CH3 taken whole** — offered finer schemes, the user: "3ch丸ごとで良いです".
  The snapshot is one `MMLCh3Snap` on the sequencer, not per track. It also
  closed an older hole: ch2 had no owner, so an SE on plain fm3 never
  suspended the song's fm3.
- **Restore from the register shadow**, not a voice id: "レジスタの控えから
  戻す方法にしてください". Found because partial `def-fm` voices (no VOICE_SET)
  were not rebuilt; it also brought back mid-song `:tl`/`:pan`.
- **2026-09-30 review**, asked "他に何か修正点は": the noise mode and a
  dissolved CSM hold were fixed as bugs; for `:master`/`:lfo-rate`, offered
  refuse-vs-restore, the user: "SEでは:master, :lfo-rateは使わない" — the
  compiler refuses them (song-wide: the game's fader, the chip's one LFO).

Every one of these is gated in `claim-gate` (invariant or before/after state
case) and was checked by mutation — disabling the fix fails its case.

## Open

- **An SGDK/BlastEm run** of the def-se example has not happened (no
  toolchain in the cloud container). `npm run sgdk:gate:se` is ready for a
  machine that has one.
- **Two effects at once on different channels** work (each suspended track
  keeps its own snapshot) but no gate fires two together. Add one when a
  score needs it.
- **Time-synced PCM restore** (decision 6), if a composition ever needs it.
- **Other song-wide state an effect could touch**, if the language grows
  some: the rule is refuse it in def-se (as `:master`/`:lfo-rate`) unless it
  belongs to a channel the effect takes, in which case the snapshot carries it.

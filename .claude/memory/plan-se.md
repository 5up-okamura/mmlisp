# SE (sound effects) — design in progress (2026-07-19)

Status: **design agreed; sequencing step 1 (sample-bank separation) LANDED
2026-07-19.** VOICE_SET Part 1 (the FM restore mechanism) landed earlier; this
is the "Part 2" SE/BGM story. Supersedes the terse item 2 in
[[plan-driver-features]] and the Part 2 note in [[plan-voice-set]].

## Step 1 — sample-bank separation: LANDED (2026-07-19)

PCM blobs moved out of the 32KB control MMB into a **separate ROM bank** the
mixer latches per frame. Verified: all PCM gates (m2-pcm, m2-pcmloop,
m3-pcm-softmix, m3-fm6-pcm) byte-identical; verify:all 33 TRACE MATCH + ab-gate
34 scores. What changed:
- **Format/exporter**: SAMPLE_BANK is no longer MMB section 0x0004 — `encodeMmb`
  returns `{ bytes, sampleBank, diagnostics }`; the blob image (entry table +
  blobs, same layout) is a separate artifact. mmb.md §10 updated.
- **Driver**: new global `G_SMP_BANK` (MB_RING+$39, host-published, 0=none;
  boot-preserved alongside the overlay-bank globals — the ovl_boot clear range
  was extended to skip $34..$3a). `pcm_note_on` (ovl_pcm) latches G_SMP_BANK to
  read the entry (entries+blobs at WINDOW=0x8000 in that bank), stashes base_rate
  in G_PV_RATE across the restore, then restores G_MMB_BANK for the PCM_MULT_FRAME
  LUT read. `process_pcm` latches G_SMP_BANK for the mix loop (the only window
  read there is the sample byte) and restores G_MMB_BANK before returning. G_SB
  retired; ovl_mmb no longer locates SAMPLE_BANK. Resident +12 B (two latch pairs
  in process_pcm), 64 B free.
- **drv-player**: `loadMMB(bytes, sampleBankBytes)` reads blobs from the separate
  array (no banks in JS — the DAC trace stays bit-identical).
- **Emulator/harness**: run-trace serves `sampleBank` when `bankReg ==
  sampleBankNumber` (default 2) and pre-seeds G_SMP_BANK; verify/ref-trace/
  mmb-build plumb it; the mmb-build CLI writes a `.smp` sidecar.
- **Browser**: MMLispDRV-backend playback passes the sample bank to loadMMB;
  File > Export MMB saves a `.smp` sidecar. **Not verified here** (CodeMirror CDN
  blocked) — live-verify PCM on the drv backend + the export sidecar.

**Cycle caveat**: the per-frame bank latch (18 BANK_REG writes ×2/frame when PCM
active) is a hot addition on the dominant PCM path — trace-correct in emulation,
needs hardware cycle validation.

Remaining Part 2 steps below (suspend/restore core, PCM restore, bundler).

## Settled with the user (2026-07-19)

1. **SE is authored in MMLisp** (same language as BGM; a short score).
2. **Concurrency model = bundle control + shared sample bank.** A game is many
   MMBs (1 file = 1 song/SE is the *authoring* unit, not a per-game limit). But
   the driver windows **one MMB per 32KB bank** (driver.md §5.3), so BGM + SE
   can only sound together if they share a window. Decision:
   - **Control data** (event streams + voice/macro/LUT tables — small, ~KBs) of
     the BGM and the SEs it can trigger are **bundled at build/link time into one
     ≤32KB control MMB** (one window). No runtime cross-MMB banking (that hot,
     hardware-gated path — plan-driver-features item 3 — is avoided for now).
   - **PCM sample data** (large — the real 32K-wall term) moves **out of the
     control window into a dedicated, game-shared sample bank**. MMB PCM voices
     reference a global sample id; the mixer latches the sample bank per voice
     per frame (amortized over ~525 samples/frame — far lighter than full
     WIDE_OFFSETS mid-stream banking). This is plan-driver-features item 5's
     "narrower option: bank SAMPLE_BANK independently," now the chosen path. It
     is **needed for any PCM-heavy content**, not SE-specific; SE just forces it.
3. **Held sustain notes must be restored mid-sustain** — waiting for the next
   note-on would drop audio. So restore re-keys a note that was sounding when the
   SE stole its channel.
4. **The displaced BGM track suspends** (stops dispatching) for the SE's
   duration, then resumes — it must NOT keep dispatching (its writes would
   overwrite the SE's sound).

## The gap in the current driver

Channel ownership already exists (`CHS_OWNER` = owning TCB index; eviction in
`ovl_setup` `st_claim`). But today when a new track claims an occupied channel,
`st_claim` **stops the previous owner** (`channel_off` + previous TCB
`T_STATUS = 0` idle + clears its MB_TSTAT). That is right for scene transitions,
**wrong for SE** — the BGM track can never resume. SE needs a *suspend + restore*
variant instead of *evict*.

`T_STATUS`: 0 idle / 1 playing / 2 held (len=0). Add **3 = suspended** (has state,
does not dispatch, does not own its channel).

## Design (SETTLED with the user 2026-07-19)

### A. Triggering an SE — decision: option 2, runtime `START_SE` command

- **`START_SE` = mailbox cmd 7** (NOT a source `:se` marker — the user chose the
  runtime command; it needs no language/IR/MMB change, and the hard suspend/
  restore core is identical either way). Same path as START_TRACK (walk the MMB
  track table, init a TCB) but for each channel the SE claims, the current owner
  is **suspended + snapshotted**, not evicted; the SE track's TCB is marked
  isSe (a runtime flag) so SE-end can find and restore the displaced owner.
- **SE-end reclaim = the SE track's EOT OR STOP_TRACK** (single-shot SEs
  self-clean at EOT; held/looping SEs end on STOP). Hooks `d_eot` and
  `stop_track`: before `CHS_OWNER=$ff`, if this track is an isSe that displaced a
  suspended owner, restore that owner (snapshot back, `CHS_OWNER`→owner,
  `T_STATUS`→1) and re-key its held note.
- `T_STATUS`: 0 idle / 1 playing / 2 held → add **3 = suspended**.

### B. Snapshot + restore (mid-sustain) — decision: essential fields

Snapshot the displaced channel's live state on suspend; restore + re-key on
reclaim. **Essential fields only** (VOICE_SET reconstructs the FM patch):

- **FM (fm1-6):** snapshot note/vel/vol/gate/pitch + **current voice id** (needs a
  new `CHS_VOICE` byte written by VOICE_SET / the voice-ref path) + active macro
  ids. Restore = VOICE_SET the id, re-apply level, **re-key** via the existing
  `apply_keyon` (mmlispdrv.z80:1838 = channel_off + key_on of `CHS_NOTE`).
- **PSG (sqr1-3/noise):** snapshot tone period + 4-bit att (+ macro state).
  Restore = re-write period + att, re-key. Light.
- **PCM (pcm1-3): loop restore IS required (user, 2026-07-19).** PCM is
  soft-mixed (no `CHS_OWNER` — pcm ids 20-22 skip the channel block), so the
  suspend/snapshot happens at a **different hook**: when an isSe track's
  `pcm_note_on` is about to overwrite an **active** `G_PCMV[vi]` voice (a BGM
  loop), snapshot the 17-B voice struct (PV_ACT/BASE/LEN/INC/**POS**/LOOPE/LOOPL);
  on SE-end restore the 17 B. Restoring `PV_POS` resumes the loop **from where it
  was = no dropout** (not time-synced; advancing pos by the elapsed SE frames is
  a later refinement). Re-key semantics for FM/PSG is a re-attack (FM EG can't
  resume mid-way) — matches the "don't drop the note" goal.

Snapshot storage: a small fixed pool (start N=2-3 SE-stolen channels). FM/PSG use
CH_STATE free bytes ($02-04/$07/$09-0b) or a `G_BASE` block ($5e..$66 free); PCM
uses a per-voice 17-B snapshot slot.

### CRITICAL FINDING — drv-player has NO track lifecycle (2026-07-19)

**This is the real scope driver.** `live/src/drv-player.js` (the verify:all
reference) has **no `_startTrack`, no channel ownership, no eviction** — every
track is auto-started in `_reset` (`running:true` from frame 0) on statically
assigned channels; START_TRACK/STOP_TRACK are Z80-only (JS treats them as
auto-driven, `_applyMailbox` drv-player.js:1606 has no case 1/2). So to verify SE
at zero tolerance, the **entire suspend/restore lifecycle must be BUILT in
drv-player too**: suppress the SE track's auto-start, add a `case 0x07` START_SE
(suspend the same-channel running track + snapshot + start the SE), and reclaim
on SE EOT/STOP (restore + re-key), for FM/PSG/PCM. drv-player derives "the
channel's owner" from the running track whose channelId matches (no CHS_OWNER
needed there). This is the heavy part — the "option 2 is light" estimate was only
true of the Z80/toolchain side.

Harness (run-trace.mjs): auto-starts ALL tracks at frame 0 (:108-118). The SE
gate must NOT auto-start the SE track. Since option 2 has no source marker, add a
harness auto-start control — e.g. the `.cmds.json` drives the initial
START_TRACKs explicitly and a flag disables auto-start-all — and BOTH players
apply the same suppression. postCommand already forwards arbitrary cmd bytes, so
cmd 7 posts without harness change; only the two drivers need the handler.

### Implementation hooks (from the 2026-07-19 map — start here next session)

- Z80 mailbox: `mbox_drain` mmlispdrv.z80:372; reserved gate `cp 7`→`cp 8` at
  :419-420; route cmd 7 like cmd 1 (ovl_mmb + a setup path with a suspend flag).
- Z80 start/evict→suspend: `ovl_setup.z80` start_track :9-130, **evict block
  :99-116** is what SE replaces with suspend+snapshot; claim/defaults :117-122.
- Z80 reclaim: `d_eot` mmlispdrv.z80:609-629 and `stop_track` ovl_cmd.z80:18-48
  (before `CHS_OWNER=$ff`). Re-key: `apply_keyon` :1838; `key_on` :1386.
- Z80 layout: TCB free byte **$1d** (displaced-owner index); T_FLAGS free bits;
  CH_STATE gaps $02-04/$07/$09-0b; T_STATUS add 3.
- drv-player: `_applyMailbox` :1606 (add case 7), `_reset` tracks :408-427
  (suppress SE auto-start), END_OF_TRACK :738-745 + `_stopTrack` :1640-1645
  (reclaim), `_noteOn`/`_keyOn` :585/:655 (re-key), `freshFmChannel` :124-152.
- PCM: `pcm_note_on` (ovl_pcm.z80) snapshot hook; `G_PCMV` struct (17 B).

### C. Sample-bank separation (the 32K-wall enabler)

- **MMB/toolchain:** SAMPLE_BANK moves out of the per-song control MMB. The PCM
  voice def carries a **global sample id**; a game-wide sample bank (its own ROM
  bank(s)) holds all PCM blobs (BGM + SE), deduplicated. Needs: a sample-id
  namespace across bundled sources, a link step that emits the shared bank, and
  MMB PCM-voice records that reference id → (bank, offset, len).
- **Driver:** `pva_fetch` reads from a window address today (`PV_BASE + idx`).
  Change: the mixer **latches the sample bank once per voice per frame** before
  fetching that voice's chunk, then restores the control/MMB bank for dispatch.
  Cost is per-voice-per-frame (amortized), not per-sample. Hot-path but light;
  **hardware cycle validation required** (the PCM mixer is the dominant term).
- This unblocks bundling (control data is small) AND lifts the 32K wall for
  PCM-heavy songs generally.

### D. Verification

- `verify:all` Z80≡drv-player at zero tolerance, as always. New gates:
  - `m3-se`: a BGM with a sustained FM note + a sustained PSG note; an SE steals
    each mid-sustain; assert the BGM note resumes (re-key + patch/period restored)
    when the SE ends. Both ports.
  - a PCM-SE-over-PCM-BGM gate once sample-bank separation lands.
- The bundler + sample-bank link steps are compile-time → node-testable here.
- The mixer sample-bank latch is hot → trace-correct in emulation, cycles on
  hardware.

## Budget note (not the blocker)

SE restore is **cold** (per suspend/reclaim event) → rides an overlay, ~0
resident. New RAM: `CHS_VOICE` (1B/channel) + the snapshot pool. The sample-bank
latch is the only hot addition (light, hardware-validated). Resident 64B free
(after step 1) + overlay slot headroom + the sample bank frees the control
window. So bytes are not the constraint — the work is the drv-player lifecycle
build (CRITICAL FINDING) + the Z80 mirror + the harness/gate.

## SE priority (N=1 + priority) — LANDED (2026-07-20)

Decided with the user: **register SEs share one channel (N=1 slot); same-channel
contention is resolved by priority — a new SE preempts an equal/higher-priority
one and is dropped by a lower one.** Priority is a runtime `START_SE` arg (mailbox
cmd 7, **a1 = priority**; no MMB change). Cross-channel register SE is out of scope
(that's the N=2 pool, deferred). `verify:all` **35 TRACE MATCH** (both ports) +
`m3-se-prio` gate: f30 SE-A steals, f45 SE-B (prio 10) preempts, f60 SE-C (prio 3)
dropped, then the BGM restores when SE-B ends.

- **Model (both ports).** On START_SE the channel's owner is either a BGM (fresh
  steal — snapshot+suspend) or an already-playing SE. If an SE: `new < owner.prio`
  → **drop** (the old SE keeps playing, and — important — the drop must NOT
  channel_off it); `new ≥` → **preempt** (silence+stop the old SE, keep SE_SNAP so
  the still-suspended BGM is restored only when the *last* SE ends). Priority lives
  on `T_PRIO` (TCB $1d) / `trk.sePrio`. **a1 is overloaded** (bank for START_TRACK,
  priority for START_SE) so ovl_setup zeroes T_BANK for SE (always the control MMB).
- **The reorg that made it fit — ovl_setup SPLIT (option A).** start_track was the
  fattest overlay; the priority logic overran even the PCM-grown 320 B slot. Split
  into **ovl_setup** (TCB fill, 145 B) + **ovl_claim** (index 9 — ownership / steal /
  priority / PCM snapshot, 235 B). mbox_drain now chains ovl_mmb → ovl_setup →
  ovl_claim (IX + G_* cross in place; load_overlay preserves IX). The max overlay
  dropped back to ovl_rare (274), so **OVERLAY_SLOT/G_PCMV went back to $17DE/$17AB
  — the slot is 274 again and resident recovered to 52 B free** (the PCM reorg's
  d_param_sweep→ovl_sweep eviction stays; it's what freed the room for the split's
  wider claim overlay). Budgets now healthy: resident 52 B, stack reserve 13 B.

## PCM per-channel volume (bit-shift, vel+vol+master) — LANDED (2026-07-20)

Decided with the user: **`:vel` + `:vol` + global `:master` compose to a per-voice
attenuation the soft-mixer applies as an arithmetic right shift (`sra`) — cheap,
per channel.** Mechanism is bit-shift (the user's directive: multiply is too heavy
per sample). The compose sums each control's steps-below-unity onto the 6 dB grid:
`n = (15−vel)+(31−vol)+(31−master)`, `shift = min(7, round(n/3))`, `mute =
vol==0 || master==0`. This best-fits the FM/PSG 2 dB/step ladder (measured error
max 2.1 dB / RMS 0.57 dB vs the true linear gain), so **the same `:vel`/`:vol` mean
the same loudness on PCM as on FM/PSG**. `vel` never mutes (floors at shift 5 =
−30 dB when vol/master unity); `vol`/`master` 0 is true silence. No new opcode —
the exporter already emits `PARAM_SET VEL` before every `PCM_NOTE_ON`, and `:vol`/
`:master` are ordinary `PARAM_SET`s.

- **Deferred (user):** a general-purpose **ROM** LUT (no RAM) to replace the bit-
  shift with a smoother/exact gain — *after* the bit-shift version is confirmed.
  Not needed yet.
- **Deferred (worklet gap):** the live `worklet.js` still applies only `:vel`
  (continuous 2 dB/step) + the UI fader to PCM — it does **not** compose the score's
  `:vol`/`:master` or mute on 0. So the browser preview won't match the driver for
  pcm `:vol`/`:master` until the worklet is aligned (own task).
- **State (both ports).** `PV_SHIFT` (voice-struct offset 17): bits0-2 = `sra`
  count, bit7 = mute. `PCM_V_SIZE` 17→18; `G_PCMV` $17AB→$17A8. Compose inputs
  `vel`/`vol` live in globals (`G_PCM_VEL`/`G_PCM_VOL`, G_BASE+$60/$63) so master
  can recompose without growing the struct; the PCM SE snapshot (`PCM_SNAP`, now
  struct 18 + vel + vol = 20 B) restores them so a stolen BGM voice keeps its
  volume state. drv-player keeps `vel`/`vol`/`shift`/`muted` on the voice object
  (the `{...v}` SE snapshot carries them).
- **Hot path.** `pcm_voice_acc` / `_pcmFrame`: test PV_SHIFT bit7 → muted adds 0
  (still advances, matching FM); else `sra` bits0-2 times with a shift-0 fast path.
  The compose (`pcm_compose_shift`, subtract-by-3 divide) runs once per `PARAM_SET
  VEL`/`VOL` and for all 3 voices on `MASTER` — never per sample. `ps_master`
  recomposes every voice; `ps_pcm` handles pcm `VOL`.
- **Budget reorg.** The compose (~108 B resident) overran the G_PCMV ceiling.
  Funded by evicting **`start_sweep`** (~76 B) to `ovl_sweep` — its only caller is
  `d_param_sweep`, already in that overlay, so it's thematically clean cold code.
  Resident back to **20 B free**; `ovl_sweep` 78→206 B (slot 274 unchanged).
- **Gates.** `m3-pcm-vol` (vel sweep) + `m3-pcm-volmix` (vol sweep, `:vol 0` mute,
  live `:master` recompose over a loop). `verify:all` green both ports; 38 ab
  scores (the volmix master-on-idle-FM TL divergence is the known ir↔drv axis,
  frozen).

## Sequencing

1. **Sample-bank separation** — **DONE 2026-07-19** (see the "Step 1" section at
   top). The 32K-wall enabler for PCM.
2. **Suspend/restore core** — **FM + PSG + PCM ALL LANDED (2026-07-20).**
   `verify:all` **34 TRACE MATCH** (both ports, zero tolerance) + ab-gate 35.
   `m3-se` exercises all three SE families back-to-back (FM steal at f30, PSG at
   f90, PCM at f150), non-overlapping so the single `SE_SNAP`/`PCM_SNAP` slots
   suffice.

   PCM (design C) — the soft-mix voice steal, which needed a **driver-budget
   reorg** to fit (approved by the user):
   - **Evicted `d_param_sweep` (58 B, cold — per sweep start) to a new `ovl_sweep`
     overlay (index 8)** via a `tramp_sweep` resident trampoline. The running
     sweep engine (process_sweeps) stays resident; only the setup moved. Freed
     ~64 B resident.
   - **Grew the overlay slot 274→320 B** by lowering `OVERLAY_SLOT` ($17DE→$17B0)
     and `G_PCMV` ($17AB→$177D) into the freed resident. Slot size = DATA_BASE −
     OVERLAY_SLOT; build asserts `resident ≤ G_PCMV` and `overlay ≤ slot`.
   - **Snapshot rides `ovl_setup`** (START_SE, cohesive with the FM/PSG suspend —
     NOT ovl_pcm): `vi*17` voice pointer + 17-B LDIR of `G_PCMV[vi]` → `PCM_SNAP`,
     gated on `PV_ACT` bit0 (only a live loop) and `T_ISSE` set only then (so the
     reclaim never writes stale data over an idle voice). drv-player snapshots at
     `_startTrack` — same frame/point, identical value.
   - **Restore rides `ovl_se`** (`se_restore_pcm`; the ovl_se entry now dispatches
     PSG 6-9 vs PCM 20-22). Just LDIRs `PCM_SNAP` → `G_PCMV[vi]`; the resident
     mixer resumes the loop at the restored `PV_POS` next frame. No re-key.
   - `PCM_SNAP` (17 B) carved off the stack next to `SE_SNAP` (window now 51 B,
     13 B reserve). Every overlay stays thematically pure (no code mixing).
   **Budget after the reorg**: resident 18 B free, overlay slack 16 B (ovl_setup
   304 B is the max), stack reserve 13 B.

   FM + PSG (landed):
   PSG (2026-07-20): `m3-se` grew a sustained sqr1 BGM + a sqr2→sqr1 PSG SE that
   fires **after** the FM SE ends (non-overlapping, so the single `SE_SNAP` slot
   still suffices — no pool yet). drv-player `_snapshotChannel`/`_restoreChannel`
   got PSG branches (period+att re-attack, mirroring `_noteOn`). Z80: a **new
   `ovl_se` (overlay index 7, 83 B)** hosts `se_restore_psg` (LDIR restore + owner
   reactivate + period/att), because ovl_voice had no room and PSG needs no voice
   patch; `se_reclaim` now **dispatches by channel** — FM(<6)→ovl_voice
   se_restore, PSG(6-9)→ovl_se. `verify:all` **34 TRACE MATCH** + ab-gate 35.
   **RESIDENT IS NOW 0 B FREE** (the se_reclaim dispatch used the last 13 B) — the
   PCM slice must not add resident. ovl_se has ~190 B free for the PCM restore.
   The FM sub-slice below still holds:
   START_SE (cmd 7), T_STATUS=3 + snapshot + reclaim + re-key, on **both** the Z80
   AND drv-player. `m3-se` FM gate passes (`verify:all` 34 TRACE MATCH + ab-gate
   35 scores). What landed:
   - **Harness auto-start control**: the `.cmds.json` sidecar grew an object form
     `{autoStart, remapChannels, commands}`. `autoStart:false` holds every track
     idle so the schedule drives START_TRACK/START_SE (run-trace.mjs + drv-player
     `_reset(autoStart)` + captureRegisterLog both suppress auto-start-all).
     `remapChannels {"<trackId>": ch}` patches the built MMB track table so two
     tracks share one physical channel — a **stand-in for the Step 3 bundler**
     (the compiler is one-track-per-channel; the SE gate authors the SE on fm2 and
     remaps it to fm1). verify.mjs parses both.
   - **drv-player lifecycle** (`_startTrack`/`_mailboxStop`/`_startSe` via
     `_applyMailbox` case 1/2/7): claim resets channel level defaults (mirrors
     st_claim); START_SE suspends+snapshots the FM owner; EOT/STOP reclaim restores
     (`_voiceSet` → carrier level → pitch → re-key). `voiceId` tracked on `_fm[ch]`.
   - **Z80**: mbox cmd 7 routes like cmd 1 with `G_ISSE`; ovl_setup start_track has
     an evict-vs-suspend fork; `d_eot` hooks `se_reclaim` (resident trampoline) →
     ovl_voice `se_restore` (dispatched by `G_SE_ENTRY`), which shares
     `voice_apply_id` (refactored out of `d_voice_set`, sets `CHS_VOICE`).
   - **KEY layout facts** (bit me — record for PSG/PCM): CH_STATE `$18-2f` is the
     **two sweep slots** (`SW_SLOT0`=$18/`SW_SLOT1`=$24), NOT free — the design's
     "$18-2f free" was wrong. Genuinely-free CH_STATE bytes are only the scattered
     `$02-04/$07/$09-0b` (7). `CHS_VOICE` lives at **$02** (inside the contiguous
     `$01..$0E` = CHS_NOTE..CHS_OWNER range the snapshot LDIRs, so it rides along
     for free). Resident is **FULL** (code ends $17aa, G_PCMV $17ab — 0 gap), so
     NO new resident helpers — the snapshot must be an LDIR of the contiguous
     CHS_NOTE..CHS_OWNER range (small overlay code), not field-by-field (blows the
     274 B overlay slot). Snapshot slot `SE_SNAP` (14 B, **N=1**) is carved off the
     stack window ($1FAE; STACK_FLOOR→$1FBC; 68 B window, 30 B reserve).
   - **PSG + PCM remaining**: extend `m3-se` with a sustained PSG note + PSG SE
     (period+att snapshot, re-key) and a PCM-over-PCM case. **N=1 SE_SNAP must
     become a small pool** for two simultaneous SEs (FM+PSG) — index by a slot in
     the SE TCB. PCM uses the separate 17-B `G_PCMV` snapshot at `pcm_note_on`.
     stop_track reclaim (held/looping SE) is also still TODO (only `d_eot` reclaim
     is wired; the FM gate SE ends at EOT). NOTE: reclaim-from-stop_track runs
     inside ovl_cmd, so it can't self-overwrite by loading ovl_voice — needs care.
3. **Bundler/link tool** — pack BGM + SE control data into one MMB + the shared
   sample bank (reuses step 1's format), sample-id namespace across sources.
   Needed for real BGM+SE concurrency; compile-time, node-testable.

Decisions locked (2026-07-19): option 2 (`START_SE` command, no source marker);
reclaim on SE EOT/STOP; essential-field snapshot; PCM loop restore via 17-B
G_PCMV snapshot resuming at PV_POS; re-key = re-attack. The one thing to design
at implementation time is the harness auto-start-control shape.

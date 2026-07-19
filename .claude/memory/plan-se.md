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

## Design (draft — for agreement)

### A. Triggering an SE (suspend-not-evict)

A normal `START_TRACK` evicts the owner. SE needs a variant that **suspends**:
- **`START_SE` mailbox command** (or a flag bit on START_TRACK). Starts the SE's
  track(s) from the bundled control MMB; for each channel the SE claims, the
  current owner is **suspended (T_STATUS→3) and snapshotted** rather than stopped.
- The SE's tracks play normally (they own the channels during the SE).
- **SE end**: when every SE track on a suspended channel has ended (stream EOT or
  STOP), the channel is **reclaimed**: restore the snapshot, resume the BGM TCB
  (T_STATUS→1), and re-key if it was mid-note.

Open: SE-end detection — per-SE-track EOT vs an explicit `END_SE`/STOP_TRACK from
the game. Leaning: reclaim when the SE track that suspended a given owner ends
(EOT or STOP_TRACK), so single-shot SEs self-clean and held/looping SEs end on
STOP.

### B. Snapshot + restore (mid-sustain), per channel family

On suspend, snapshot the displaced channel's live state; on reclaim, restore it
and re-key the sounding note. State to save differs per family:

- **FM (fm1-6):** the patch is re-establishable via VOICE_SET (Part 1) IF the
  driver knows the BGM's current voice id — so **track a per-channel current
  voice id** (a new `CHS_VOICE` byte, written by VOICE_SET / the voice-ref path).
  Plus the live note/vel/vol/pitch/gate + active macro ids. Restore = VOICE_SET
  the id, re-apply level, re-key the note (mid-sustain).
- **PSG (sqr1-3/noise):** no patch table — snapshot tone period + 4-bit
  attenuation (+ soft-envelope/macro state). Restore = re-write period + att,
  re-key. Light.
- **PCM (pcm1-3):** snapshot the sample id + PV_VOL (item 4) + playback position.
  Restore = re-arm the voice. (Resuming a held PCM sample mid-buffer is the
  analogue of mid-sustain — decide whether to resume at the saved position or
  restart the sample.)

Snapshot storage: the channel-state block is 64B; save the essential subset
(~20-30B) into a per-suspended-channel snapshot buffer. SE usually steals 1-few
channels → a small pool (RAM budget: packed, but a snapshot region is feasible;
size it to the max concurrent SE-stolen channels — start with a small fixed N).

Open: full-64B snapshot (simple, RAM-heavy) vs essential-fields (lean). Likely
essential-fields; VOICE_SET already reconstructs the FM patch so only the
note/level/macro/position state needs saving.

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
latch is the only hot addition (light, hardware-validated). Resident 76B free +
overlay slot headroom + shared-sample-bank frees the control window. So bytes are
not the constraint — the work is the design above + the toolchain bundler/link.

## Sequencing (proposed)

1. **Sample-bank separation** (toolchain + driver) — the enabler; needed for PCM
   anything. Gate: existing PCM scores play byte-identical with samples in the
   shared bank; hardware cycle check.
2. **Suspend/restore core (FM + PSG)** — T_STATUS=3, CHS_VOICE, snapshot pool,
   START_SE/reclaim, mid-sustain re-key. Gate `m3-se`.
3. **PCM restore** + PCM-SE gate.
4. **Bundler/link tool** — pack BGM + SE control data into one MMB, shared sample
   bank, sample-id namespace. (Can precede 1-3 for authoring, but 1 is the
   feasibility gate.)

Each step is independently gated; stop anywhere. Steps 1 and 4 are compile/
driver work doable + verifiable in the cloud; the hot mixer latch (1) and the
re-key timing (2) get final validation at hardware bring-up.

## Open decisions to confirm before implementing

- SE-end/reclaim trigger (per-SE-track EOT vs explicit END/STOP).
- Snapshot granularity (essential fields vs full 64B).
- Sample-id namespace + link model (how sources declare the shared bank).
- PCM held-sample restore (resume at position vs restart).
- Start point: sequencing above starts with sample-bank separation (feasibility
  gate) — confirm vs starting with the FM/PSG suspend-restore core.

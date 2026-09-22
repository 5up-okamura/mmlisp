# SE (sound effects) — the design record for work NOT yet ported

**Status: SE does not exist on the shipped driver.** It lives only in
`live/src/drv-player.js`, which is the port spec (`driver.md` §2.5, §11;
`roadmap.md` Phase 3 open #2). `drv/tools/c-gate.mjs` skips the SE scores —
`SKIP … SE-style schedule (autoStart/remap); not ported yet`.

This file used to say "SE core is DONE in emulation". That was true of the
all-Z80 build, which was removed (tag `archive/all-z80`); every Z80 line
reference, overlay index and byte figure it carried is gone. Rewritten
2026-09-22 to be what it now is: **the settled design, so the C port does not
have to re-decide it.** The behaviour itself is already implemented — read
`drv-player.js` (`_startTrack` with `asSe`, `_snapshotChannel`, the restore
path) as the specification, and port from that, not from prose.

## What the user settled (2026-07-19)

1. **SE is authored in MMLisp** — the same language as BGM, a short score.
2. **Concurrency = bundle the control data, share the sample bank.** BGM and
   the SEs it can trigger are bundled at build time into one control MMB; the
   PCM sample data lives in a dedicated shared bank. This was chosen
   *explicitly over* runtime cross-MMB banking, which stays deferred
   (`driver.md` §11, `roadmap.md` open #4).
3. **A held sustaining note must be restored mid-sustain** — waiting for the
   next note-on would drop audio. So restore re-keys a note that was sounding
   when the SE stole its channel. (FM and PSG re-attack; an FM envelope cannot
   resume mid-way, and that matches the "don't drop the note" goal.)
4. **The displaced BGM track suspends** — it must NOT keep dispatching, because
   its writes would overwrite the SE.
5. **Triggering is a runtime command, not a source marker.** `START_SE` is a
   host command; the user chose it because it needs no language, IR or MMB
   change, and the hard part — the suspend/restore core — is identical either
   way.

## The rules that are easy to get wrong

- **Track status gains a fourth state: suspended** — has state, does not
  dispatch, does not own its channel. Distinct from idle and from held (`len 0`).
  Eviction (what a scene transition does) is the wrong primitive for SE: it
  stops the previous owner, so the BGM could never resume.
- **Priority.** `new < owner.prio` → **drop the incoming SE, and the drop must
  NOT silence the one already playing.** `new ≥ owner.prio` → preempt, but
  **keep the snapshot**, so the suspended BGM is restored only when the *last*
  SE ends. Gate `m3-se-prio` pins exactly this: SE-A steals, SE-B (prio 10)
  preempts, SE-C (prio 3) is dropped, and the BGM returns when SE-B ends.
- **Reclaim has two hooks, and only one was ever wired.** A single-shot SE
  self-cleans at end-of-track; a **held or looping SE ends on stop-track**, and
  that path is still missing.
- **Snapshot the essential fields only**, because the patch is reconstructed:
  FM → note/vel/vol/gate/pitch + the current **voice id** (VOICE_SET rebuilds
  the rest) + active macro ids; PSG → tone period + attenuation + macro state.
- **PCM suspends at a different hook** — PCM voices have no channel owner, so
  the snapshot happens when an SE's PCM note-on is about to overwrite an
  *active* voice. Restoring the voice's **position** resumes the loop where it
  was, so there is no dropout. **Deliberately not time-synced** (user): advancing
  the position by the elapsed SE frames is a later refinement.

## Still to do

- **The bundler / link tool** (never started): pack BGM + SE control data into
  one MMB plus the shared sample bank, with a sample-id namespace across
  sources. Compile-time and node-testable. The gates fake it today with the
  `.cmds.json` `remapChannels` stand-in.
- **The C port itself**, and a host call on the SGDK side.
- **One SE snapshot slot → a small pool**, so two SEs (say FM + PSG) can sound
  at once. The gate's SEs are non-overlapping, so one suffices today.
- **Stop-track reclaim** for held and looping SEs.

**A warning for whoever gates it:** to compare at zero tolerance the lifecycle
must exist in *both* players and the harness must not auto-start the SE track —
that is what the sidecar's `autoStart: false` is for.

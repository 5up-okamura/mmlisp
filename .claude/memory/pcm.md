# PCM — the user's rulings and what is open

**Read before touching PCM in any layer.** What it is: `docs/driver.md`
§1/§5/§6.6/§14, `docs/language.md` §9/§16, `docs/mmb.md` §10,
`docs/pcm-multibank.md`.

## Rulings, not to re-propose

- **Light over exact** (D10): no phase observer, no corrector, bus stops not
  repaid, VSync-only host.
- **No runtime pitch**: every note baked at its pitch; pitch on a PCM track
  is a score error. Capacity (banks, >32 KiB) came before pitch.
- **Levels are 6 dB-rung tables**, master folded in by the host. Finer
  levels declined (2026-10-21).
- **The Z80 keeps writing the YM** (a Z80-only driver some day).
- **Work margin to the edge**: a mis-costed slot runs flat, never crashes.
- **Loop points are times**, changeable per note and by curves; `:mode` is
  sticky. The four points' names are the user's (`:pcm-start` …; `:span`
  rejected). A baked reverse rejected.
- **fm6 and the PCM take fm6 in turn** (the user, 2026-11-10; it was the DAC
  all song): a PCM note turns `$2B` on, an fm6 key-on off; the engine is told
  nothing and its voices play on unheard. Not a voice cut, not an engine
  change.
- **The browser sounds like the driver.**
- `:fx` is an ordered chain; a kit's chain runs before the def's. PCM
  audition is the FM one.
- Macros on PCM: `:keyon`, `:vel`, `:vol`.
- Against XGM2: we pay each slot's worst case because CSM owns Timer A; we
  have levels and moving loop points, it has neither.
- Ordinary FM3 is out of `banked_writes` (the converter does not know CH3's
  mode).

## Open

- The banked converter has no byte-for-byte JS twin (covered by
  `tests/banked-pairs.c`, BlastEm, `prioritizeFmNotes`).
- Reverse at playback: zero bank cost but a new piece in every layer; worth
  it only if a composer wants direction as a performance control.

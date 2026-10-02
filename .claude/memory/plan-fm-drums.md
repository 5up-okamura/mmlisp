# FM drum kits from the XG bank — decided 2026-10-03, not yet implemented

The user wants GM drum kits played on FM channels, taken from the percussion
banks of the libOPNMIDI XG bank that `presets/gm` already vendors
(`fm_banks/xg.wopn` at `8e0a0a6ac97a`, MIT, notice in
`presets/gm/licenses/libopnmidi-xg.txt`). The melodic import took bank MSB 0 /
LSB 0 only; the percussion banks were never read.

## What the bank holds

WOPN2 v2: 10 melodic banks, 11 percussion banks, 69-byte instruments. The
named percussion banks (MSB 88 unless noted):

| bank | name                     | defined notes | note |
| ---- | ------------------------ | ------------- | ---- |
| 0    | G #001 StandKit          | 57 (30-87)    | full GM 35-81 |
| 1    | G #049 SymphKit          | 53 (3-87)     | orchestral |
| 2    | G #026 AnalgKit          | 35 (44-83)    | 808-style, partial (no kick/snare below 44) |
| 3    | G #025 ElctrKit          | 53 (35-87)    | electronic |
| 4    | G #002 StndKit2 (MSB 0)  | 54 (31-87)    | second standard kit |

Banks 5-10 are unnamed variants (8/22/54/54/56/54 notes); decide by ear whether
any is worth shipping, otherwise skip.

## Decisions

- **Sets.** One preset directory per kit, all FM: `presets/fm-drums`
  (StandKit) first, then the others the user finds attractive — he said "the
  other kits are attractive too, bring them in" — e.g. `fm-drums-analog`,
  `fm-drums-electric`, `fm-drums-symph`, `fm-drums-2`. Names are a proposal;
  settle them when the kits are heard.
- **A drum is a `def` bundling the voice and its pitch** — no language change:
  `(def fm-kick fm-kick-v (macro :semi N))` style, so a score writes
  `fm-kick c fm-snare c` on an FM track at an agreed octave (document "written
  for `:oct 4`, write `c`"). The user explicitly allowed macros. A `def-fm`
  with a fixed-pitch key was discussed and set aside until the kits are heard.
- **Names carry an `fm-` prefix** (`fm-kick`, `fm-snare`, `fm-tom1` …), not
  the shared PCM kit vocabulary, so a score can import a PCM kit and an FM kit
  together (PCM kick + FM toms). The role words after the prefix are the kit
  vocabulary's (`presets/gm-drums/README.md` lists it; `china` and `splash`
  were added 2026-10-03).
- **Provenance** stays the libOPNMIDI notice already in the repo; add the
  percussion banks to the `THIRD_PARTY_NOTICES.md` entry and each set's README.

## Open before implementing

- **How the fixed pitch composes.** In each 69-byte instrument, bytes 32-33
  are the BE int16 `note_offset` and byte 34 the `percussion_key_number`
  (bass drum: offset 35, key 34 / 26; closed hat: offset 70, key 52). Read
  libOPNMIDI's loader and `realTime_NoteOn` (the `tone <= 20 → add, < 128 →
  replace, else subtract` rule) to get the sounding MIDI note right, then
  verify by rendering a kick and measuring its pitch. The melodic import did
  not apply note offsets; the drums must.
- Several instrument names in the bank are truncated ("om3", "ick5_(c2)",
  "nare 8"); name defs by GM note, not by the bank's string.
- Dual-voice instruments (flag bit in byte 35), if any, reduce to the first
  voice as the melodic import did.
- Key-off: FM drums ring until the note's `:len` keys them off; say so in the
  README (write long notes or `~` for cymbals).
- The import script was deleted with the rest of the preset tooling
  (d073563 removed `tools/scripts/import-xg-gm.mjs`); write a new one-off in
  the scratchpad, as the PCM kits were converted, and do not commit it.

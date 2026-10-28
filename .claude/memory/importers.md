# Song importers (VGM, MIDI, trackers)

What the code and `docs/guide.md` do not record: the ground truth the VGM
importer is measured against, how, and what it still gets wrong.

## Ground truth: the composers' own MML beside the VGMs

The user's Dropbox holds mucom88 MML for songs whose VGMs are also there
(`~/Dropbox/GameDev/VGM/Downloads/mucom88/mucom88win_yk2mml191012/`, each
folder's `LIST_*.txt` names the songs; the VGMs under `VGM - PC-8801/`,
`VGM - Genesis/`, `VGM - x68k/`). 32 pairs:

- PC-88: The Scheme (pcmt12 → 03, pcmt13 → 06, pcmt16 → 07, pcmt17 → 08,
  pcmt18 → 02, pcmt20 → 12, pcmt31 → 15), Misty Blue (disco1 → 09,
  disco3 → 12, disco4 → 10, hrock1 → 03).
- Mega Drive: Bare Knuckle (stk004 → 03, stk013 → 12, stk020 → 08,
  stk023 → 01, stk027 → 05), Bare Knuckle II (bare03 → 02, bare04 → 04,
  bare09 → 10, bare12 → 20, bare16 → 07, bare21 → 08, bare75 → 15), Slap
  Fight MD (slp005b → 17, slp010 → 19, slp020 → 22), The Super Shinobi =
  Revenge of Shinobi (sin002 → 03, sin008 → 12, sin013 → 08, sin014 → 06).
- X68000: Bosconian (bos010 → 10, bos011 → 11).

The bars' truth: put `|` at the head of every part line of the `.muc`,
import it (`importMucom` maps it to MMLisp's `|`), compile, and read
`ir.tracks[].bars` — a tick most parts start a line on is a downbeat, the
line lengths (multiples of 288 or 384) the meter. The gate's truth is the
part's `q` (clocks cut, 4 ticks each at C96).

## Open

- **Tempo misread on 6 of the 32** (2026-10-28): Bare Knuckle's Stealthy
  Steps, The Street of Rage and Alien Power fall to the 112.5 BPM frame
  grid (the MML's 89.7 / 149.4 / 128.1); The Scheme's 03 and 06 read at 3/4
  of the tempo (102.9 for 137.6 / 135.4); Death World and Slap Fight's
  Kibou at 1.5×. The bars follow the beat, so these are wrong before
  bestBars runs.
- **Bars** with the beat right: 24 of 26 (Misty Blue 03 reads at twice the
  MML's tempo, as the user asked). Missed: Slap Fight's Hishou (3/4 read as
  4/4) and The Scheme's Challenging Tomorrow (a 16th pickup, within the
  harness's alignment error).

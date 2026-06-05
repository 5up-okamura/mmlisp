# YM2612 Player

This directory contains a standalone VGM validation player for checking FM
playback independently from the MMLisp compiler path.

Current state:

- `index.html` / `vgm-player.js` provide a minimal YM2612-only VGM player.
- `nuked-worklet.js` uses a WASM build of `Nuked-OPN2` for higher-accuracy FM
  playback.
- The player is intended as a validation harness before or alongside changes to
  `live/`.

Backend:

- Core: `Nuked-OPN2`
- Reason: the previous JS YM2612 implementation was not accurate enough for
  trustworthy FM timbre validation.
- License: LGPL-2.1-or-later

See `player/wasm/README.md` for build details and `../THIRD_PARTY_NOTICES.md`
for licensing information.

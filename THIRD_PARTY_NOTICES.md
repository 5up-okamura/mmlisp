# Third-Party Notices

This repository includes third-party source code with its own license terms.

## Nuked-OPN2

- Upstream: `third_party/Nuked-OPN2`
- Project: `Nuked-OPN2`
- Copyright: upstream project authors
- License: LGPL-2.1-or-later

Included files:

- `third_party/Nuked-OPN2/ym3438.c`
- `third_party/Nuked-OPN2/ym3438.h`
- `third_party/Nuked-OPN2/README.md`
- `third_party/Nuked-OPN2/LICENSE`

Local integration files in this repository:

- `player/wasm/nuked_adapter.c`
- `player/wasm/build-nuked.sh`
- `player/wasm/dist/nuked-opn2.js`

The upstream license text is preserved at `third_party/Nuked-OPN2/LICENSE`.
When distributing builds that include the generated WASM wrapper, keep that
license text with the distribution and provide the corresponding source used to
rebuild the library.

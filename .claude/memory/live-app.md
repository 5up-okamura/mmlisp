# The live app — decisions not to redo, and lessons

What the app does is `docs/guide.md` (§22–§28); why the code is shaped the
way it is lives in its comments; what is ahead is `docs/roadmap.md`. Kept
here: what was decided against (so it is not proposed again), and working
lessons.

## Decided against — do not re-propose

- **Editor:** no `@codemirror/lint` and no `bracketMatching()` (a mark
  decoration moves the soft-wrap point; under `StreamLanguage` the fallback
  scan does not skip strings and comments — bracket marks are a `layer`). No
  `rectangularSelection()` / `crosshairCursor()` (Alt-drag is the value
  scrub). No full paredit (editing here is step-vector churn). No rainbow
  parens (accent only on call heads and `:params`). No touch symbol bar
  (unstable on the user's iPad; not without a way to test there).
- **Library and keys:** the keys play no macro (user: not now, not later),
  but for a wave's role macro (2026-11-03): held still, a wave is not its
  sound. No ⌘⇧K (CodeMirror's delete-line, Firefox's console). No Tools >
  Snippets (user: "the most half-done thing"). No Library state kept across
  launches (it confused the user).
- **Piano roll:** two colours only, no per-channel colours; no bars or bar
  numbers; no channel chips, no Follow/Fixed switch; zoom is a scale, not a
  window in beats; `MMLisp > View` is a submenu, not a View menu; no edge
  markers for notes outside the focus's range; no transport and no note
  editing in the pane.
- **Translation:** only what explains or asks is translated — the reference,
  the snippets' descriptions, the Guide and the confirm dialogs
  (`ui-texts.js`). Menus, the log and diagnostics stay English; no runtime
  machine translation (offline, fixed glossary terms).
- **Playback in the worklet** (2026-10-16): not now. iOS plays on behind
  another app through an `<audio>` element. If ever needed: both players
  already run off a manual clock in `captureRegisterLog`, the page reaches
  the player at ~30 sites in index.html that would read a posted mirror, and
  the hazards are seek/hot-swap/GC stalls on the audio thread.
- **The lock screen's item** opening another home-screen web app (the
  user's iPhone, 2026-10-16): taken as the device's, left alone.
- **The scope while playing** (2026-10-16): `correlateValid` is ~9 % of a
  4×-throttled thread plus its polyline, and cutting more changes how the
  trace locks — not worth it. (Headless canvas is CPU-drawn, so draw costs
  read high there.)
- **Archives** (2026-10-28): ZIP and LZH only, both first-party
  (`src/archive.js`). No RAR / 7z for now — no small decoder of our own;
  libarchive built to WASM, loaded on demand, if a need shows up. `File >
  Import > Song…` stays beside Open…: it is the multi-select, the only way a
  phone (no folder) brings a `.muc` with its `.dat` / `.bin`.
- **Share links' files** (2026-11-06): not base64 inside the score's text
  (it buries the score, the diff and an AI's context) — a ZIP beside the
  short link (`share-files.js`). No per-file opt-out in the Share dialog: it
  lists what goes, and a file left out would only come back as a missing
  one. A long link (no server) carries no files. The 256 KB cap stays
  (user, 2026-11-06), though a PC-8801 VGM import's bank nears it (The
  Scheme's largest track: ~232 KB zipped) — not to be re-proposed.
- **The ja / es translations** stay as machine-written from the glossary
  (user, 2026-10-16: having one helps more than none; a wrong line is fixed
  when found). A fix goes through `i18n-sync.mjs --apply`, never a hand edit
  of the pack.

## Lessons

- **One word, two reference entries.** `noise` heads the PSG channel and the
  random curve, so reference.js entries carry `ctx` ('track' / 'value') and
  the hover and completion read the position (`referenceCtxAt`); check:reference
  holds it. Still first-wins, because neither reading has come up as wrong:
  `<` `>` (comparison vs octave), `ticks` `frames` (arithmetic vs length
  suffix), `midi`, `repeat`, `:rate`. Give those a `ctx` when one does.
- **Make sure a change is deployed before asking for a device test** — a run
  of failed deploys once meant four fixes never reached the device. A push to
  `main` deploys mmlisp.com through Cloudflare Workers Builds; its result is
  the commit's check run
  (`api.github.com/repos/5up-okamura/mmlisp/commits/<sha>/check-runs`).
- **Suspect the instrument first.** An on-screen probe that rewrote itself
  every 300ms made the iPad lay the app out at portrait size in landscape; it
  was blamed on the offline change and the vendored font first. Prefer a
  probe that writes only on demand.
- **WebKit reproduces iPhone issues headless**: playwright-core's WebKit
  (`npx playwright-core install webkit`, cached in ~/Library/Caches) with
  `devices['iPhone 13']` — no folder picker, touch, the iOS paths.

## Small tools still to specify

- **Time-unit converter:** the user wants a small panel tool. Decide its
  inputs and conversions between score lengths, ticks, frames and milliseconds
  before building it. This is not a request to add Hz to MMLisp's LFO rate.
- **MMB/driver resource information:** MD only. Define which concrete
  production question it answers before choosing statistics or controls.
- **A second temporary tool on mobile:** decide how to switch small windows
  without stacking them over the source; do not infer a multi-window design.
- **Excluded from the small-tool list:** a separate length calculator (the
  existing `| ... |` calculation is enough), and diagnostics (normal app
  feedback, not an independent tool).

## Deferred editing ideas

- **Target conversion** (an open score's `:target` changed; a song import
  onto another machine is built): retain as an idea, lower priority.
- **Restructuring VGM / NSF imports stays human-guided** (Edit > Tap Tempo,
  built 2026-11-03): not automatic beat detection, not an import-time
  conversion with no preview.
- **Hiding source by kind** (user's idea, 2026-11-06; still being thought
  over — do not build until the user decides): e.g. hide every `:vel` so a
  dense score (VGM / NSF imports) reads easily. A view setting only: Save,
  Copy, Share and Format see the text unchanged. Discussed so far:
  - Unit: a keyword with its value (`:vel 90`, `:vel (linear …)`), and
    comments; form kinds (`(macro …)`) only if needed.
  - Fully hidden reads fine but breaks editing at a hidden range's edge:
    `:vel` applies from where it is written, so typing between `c` and `d`
    in `c :vel 90 d` shown as `c d` changes the sound depending on the side
    it lands; a selection or Backspace removes what is not seen. A marker
    (`c · d`) adds noise as dense as the notes. Proposed: hide fully, but
    show the cursor's lines in full (search hits, diagnostic links and the
    Logical Editor then reveal by moving the cursor). Alternatives: dim in
    `--sub` instead of hiding; read-only while hiding.
  - UI: proposed a strip at the editor's top (`Hide: :vel :pan ▾`, a
    checklist with counts), absent when nothing is hidden — the panel can be
    closed (phones), and the hiding must stay visible. Not in a lesson's
    working copy (its text is the leading comment).
  - Open: per user or per score; hide vs dim (or both).

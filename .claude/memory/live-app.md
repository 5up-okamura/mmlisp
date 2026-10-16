# The live app — decisions not to redo, and what is open

What the app does is `docs/guide.md` (§22–§27); why the code is shaped the
way it is lives in its comments. Kept here: what was decided against (so it
is not proposed again), working lessons, and open development items.

## Decided against — do not re-propose

- **Editor:** no `@codemirror/lint` and no `bracketMatching()` (a mark
  decoration moves the soft-wrap point; under `StreamLanguage` the fallback
  scan does not skip strings and comments — bracket marks are a `layer`). No
  `rectangularSelection()` / `crosshairCursor()` (Alt-drag is the value
  scrub). No full paredit (editing here is step-vector churn). No rainbow
  parens (accent only on call heads and `:params`). No touch symbol bar
  (unstable on the user's iPad; not without a way to test there).
- **Library and keys:** the keys never play a macro (user: not now, not
  later). No ⌘⇧K (CodeMirror's delete-line, Firefox's console). No Tools >
  Snippets (user: "the most half-done thing"). No Library state kept across
  launches (it confused the user).
- **Piano roll:** two colours only, no per-channel colours; no bars or bar
  numbers; no channel chips, no Follow/Fixed switch; zoom is a scale, not a
  window in beats; `MMLisp > View` is a submenu, not a View menu; no edge
  markers for notes outside the focus's range; no transport and no note
  editing in the pane.
- **Translation:** only what explains is translated — the reference and the
  snippets' descriptions. Menus, the log and diagnostics stay English; no
  runtime machine translation (offline, fixed glossary terms).
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
- **The ja / es translations** stay as machine-written from the glossary
  (user, 2026-10-16: having one helps more than none; a wrong line is fixed
  when found). A fix goes through `i18n-sync.mjs --apply`, never a hand edit
  of the pack.

## Lessons

- **Check a commit's Vercel status before asking for a device test**
  (`api.github.com/repos/5up-okamura/mmlisp/commits/<sha>/status`) — a run of
  failed deploys once meant four fixes never reached the device.
- **Suspect the instrument first.** An on-screen probe that rewrote itself
  every 300ms made the iPad lay the app out at portrait size in landscape; it
  was blamed on the offline change and the vendored font first. Prefer a
  probe that writes only on demand.
- **WebKit reproduces iPhone issues headless**: playwright-core's WebKit
  (`npx playwright-core install webkit`, cached in ~/Library/Caches) with
  `devices['iPhone 13']` — no folder picker, touch, the iOS paths.

## Open

What is ahead for users is `docs/roadmap.md`; these serve development only.

- **Internal "Browse" names** (`BROWSE_*_INDEX`, `loadBrowseCatalog`,
  `previewBrowse*`, …) still name the Library; rename when a refactor of that
  area comes up.

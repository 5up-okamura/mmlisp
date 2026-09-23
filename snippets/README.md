# snippets

Short scores, one technique each, for **File ▸ Browse… ▸ Snippets** (guide
§25): ▶ plays one on its own, **Insert** puts it at the cursor, **Open** puts
it in the editor. They stand in for documentation — each file's leading
comment says what it shows, and the panel displays it.

- One directory per topic; the directory name is the heading in the panel.
- `index.json` lists what the panel offers, in order. A new snippet has to be
  named there to show up.
- **Write a snippet as if it sat at the site root**, next to a new score:
  imports read `presets/…`. The panel compiles it under its bare name, so the
  same text resolves whether it is played, opened or inserted.
- Use drum names both kits have (`kick`, `snare`, `hat`, `hat-open`, `rim`,
  `crash`, `tom1`–`tom6`, …) when you can, so a score importing either kit can
  take the snippet in.
- Comments are English, and the first sentence is the summary.

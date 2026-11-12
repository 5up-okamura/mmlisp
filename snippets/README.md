# snippets

Short scores, one technique each, for the Library panel's **Snippets**
source (guide §25): ▶ plays one on its own, **Insert** puts it at the cursor,
**Open** puts it in the editor. They stand in for documentation — each file's
leading comment says what it shows, and the panel displays it.

- One directory per topic; the directory name is the group in the panel.
- `index.json` lists what the panel offers, in order. A new snippet has to be
  named there to show up.
- **Write a snippet as if it sat at the site root**, next to a new score:
  imports read `presets/…`. The panel compiles it under its bare name, so the
  same text resolves whether it is played, opened or inserted.
- Use drum names every PCM kit has (`kick`, `snare`, `hat`) when you can, so a
  score importing any kit can take the snippet in; `tr808`, `gm-drums` and
  `rx5` also share `hat-open`, `rim`, `crash` and `tom1`–`tom6`.
- Comments are English, and the first sentence is the summary.

## Every machine

Snippets are written with the Mega Drive's channel names; the Library plays,
inserts and opens one on the score's machine by moving its tracks to that
machine's channels (`live/src/port/snippet-port.js`). A track keeps its kind of
sound — FM on FM, a sample on a sample channel, noise on noise — when the
kind is what the snippet shows; when it shows only the language (a tuplet, a
def, a delay, a curve) any melodic channel will do, FM, then tone, then wave,
and an FM voice it names is left out where there is no FM. Which snippets
keep their kind is listed in `snippet-port.js` (`KIND_DIRS`, `KIND_FILES`),
not guessed. Channels that are another way of playing one (`fm3-1`…`fm3-4`,
`fm3-csm`) stay their machine's: on the PC-8801, which has them too, as they
are. A noise mode the machine reads as its own words is written in them
(`:mode white0` is `:noise-rate 9` on the PC-8801's SSG).

A snippet is offered on a machine when its port compiles there without an
error: `snippets/targets.json` records it. After adding or changing a
snippet, run `cd tools && npm run gen:snippet-targets`;
`npm run check:snippet-targets` fails while the file is stale.

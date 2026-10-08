# MMLisp MCP server

`mmlisp-mcp.mjs` lets an AI client write MMLisp: it reads the docs, snippets
and preset sets, compiles a score with the real compiler, renders it to WAV —
the same `live/src` modules the editor runs — and, connected to MMLisp Live,
edits and plays the score open in the user's editor. MCP over stdio, no
dependencies (Node 18+).

## Tools

| Tool              | What it does                                                                 |
| ----------------- | ---------------------------------------------------------------------------- |
| `mmlisp_check`    | Compile; diagnostics with the offending line, each track's length (loops unrolled), song length |
| `mmlisp_ir`       | Compile and return the IR JSON (optionally one track)                        |
| `mmlisp_format`   | The editor's formatter; with `path` + `write` rewrites the file              |
| `mmlisp_live`     | A share link that opens the score in MMLisp Live, ready to play and edit     |
| `mmlisp_render`   | WAV (FM + PSG, no PCM) and its levels — peak, RMS, clipping, silence         |
| `mmlisp_docs`     | `cheatsheet` whole; `language` / `guide` / `ir` / `roadmap`: contents, one section, or a search; `reference`: one entry per feature, by word (`query`) or category (`section`) |
| `live_status`     | Whether MMLisp Live is connected (below), and how the user connects it       |
| `live_read`       | The score open in the user's editor: text, cursor, selection, diagnostics    |
| `live_write`      | Edit it — `{find, replace}` edits or the whole text; one undoable step, then a build |
| `live_play` / `live_stop` | Playback in the user's editor                                        |
| `mmlisp_snippets` | List the snippets with what each shows, filter, or read one                  |
| `mmlisp_presets`  | The preset sets and their import lines, or a set's voice/sample names        |

Scores are passed as `source` text or a `path`. Imports resolve as in the live
app: against the score's folder, then the repository root, so
`(import "presets/gm/set.mmlisp")` works from anywhere.

## Setup

**Claude Code** in this repository picks it up from `/.mcp.json` (approve the
`mmlisp` server when asked). Elsewhere:

```
claude mcp add mmlisp -- node /path/to/mmlisp/tools/mcp/mmlisp-mcp.mjs
```

**Claude Desktop** and other MCP hosts — add to the host's config
(`claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "mmlisp": {
      "command": "node",
      "args": ["/path/to/mmlisp/tools/mcp/mmlisp-mcp.mjs"]
    }
  }
}
```

The server's `instructions` tell the model the workflow: read the cheat sheet
(`docs/cheatsheet.md`), start from a snippet and preset voices, run
`mmlisp_check` after every edit and compare the tracks' lengths, then hand the
user a Live link or a WAV — or, with the bridge on, work in the user's editor.

## Sending a score to MMLisp Live

`mmlisp_live` makes the link File > Share… makes: the source, deflate-raw +
base64url, in the URL fragment — nothing is uploaded, and opening it loads the
score as a new unsaved one with a Play button. It points at
https://mmlisp.vercel.app/ unless `base` or the `MMLISP_LIVE_URL` environment
variable says otherwise (`http://localhost:5173/live/` for `npm run serve`).
`open: true` also launches the default browser, which only helps when the
server runs on the user's machine. Imports resolve from the site, so the
preset sets travel; a local wav or an import from outside the repository does
not.

## Working in the user's editor (the MMLisp Live bridge)

With the bridge the AI works on the score open in MMLisp Live instead of a
file: it reads what the user has, edits it, and plays it — while the user keeps
editing, listening and undoing in the same window. It runs on the user's own
AI subscription; the page never talks to a model.

1. Run the AI client (Claude Code or Claude Desktop) with this server on the
   same computer as the browser. The server listens on `127.0.0.1:5190`.
2. In MMLisp Live, turn on **Tools > Connect to AI**, or open the app with
   `?ai-bridge=5190` (https://mmlisp.vercel.app/?ai-bridge=5190). The choice is
   remembered; the log says when the AI connects. Chrome and Edge may ask to let
   the site reach the local network — allow it. (Safari refuses an `https` page
   reaching `http://127.0.0.1`; use the local dev server there.)
3. Ask the AI for music. It calls `live_read`, then `live_write` and
   `live_play`.

What the connection can do is exactly the page's five ops — status, read,
write, play, stop (`live/src/ai-bridge.js`, wired in `live/index.html`). Every
AI edit is logged in the app and is one step of the editor's Undo. Audio starts
only after the user has clicked the page once; before that `live_play` puts up
a Play button instead. One tab holds the connection: a newer tab takes it over,
and the older one turns itself off.

Only MMLisp Live's pages may connect: the published app and `localhost` /
`127.0.0.1` dev servers, by `Origin`, reaching the server through a
`127.0.0.1`/`localhost` `Host`. `MMLISP_BRIDGE_ORIGINS` (comma-separated)
admits another origin, such as a preview deployment. `MMLISP_BRIDGE_PORT`
changes the port — for a second AI session, whose server finds 5190 taken;
open the app with `?ai-bridge=<port>` to match. The server exits with its
session, and the port is free again; a server that found it taken keeps
trying every 2 s and takes it then — so a reloaded session, whose new server
starts before the old one exits, connects on its own.

## Limits

- The WAV has no PCM (the editor's WAV export has the same scope); a PCM
  track's events are counted, not rendered.
- The model cannot hear the result — levels only catch silence and clipping.
  Listening, and playing it in the live app, stays with the user.
- The bridge needs the AI client and the browser on the same computer; a
  cloud session's server cannot reach a local browser (use `mmlisp_live`
  links there).

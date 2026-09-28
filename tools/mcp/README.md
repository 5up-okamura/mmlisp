# MMLisp MCP server

`mmlisp-mcp.mjs` lets an AI client write MMLisp: it reads the docs, snippets
and preset sets, compiles a score with the real compiler, and renders it to
WAV — the same `live/src` modules the editor runs. MCP over stdio, no
dependencies (Node 18+).

## Tools

| Tool              | What it does                                                                 |
| ----------------- | ---------------------------------------------------------------------------- |
| `mmlisp_check`    | Compile; diagnostics with the offending line, per-track summary, song length |
| `mmlisp_ir`       | Compile and return the IR JSON (optionally one track)                        |
| `mmlisp_format`   | The editor's formatter; with `path` + `write` rewrites the file              |
| `mmlisp_render`   | WAV (FM + PSG, no PCM) and its levels — peak, RMS, clipping, silence         |
| `mmlisp_docs`     | `language` / `guide` / `ir` / `roadmap`: contents, one section, or a search  |
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

The server's `instructions` tell the model the workflow: read the reference,
start from a snippet and preset voices, run `mmlisp_check` after every edit,
render for the user to listen.

## Limits

- The WAV has no PCM (the editor's WAV export has the same scope); a PCM
  track's events are counted, not rendered.
- The model cannot hear the result — levels only catch silence and clipping.
  Listening, and playing it in the live app, stays with the user.

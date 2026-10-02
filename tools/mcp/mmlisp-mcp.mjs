#!/usr/bin/env node
// MMLisp MCP server — lets an AI client (Claude Code, Claude Desktop, any MCP
// host) read the language, compile a score, see the diagnostics and render it
// to WAV, through the same live/src modules the editor runs.
//
// Transport: MCP over stdio (newline-delimited JSON-RPC 2.0). No dependencies:
// the protocol surface used here is small enough to speak directly.
// stdout carries protocol messages only — everything else goes to stderr.

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// A stray console.log in a toolchain module would corrupt the stream.
console.log = console.info = console.debug = (...a) => console.error(...a);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "live", "src");
const load = (file) => import(path.join(SRC, file));
const { compileMMLisp, collectImports } = await load("mmlisp2ir.js");
const { parse } = await load("mmlisp-parser.js");
const { formatMMLisp } = await load("mmlisp-formatter.js");
const { IRPlayer } = await load("ir-player.js");
const { renderWav } = await load("export-wav.js");
const { pitchToMidi } = await load("ir-utils.js");

const DOCS = {
  cheatsheet: "docs/cheatsheet.md",
  language: "docs/language.md",
  guide: "docs/guide.md",
  ir: "docs/ir.md",
  roadmap: "docs/roadmap.md",
};

// ---------------------------------------------------------------------------
// Score input and import resolution
// ---------------------------------------------------------------------------

// A score comes as `source` text or a `path`; its name is repo-relative when
// it lives in the repo, so imports resolve as the live app resolves them.
function readScore(args) {
  if (typeof args.source === "string") {
    return { src: args.source, name: args.filename || "untitled.mmlisp" };
  }
  if (typeof args.path === "string") {
    const abs = path.resolve(ROOT, args.path);
    const rel = path.relative(ROOT, abs);
    const name = rel.startsWith("..") ? abs : rel.split(path.sep).join("/");
    return { src: fs.readFileSync(abs, "utf8"), name };
  }
  throw new Error("give either `source` (score text) or `path` (a .mmlisp file)");
}

// Same rule as the live app's joinImportPath: a spec is relative to the folder
// of the file that wrote it.
function joinImportPath(fromPath, spec) {
  if (path.isAbsolute(spec)) return spec;
  const dir = fromPath.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  const segs = (dir && dir !== fromPath ? dir + "/" + spec : spec).split("/");
  const out = [];
  for (const seg of segs) {
    if (!seg || seg === ".") continue;
    if (seg === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  return (fromPath.startsWith("/") ? "/" : "") + out.join("/");
}

function readText(p) {
  try {
    return fs.readFileSync(path.resolve(ROOT, p), "utf8");
  } catch {
    return null;
  }
}

// The host side of (import "…"): read every imported file ahead of the
// synchronous compile, following nested imports. A score given as text has no
// folder, so its specs resolve against the repo root — `presets/…` works.
function readImportSources(src, name) {
  const map = new Map();
  const seen = new Set();
  const queue = collectImports(src).map((spec) => [joinImportPath(name, spec), spec]);
  while (queue.length) {
    const [p, spec] = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const text = readText(p) ?? readText(spec);
    if (text == null) continue; // E_IMPORT_NOT_FOUND at compile
    map.set(p, text);
    for (const nested of collectImports(text)) {
      const np = joinImportPath(p, nested);
      if (!seen.has(np)) queue.push([np, nested]);
    }
  }
  return map;
}

function compile(args) {
  const { src, name } = readScore(args);
  const frameHz = args.pal ? 50 : 60;
  const result = compileMMLisp(src, name, { imports: readImportSources(src, name), frameHz });
  return { ...result, src, name };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function sourceLine(src, line) {
  return line ? (src.split("\n")[line - 1] ?? "").trimEnd() : "";
}

function formatDiagnostics(diags, src) {
  return diags.map((d) => {
    const where = d.line ? `${d.line}:${d.column ?? 1}` : "-";
    const track = d.track ? ` [${d.track}]` : "";
    const code = sourceLine(src, d.line);
    return `${d.severity} ${d.code} at ${where}${track}: ${d.message}` + (code ? `\n    | ${code}` : "");
  });
}

// Ticks a track takes to play once through, counted loops unrolled: the IR
// holds one pass of an `(x N …)` body, so its last tick undercounts. A body
// with a `(break)` stops there on its final pass.
function playedTicks(ev, lastTick) {
  const root = { begin: 0, end: lastTick, children: [] };
  const stack = [root];
  for (const e of ev) {
    const top = stack[stack.length - 1];
    if (e.cmd === "LOOP_BEGIN") {
      const node = { id: e.args?.id, begin: e.tick, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (e.cmd === "LOOP_END" && top.id === e.args?.id && stack.length > 1) {
      Object.assign(top, { end: e.tick, repeat: e.args?.repeat ?? 1 });
      stack.pop();
    } else if (e.cmd === "LOOP_BREAK") {
      const loop = stack.findLast((n) => n.id === e.args?.id);
      if (loop) loop.brk = e.tick;
    }
  }
  const body = (n, to) =>
    to - n.begin + n.children
      .filter((c) => c.end != null && c.end <= to)
      .reduce((sum, c) => sum + loop(c) - (c.end - c.begin), 0);
  const loop = (n) => (n.repeat - 1) * body(n, n.end) + body(n, n.brk ?? n.end);
  return body(root, lastTick);
}

function trackSummary(ir) {
  return (ir.tracks ?? []).map((t) => {
    const ev = t.events ?? [];
    const notes = ev.filter((e) => e.cmd === "NOTE_ON" || e.cmd === "PCM_NOTE_ON");
    const lastTick = ev.reduce((m, e) => Math.max(m, (e.tick ?? 0) + (e.args?.length ?? 0)), 0);
    const pitched = notes.filter((e) => e.cmd === "NOTE_ON" && typeof e.args?.pitch === "string")
      .map((e) => [pitchToMidi(e.args.pitch), e.args.pitch])
      .filter(([m]) => Number.isFinite(m))
      .sort((a, b) => a[0] - b[0]);
    const range = pitched.length ? `, ${pitched[0][1]}..${pitched.at(-1)[1]}` : "";
    const ticks = playedTicks(ev, lastTick);
    const bars = ticks % 384 ? `${(ticks / 384).toFixed(2)} bars` : `${ticks / 384} bars`;
    const again = ev.some((e) => e.cmd === "JUMP") ? ", then jumps back" : "";
    const tag = t.se ? `se ${t.se}` : t.scoreChannel ?? t.channel;
    return `${tag}: ${notes.length} notes written${range}; plays ${ticks} ticks (${bars} of 4/4)${again}`;
  });
}

function timing(ir) {
  try {
    const cap = new IRPlayer(() => {}).loadJSON(ir).captureRegisterLog();
    const loop = cap.loopStartSec != null ? `, loops back to ${cap.loopStartSec.toFixed(2)} s` : ", one-shot";
    const pcm = cap.pcmCount ? `, ${cap.pcmCount} PCM events` : "";
    return `length ${cap.endSec.toFixed(2)} s${loop}${pcm}`;
  } catch (e) {
    return `timing unavailable: ${e.message}`;
  }
}

function levels(wav) {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const n = (wav.byteLength - 44) >> 1;
  let peak = 0, sum = 0, clipped = 0;
  for (let i = 0; i < n; i++) {
    const s = dv.getInt16(44 + i * 2, true) / 32768;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sum += s * s;
  }
  const db = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : "-inf");
  return `peak ${db(peak)} dBFS, rms ${db(Math.sqrt(sum / Math.max(1, n)))} dBFS` +
    (clipped ? `, ${clipped} clipped samples` : "") + (peak < 1e-4 ? " — SILENT" : "");
}

// ---------------------------------------------------------------------------
// Docs, snippets, presets
// ---------------------------------------------------------------------------

function docSections(text) {
  const lines = text.split("\n");
  const heads = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (l.startsWith("```")) fence = !fence;
    const m = !fence && /^(#{1,4})\s+(.*)$/.exec(l);
    if (m) heads.push({ level: m[1].length, title: m[2], line: i });
  });
  return { lines, heads };
}

function readDoc({ doc = "language", section, query }) {
  const file = DOCS[doc];
  if (!file) throw new Error(`doc must be one of: ${Object.keys(DOCS).join(", ")}`);
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  const { lines, heads } = docSections(text);
  if (doc === "cheatsheet" && !section && !query) return text; // short: all of it
  if (query) {
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const hits = [];
    lines.forEach((l, i) => {
      if (!re.test(l)) return;
      const h = [...heads].reverse().find((x) => x.line <= i);
      hits.push(`${i + 1} [${h ? h.title : "-"}] ${l.trim()}`);
    });
    return hits.length ? hits.slice(0, 80).join("\n") + (hits.length > 80 ? `\n… ${hits.length - 80} more` : "") : "no match";
  }
  if (!section) {
    return `${file} — pass \`section\` (a number like "10" or "9.2", or words from a title) to read one:\n` +
      heads.map((h) => "  ".repeat(h.level - 1) + h.title).join("\n");
  }
  const s = String(section).toLowerCase();
  const idx = heads.findIndex((h) => {
    const t = h.title.toLowerCase();
    return t.startsWith(s + ".") || t.startsWith(s + " ") || t === s;
  });
  const at = idx >= 0 ? idx : heads.findIndex((h) => h.title.toLowerCase().includes(s));
  if (at < 0) throw new Error(`no section matching "${section}" in ${file}`);
  const h = heads[at];
  const end = heads.slice(at + 1).find((x) => x.level <= h.level);
  return lines.slice(h.line, end ? end.line : lines.length).join("\n");
}

function leadingComment(text) {
  const out = [];
  for (const l of text.split("\n")) {
    if (!l.startsWith(";")) break;
    out.push(l.replace(/^;+\s?/, ""));
  }
  return out.join(" ");
}

function snippets({ path: p, query }) {
  if (p) {
    const rel = p.startsWith("snippets/") || p.startsWith("presets/") ? p : `snippets/${p}`;
    const abs = path.resolve(ROOT, rel);
    if (!abs.startsWith(ROOT + path.sep) || !abs.endsWith(".mmlisp")) throw new Error("not a .mmlisp file in the repository");
    return fs.readFileSync(abs, "utf8");
  }
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, "snippets/index.json"), "utf8"));
  const examples = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/index.json"), "utf8"));
  const q = query?.toLowerCase();
  const rows = [...index, ...examples]
    .map((f) => {
      const text = readText(f) ?? "";
      return { f, about: leadingComment(text), text };
    })
    .filter((r) => !q || r.f.toLowerCase().includes(q) || r.text.toLowerCase().includes(q))
    .map((r) => `${r.f}\n    ${r.about.slice(0, 240)}`);
  return rows.length ? rows.join("\n") : "no match";
}

function presets({ set, query }) {
  const sets = fs.readdirSync(path.join(ROOT, "presets"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, "presets", d.name, "set.mmlisp")))
    .map((d) => d.name);
  if (!set) {
    return sets.map((s) => {
      const text = fs.readFileSync(path.join(ROOT, "presets", s, "set.mmlisp"), "utf8");
      const kinds = {};
      for (const m of text.matchAll(/^\((def-[a-z]+)\s/gm)) kinds[m[1]] = (kinds[m[1]] ?? 0) + 1;
      const about = leadingComment(readText(`presets/${s}/README.md`)?.replace(/^#.*\n+/, "") ?? "") ||
        (readText(`presets/${s}/README.md`) ?? "").split("\n").find((l) => l && !l.startsWith("#")) || "";
      return `(import "presets/${s}/set.mmlisp")  — ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}\n    ${about.slice(0, 200)}`;
    }).join("\n");
  }
  if (!sets.includes(set)) throw new Error(`set must be one of: ${sets.join(", ")}`);
  const text = fs.readFileSync(path.join(ROOT, "presets", set, "set.mmlisp"), "utf8");
  const lines = text.split("\n");
  const q = query?.toLowerCase();
  const out = [];
  lines.forEach((l, i) => {
    const m = /^\((def-[a-z]+)\s+([^\s)]+)/.exec(l);
    if (!m) return;
    let note = "";
    for (let j = i - 1; j >= 0 && lines[j].startsWith(";"); j--) note = lines[j].replace(/^;+\s?/, "");
    const row = `${m[2]}  (${m[1]})${note ? "  ; " + note : ""}`;
    if (!q || row.toLowerCase().includes(q)) out.push(row);
  });
  return `(import "presets/${set}/set.mmlisp")\n` + (out.join("\n") || "no match");
}

// ---------------------------------------------------------------------------
// MMLisp Live links — the format of the editor's File > Share… (#n=<name>&s=<data>,
// the source deflate-raw + base64url). `n` is the compile name: a score from
// the repository keeps its path so its imports resolve against its own folder
// on the site, as they do here.
// ---------------------------------------------------------------------------

const LIVE_URL = process.env.MMLISP_LIVE_URL || "https://mmlisp.vercel.app/";

function liveLink(src, name, base = LIVE_URL) {
  const data = zlib.deflateRawSync(Buffer.from(src, "utf8"), { level: 9 }).toString("base64url");
  const n = name && name !== "untitled.mmlisp"
    ? (path.isAbsolute(name) ? path.basename(name) : name)
    : null;
  const head = n ? new URLSearchParams({ n }).toString() + "&" : "";
  return base.replace(/#.*$/, "") + "#" + head + "s=" + data;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
      : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    return "opened in the default browser";
  } catch (e) {
    return `could not open a browser: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// The MMLisp Live bridge: MMLisp Live (Tools > Connect to AI) connects to this
// server on 127.0.0.1, so the AI edits the score open in the user's editor and
// plays it (live/src/ai-bridge.js is the page's end). Requests go down one
// Server-Sent Events stream, answers come back on POST /reply. Only the pages
// of MMLisp Live may connect — the published app and local dev servers, by
// Origin, and only through a 127.0.0.1/localhost Host (no DNS rebinding) — and
// they can only answer the few ops the page defines: status, read, write,
// play, stop.
// ---------------------------------------------------------------------------

const BRIDGE_PORT = Number(process.env.MMLISP_BRIDGE_PORT) || 5190;
const BRIDGE_ORIGINS = (process.env.MMLISP_BRIDGE_ORIGINS ?? "")
  .split(",").map((o) => o.trim()).filter(Boolean);
const bridge = { client: null, pending: new Map(), nextId: 1, error: null };

function bridgeOriginAllowed(origin) {
  if (!origin) return false;
  if (origin === new URL(LIVE_URL).origin || BRIDGE_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function readBody(req, limit = 16 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const bridgeServer = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost"].includes(host) || !bridgeOriginAllowed(origin)) {
    res.writeHead(403).end();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "content-type",
      // Chrome asks before a public site reaches the local machine.
      "Access-Control-Allow-Private-Network": "true",
      "Access-Control-Max-Age": "600",
    }).end();
    return;
  }
  const { pathname } = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write("retry: 2000\n\n");
    // One editor at a time: the newest tab wins, the older one stands down.
    if (bridge.client) {
      bridge.client.write("event: replaced\ndata: {}\n\n");
      bridge.client.end();
    }
    bridge.client = res;
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      if (bridge.client === res) bridge.client = null;
    });
    return;
  }
  if (req.method === "POST" && pathname === "/reply") {
    try {
      const reply = JSON.parse(await readBody(req));
      const waiter = bridge.pending.get(reply.id);
      if (waiter) {
        bridge.pending.delete(reply.id);
        clearTimeout(waiter.timer);
        if (reply.ok) waiter.resolve(reply.result);
        else waiter.reject(new Error(reply.error ?? "MMLisp Live reported an error"));
      }
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }
  res.writeHead(404).end();
});
// A taken port is usually the server of an AI session that is closing (a
// reload starts this one before the old one exits), so keep trying for it.
bridgeServer.on("error", (e) => {
  bridge.error = e.code === "EADDRINUSE"
    ? `port ${BRIDGE_PORT} is taken — most likely by the MMLisp MCP server of another AI session; this server takes it once that one exits. ` +
      "Close that session, or start this server with MMLISP_BRIDGE_PORT set to a free port and open MMLisp Live with ?ai-bridge=<that port>."
    : `the MMLisp Live bridge could not start: ${e.message}`;
  if (e.code === "EADDRINUSE") setTimeout(listenBridge, 2000).unref();
});
bridgeServer.on("listening", () => { bridge.error = null; });
const listenBridge = () => bridgeServer.listen(BRIDGE_PORT, "127.0.0.1");
listenBridge();

function bridgeConnectHint() {
  if (bridge.error) return bridge.error;
  const url = new URL(LIVE_URL);
  url.hash = "";
  url.searchParams.set("ai-bridge", String(BRIDGE_PORT));
  return "MMLisp Live is not connected. Ask the user to open " + url.href +
    " — or, in an open MMLisp Live, turn on Tools > Connect to AI — on this computer, in Chrome or Edge (the browser may ask to allow access to the local network).";
}

function askLive(op, args = {}, timeoutMs = 20000) {
  if (!bridge.client) return Promise.reject(new Error(bridgeConnectHint()));
  const id = bridge.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      reject(new Error(`MMLisp Live did not answer '${op}' within ${timeoutMs / 1000} s — is the tab still open?`));
    }, timeoutMs);
    bridge.pending.set(id, { resolve, reject, timer });
    bridge.client.write(`event: request\ndata: ${JSON.stringify({ id, op, args })}\n\n`);
  });
}

function liveDiagnostics(diags, src = "") {
  if (!diags?.length) return "diagnostics: none";
  const errors = diags.filter((d) => d.severity === "error").length;
  return [`diagnostics: ${errors} error(s), ${diags.length - errors} warning(s)`, ...formatDiagnostics(diags, src)].join("\n");
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const scoreProps = {
  source: { type: "string", description: "MMLisp score text. Imports like \"presets/gm/set.mmlisp\" resolve against the repository root." },
  path: { type: "string", description: "A .mmlisp file instead of `source` (repo-relative or absolute)." },
  filename: { type: "string", description: "Name reported for `source` (default untitled.mmlisp)." },
};

const TOOLS = [
  {
    name: "mmlisp_check",
    description:
      "Compile an MMLisp score with the real compiler and report diagnostics (with the offending source line), " +
      "a per-track summary (notes written, pitch range, and how many ticks/bars the track plays with its loops unrolled — compare tracks to catch length drift) and the song length in seconds. " +
      "Run this after every edit — a score with errors plays wrong or not at all.",
    inputSchema: {
      type: "object",
      properties: { ...scoreProps, pal: { type: "boolean", description: "Compile for 50 Hz PAL (default 60 Hz NTSC)." } },
    },
    run(args) {
      const { ir, diagnostics, src } = compile(args);
      const errors = diagnostics.filter((d) => d.severity === "error").length;
      const head = errors ? `${errors} error(s), ${diagnostics.length - errors} warning(s)` :
        diagnostics.length ? `OK with ${diagnostics.length} warning(s)` : "OK";
      return [head, ...formatDiagnostics(diagnostics, src), "", "tracks:", ...trackSummary(ir), timing(ir)].join("\n");
    },
  },
  {
    name: "mmlisp_ir",
    description: "Compile a score and return its IR JSON (docs/ir.md), optionally only one track. Use to check exactly what a form compiled to.",
    inputSchema: {
      type: "object",
      properties: { ...scoreProps, track: { type: "string", description: "Only this channel, e.g. \"fm1\"." } },
    },
    run(args) {
      const { ir, diagnostics, src } = compile(args);
      const out = args.track ? { ...ir, tracks: ir.tracks.filter((t) => t.channel === args.track) } : ir;
      return formatDiagnostics(diagnostics, src).concat(JSON.stringify(out, null, 1)).join("\n");
    },
  },
  {
    name: "mmlisp_format",
    description: "Format MMLisp source with the project formatter (same as the editor). Returns the formatted text; with `path` and write:true rewrites the file.",
    inputSchema: {
      type: "object",
      properties: { ...scoreProps, write: { type: "boolean", description: "With `path`: write the result back." } },
    },
    run(args) {
      const { src } = readScore(args);
      const out = formatMMLisp(src, parse);
      if (args.write && args.path) {
        fs.writeFileSync(path.resolve(ROOT, args.path), out);
        return out === src ? "already formatted" : `formatted ${args.path}`;
      }
      return out;
    },
  },
  {
    name: "mmlisp_render",
    description:
      "Render a score to a 48 kHz stereo WAV the user can listen to (FM + PSG through the Nuked cores, same DSP as the " +
      "editor's WAV export; PCM/DAC tracks are not rendered). A looping song plays intro + 2 loops + 4 s fade. " +
      "Returns the file path and levels (peak/RMS, clipping, silence) — a sanity check, since you cannot hear it.",
    inputSchema: {
      type: "object",
      properties: {
        ...scoreProps,
        out: { type: "string", description: "Output .wav path (default: a file in the system temp dir)." },
        lpf: { type: "boolean", description: "Apply the Mega Drive analog low-pass (default off)." },
      },
    },
    async run(args) {
      const { ir, diagnostics, src, name } = compile(args);
      const errors = diagnostics.filter((d) => d.severity === "error");
      if (errors.length) return { isError: true, text: ["not rendered — fix the errors first:", ...formatDiagnostics(errors, src)].join("\n") };
      const player = new IRPlayer(() => {}).loadJSON(ir);
      const wav = await renderWav(player, { lpfOn: !!args.lpf });
      const out = args.out
        ? path.resolve(ROOT, args.out)
        : path.join(os.tmpdir(), "mmlisp-mcp", path.basename(name).replace(/\.mmlisp$/, "") + ".wav");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, wav.bytes);
      const pcm = wav.pcmCount ? `\nnote: ${wav.pcmCount} PCM events were not rendered (FM + PSG only)` : "";
      return `wrote ${out}\n${wav.durationSec.toFixed(2)} s, ${levels(wav.bytes)}${pcm}`;
    },
  },
  {
    name: "mmlisp_live",
    description:
      "Open a score in MMLisp Live, the browser editor: returns a share link carrying the score in its fragment " +
      "(the same link File > Share… makes — nothing is uploaded). The user clicks it to play and keep editing. " +
      "Imports resolve from the site, so presets work; local wav files and imports outside the repository do not travel. " +
      "open:true also launches the default browser (when the server runs on the user's machine).",
    inputSchema: {
      type: "object",
      properties: {
        ...scoreProps,
        base: { type: "string", description: `Live app URL (default ${LIVE_URL}; env MMLISP_LIVE_URL). Local dev server: http://localhost:5173/live/` },
        open: { type: "boolean", description: "Also open the link in the default browser." },
      },
    },
    run(args) {
      const { src, name } = readScore(args);
      const link = liveLink(src, typeof args.source === "string" ? args.filename : name, args.base);
      let broken;
      try {
        const n = compile(args).diagnostics.filter((d) => d.severity === "error").length;
        broken = n && `${n} error(s)`;
      } catch (e) {
        broken = e.message;
      }
      const notes = [];
      if (broken) notes.push(`warning: the score does not compile (${broken}) — run mmlisp_check`);
      if (link.length > 8000) notes.push(`warning: the link is ${link.length} characters; some chat apps cut long links`);
      if (args.open) notes.push(openBrowser(link));
      return [link, ...notes].join("\n");
    },
  },
  {
    name: "live_status",
    description:
      "Whether MMLisp Live (the user's browser editor) is connected to this server, and what it has open. " +
      "When it is not, the answer says how the user connects it.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const st = await askLive("status");
      return `connected: ${st.app}\nfile: ${st.fileName} (${st.lines} lines)\nplaying: ${st.playing ? "yes" : "no"}`;
    },
  },
  {
    name: "live_read",
    description:
      "Read the score open in MMLisp Live: its exact text (copy `find` strings for live_write from here), the cursor line, " +
      "the selection, whether it is playing, and the compiler's diagnostics. Read before editing — the user edits too.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const r = await askLive("read");
      const sel = r.selection ? `selection: lines ${r.selection.fromLine}-${r.selection.toLine}\n${r.selection.text}\n` : "selection: none\n";
      return `file: ${r.fileName}, cursor line ${r.cursorLine}, playing: ${r.playing ? "yes" : "no"}\n${sel}` +
        `${liveDiagnostics(r.diagnostics, r.text)}\n--- score ---\n${r.text}`;
    },
  },
  {
    name: "live_write",
    description:
      "Edit the score open in MMLisp Live. Prefer `edits`: [{find, replace}], each `find` an exact piece of the current text " +
      "(from live_read) that occurs exactly once — the user's other edits survive. `source` replaces the whole score. " +
      "The change is one undoable step in the editor, and is logged there. Then it builds (build:false to skip): " +
      "while playing, the new score takes over at the next bar. Returns the diagnostics.",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { find: { type: "string" }, replace: { type: "string" } },
            required: ["find", "replace"],
          },
        },
        source: { type: "string", description: "The whole new score, instead of edits." },
        build: { type: "boolean", description: "Build after editing (default true)." },
      },
    },
    async run(args) {
      if (typeof args.source !== "string" && !args.edits?.length) throw new Error("give `edits` or `source`");
      const r = await askLive("write", { source: args.source, edits: args.edits, build: args.build ?? true });
      return `applied ${r.applied} change(s); ${r.lines} lines; playing: ${r.playing ? "yes" : "no"}\n${liveDiagnostics(r.diagnostics)}`;
    },
  },
  {
    name: "live_play",
    description:
      "Start playback in MMLisp Live, from the top or from a source line. A browser starts audio only after the user has " +
      "clicked the page once; until then a Play button is put up for them instead.",
    inputSchema: { type: "object", properties: { line: { type: "integer", description: "1-based source line to start from." } } },
    async run(args) {
      const r = await askLive("play", { line: args.line }, 30000);
      return r.started ? `playing${r.fromLine ? ` from line ${r.fromLine}` : ""}` : `not started: ${r.reason ?? "unknown"}`;
    },
  },
  {
    name: "live_stop",
    description: "Stop playback in MMLisp Live.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      await askLive("stop");
      return "stopped";
    },
  },
  {
    name: "mmlisp_docs",
    description:
      "Read the MMLisp documentation. doc: cheatsheet (the whole language on two pages — read it first), " +
      "language (the reference, canonical), guide (the tutorial), ir, roadmap. " +
      "cheatsheet with no section: all of it; any other doc with no section: its table of contents. " +
      "section: a number (\"10\", \"9.2\") or title words. query: search lines.",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", enum: Object.keys(DOCS) },
        section: { type: "string" },
        query: { type: "string" },
      },
    },
    run: readDoc,
  },
  {
    name: "mmlisp_snippets",
    description:
      "Working example scores, one technique each (arps, echo, curves, FM3, PCM kits, song structure…). " +
      "No args: list them with what each shows; query: filter by name or content; path: read one.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, path: { type: "string", description: "e.g. \"techniques/chip-arp.mmlisp\"" } },
    },
    run: snippets,
  },
  {
    name: "mmlisp_presets",
    description:
      "Preset voice/sample sets a score can import. No args: the sets and their import lines. " +
      "set: list its voice/sample names (e.g. gm, waveforms, 808, 909, gm-drums); query: filter names.",
    inputSchema: {
      type: "object",
      properties: { set: { type: "string" }, query: { type: "string" } },
    },
    run: presets,
  },
];

const INSTRUCTIONS = `MMLisp is a Lisp-like DSL for Sega Mega Drive music (YM2612 FM fm1-fm6, PSG sqr1-3/noise, PCM).
Workflow for writing a score:
1. Before writing, read the cheat sheet: mmlisp_docs (doc "cheatsheet"). For anything it only names, read that section of the reference (doc "language", section "10" …).
2. Start from a similar snippet (mmlisp_snippets) and preset voices (mmlisp_presets) rather than inventing syntax.
3. After every edit run mmlisp_check and fix every error; do not guess at syntax a diagnostic rejects — look it up.
4. Compare the tracks' lengths in mmlisp_check's summary — tracks that should line up must play the same number of ticks.
5. To let the user hear it: mmlisp_live gives a link that opens the score in MMLisp Live (the editor, ready to play and edit);
   mmlisp_render writes a WAV. You cannot hear either — render levels only tell you if something is silent or clipping.
6. When the user works in MMLisp Live with the AI connection on, work in their editor: live_read, then live_write with
   small {find, replace} edits (each is one undoable step for them), and live_play. live_status says how to connect.`;

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mmlisp", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS.map(({ run: _r, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `unknown tool ${params.name}`);
      try {
        const r = await tool.run(params.arguments ?? {});
        const { text, isError } = typeof r === "string" ? { text: r, isError: false } : r;
        return reply(id, { content: [{ type: "text", text }], isError });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
      }
    }
    default:
      if (id !== undefined && !method?.startsWith("notifications/")) fail(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
// The host closing stdin ends the session — and the bridge's port with it.
rl.on("close", () => process.exit(0));
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "parse error");
  }
  handle(msg).catch((e) => msg.id !== undefined && fail(msg.id, -32603, String(e?.message ?? e)));
});

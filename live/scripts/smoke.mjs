#!/usr/bin/env node
// The live app's boot smoke, headless: what a page split can break silently.
//
//   - the page boots (its late entry point is defined) with no page error,
//     no console error and no failed same-origin request;
//   - every inline handler in the DOM names a function on `window` — the
//     static markup's and those the menus, strips and panels write at run time
//     (each menu and panel tab is opened first);
//   - one score per machine loads, builds with no error in the log, and plays:
//     the worklet gets chip writes within a second and a half.
//
// It serves the repo root itself (as `npm run serve` does) and drives the
// installed Google Chrome through playwright-core (live/node_modules).
//
//   cd live && npm run smoke

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png",
  ".webmanifest": "application/manifest+json", ".mmlisp": "text/plain", ".wav": "audio/wav",
};

const SCORES = [
  "examples/daisy-bell.mmlisp",
  "tools/tests/pc88/fm.mmlisp", "tools/tests/x68k/fm.mmlisp", "tools/tests/msx/psg.mmlisp", "tools/tests/pce/wave.mmlisp",
  "tools/tests/fc/apu.mmlisp", "tools/tests/gb/apu.mmlisp", "tools/tests/midi/channels.mmlisp",
];

const server = createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = normalize(join(root, url));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const problems = [];
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.addInitScript(() => {
    window.__writes = 0;
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (m, ...rest) {
      // A chip's register writes, or the GM output's MIDI events (:target midi).
      if (m && typeof m === "object" && (/write/i.test(String(m.type)) || m.type === "midi")) window.__writes++;
      return post.call(this, m, ...rest);
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console error: ${m.text()}`); });
  page.on("requestfailed", (r) => { if (r.url().startsWith(base)) problems.push(`request failed: ${r.url()}`); });
  page.on("response", (r) => { if (r.url().startsWith(base) && r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });

  await page.goto(`${base}/live/`);
  await page.waitForFunction(() => typeof window.releaseHoldsAction === "function", null, { timeout: 30000 });
  await page.waitForTimeout(500);

  // Open every menu and panel tab so their run-time handlers are written.
  await page.evaluate(async () => {
    for (const b of document.querySelectorAll(".menu-btn")) { b.click(); await new Promise((r) => setTimeout(r, 30)); }
    window.closeMenus?.();
    for (const t of document.querySelectorAll("[onclick*='selectPanelTab']")) { t.click(); await new Promise((r) => setTimeout(r, 50)); }
  });
  // A first launch opens New Score; any dialog open now would take the clicks.
  const closeDialogs = () => page.evaluate(() => {
    for (const m of document.querySelectorAll(".modal-overlay")) if (!m.hidden && m.id) window.closeInfoModal(m.id);
  });
  await closeDialogs();
  const unresolved = await page.evaluate(() => {
    const bad = new Set();
    const skip = new Set(["event", "this", "if", "return", "document", "window"]);
    for (const el of document.querySelectorAll("*")) {
      for (const a of el.attributes) {
        if (!a.name.startsWith("on")) continue;
        for (const m of a.value.matchAll(/(?:^|[;\s(!])([A-Za-z_$][\w$]*)\s*\(/g)) {
          const id = m[1];
          if (skip.has(id)) continue;
          if (typeof window[id] !== "function") bad.add(`${id} (${el.tagName.toLowerCase()} ${a.name})`);
        }
      }
    }
    return [...bad];
  });
  for (const u of unresolved) problems.push(`unresolved handler: ${u}`);

  for (const s of SCORES) {
    const path = s;
    const src = await readFile(join(root, path), "utf8");
    await page.evaluate(() => window.onStop?.());
    await closeDialogs();
    await page.click(".cm-content");
    await page.keyboard.press("Meta+A");
    await page.keyboard.insertText(src);
    const logBefore = await page.locator("#log > div").count();
    await page.evaluate(() => window.buildAction());
    await page.waitForTimeout(400);
    const errs = await page.evaluate((n) =>
      [...document.querySelectorAll("#log > div")].slice(n).filter((d) => d.classList.contains("err")).map((d) => d.textContent), logBefore);
    for (const e of errs) problems.push(`${path}: log error: ${e}`);
    // A fresh profile has no MIDI output: :target midi sounds through the GM one.
    if (path.includes("/midi/")) await page.evaluate(() => window.selectMidiOut("mmlisp:gm"));
    const w0 = await page.evaluate(() => window.__writes);
    await page.click("#btnPlay");
    // :target midi waits for its SoundFont before the first event goes out.
    await page.waitForFunction((n) => window.__writes > n, w0, { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);
    const writes = (await page.evaluate(() => window.__writes)) - w0;
    await page.evaluate(() => window.onStop?.());
    console.log(`${writes > 0 ? "ok  " : "FAIL"} ${path.padEnd(40)} ${writes} write messages`);
    if (!writes) problems.push(`${path}: no chip writes while playing`);
  }
} finally {
  await browser.close();
  server.close();
}

for (const p of problems) console.log("  " + p);
console.log(problems.length ? `\nsmoke: ${problems.length} problem(s)` : "\nsmoke: clean");
process.exit(problems.length ? 1 : 0);

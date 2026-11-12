#!/usr/bin/env node
// The Live app's type sizes stay the tokens in style.css's :root (--text,
// --label, --mark): a size written as a number anywhere else is how they
// became seventeen. The editor's own size is a preference, the alg diagram's
// digits scale with their box, and a video frame's text is frame pixels.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const live = join(dirname(fileURLToPath(import.meta.url)), "../../live");
const files = [
  "style.css",
  "index.html",
  ...readdirSync(join(live, "src"), { recursive: true })
    .filter((f) => f.endsWith(".js"))
    .map((f) => `src/${f}`),
];

const FRAME_PIXELS = /ctx\.font = "(700 46|400 28)px 'Open Sans'/; // the video take's title and footer
const NUMBER_SIZE = /font-size:\s*[\d.]|\bfont:\s*(?:[a-z0-9]+\s+)*[\d.]+(?:px|rem|em|pt)|\.font\s*=\s*[`'"](?:[a-z0-9]+\s+)*[\d.]+(?:px|rem|em|pt)|\.fontSize\s*=\s*[`'"]?[\d.]/;

const bad = [];
for (const f of files) {
  readFileSync(join(live, f), "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (NUMBER_SIZE.test(line) && !FRAME_PIXELS.test(line))
        bad.push(`${relative(join(live, ".."), join(live, f))}:${i + 1}: ${line.trim()}`);
    });
}

if (bad.length) {
  console.error(`${bad.length} size(s) outside the tokens (--text, --label, --mark):`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`font sizes: ${files.length} files hold to the tokens`);

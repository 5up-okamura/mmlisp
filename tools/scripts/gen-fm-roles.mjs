#!/usr/bin/env node
// presets/fm-roles/set.mmlisp, read off presets/gm: the fifteen melodic roles
// (language.md §19) as FM voices, so `piano` on a machine with 4-op FM is a
// voice made for it and not the OPLL's read as 4-op. Each is its gm voice's text
// under the role's name; a role is changed by choosing another here.
//
//   node scripts/gen-fm-roles.mjs           write the set
//   node scripts/gen-fm-roles.mjs --check   fail if it is not what this writes

import { readFileSync, writeFileSync } from "node:fs";
import { formatMMLisp } from "../../live/src/mmlisp-formatter.js";
import { parse } from "../../live/src/mmlisp-parser.js";

const ROLES = {
  piano: "gm-piano",
  harpsichord: "gm-harpsi",
  vibraphone: "gm-vibes",
  organ: "gm-organ-drawbar",
  guitar: "gm-guitar-nylon",
  "electric-guitar": "gm-guitar-clean",
  "acoustic-bass": "gm-bass-acoustic",
  "synth-bass": "gm-bass-syn1",
  violin: "gm-violin",
  trumpet: "gm-trumpet",
  horn: "gm-horn",
  oboe: "gm-oboe",
  clarinet: "gm-clarinet",
  flute: "gm-flute",
  synth: "gm-lead-saw",
};

const gm = readFileSync(new URL("../../presets/gm/set.mmlisp", import.meta.url), "utf8");
const lines = gm.split("\n");
const defs = new Map(parse(gm).filter((n) => n.kind === "list" && n.items[0]?.value === "def-fm")
  .map((n) => [n.items[1].value, n]));

const voice = ([role, from]) => {
  const node = defs.get(from);
  if (!node) throw new Error(`gm has no ${from}`);
  const text = lines.slice(node.line - 1, node.endLine).join("\n");
  return `; ${from}\n${text.replace(`(def-fm ${from}`, `(def-fm ${role}`)}\n`;
};

const head = `; The melodic roles as FM voices, for the machines with 4-op FM: with this set
; imported, \`piano\` is a voice of its own and not the OPLL's read as 4-op. A
; machine with the OPLL has its ROM's. Written by tools/scripts/gen-fm-roles.mjs,
; from presets/gm; choose another voice there. See README.md.
`;
const text = formatMMLisp([head, ...Object.entries(ROLES).map(voice)].join("\n"), parse);

const path = new URL("../../presets/fm-roles/set.mmlisp", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== text) {
    console.error("presets/fm-roles/set.mmlisp is not what gen-fm-roles.mjs writes");
    process.exit(1);
  }
  console.log(`fm-roles: ${Object.keys(ROLES).length} voices as generated`);
} else {
  writeFileSync(path, text);
  console.log(`wrote ${Object.keys(ROLES).length} voices`);
}

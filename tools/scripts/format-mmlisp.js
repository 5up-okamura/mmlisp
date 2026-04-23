#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("./mmlisp_parser");

const INDENT = "  ";
const MAX_INLINE_LENGTH = 72;
const LABELLED_FORMS = new Set(["track", "defn"]);
const KEYWORD_VALUE_KEYS = [
  ":author",
  ":title",
  ":tempo",
  ":loop",
  ":role",
  ":len",
  ":ch",
  ":id",
  ":oct",
  ":gate",
  ":shuffle",
];
const COLLAPSE_STRING_KEYS = new Set([":title", ":author"]);

function isKeyword(node) {
  return node && node.kind === "atom" && node.value.startsWith(":");
}

function cloneAtom(source, value) {
  return {
    kind: "atom",
    value,
    line: source.line,
    column: source.column,
  };
}

function normalizeListItems(items) {
  const out = [];
  for (const item of items) {
    if (item.kind === "list") {
      out.push({
        ...item,
        items: normalizeListItems(item.items),
      });
      continue;
    }

    if (item.kind !== "atom") {
      out.push(item);
      continue;
    }

    let split = false;
    for (const key of KEYWORD_VALUE_KEYS) {
      if (item.value === key || !item.value.startsWith(key)) {
        continue;
      }
      const rest = item.value.slice(key.length);
      if (!rest) {
        continue;
      }
      // Only split if the remainder looks like a value (digit, +/- followed by digit,
      // or a quoted string start), not a keyword continuation (letter or hyphen).
      if (/^[a-zA-Z-]/.test(rest)) {
        continue;
      }
      out.push(cloneAtom(item, key));
      out.push(cloneAtom(item, rest));
      split = true;
      break;
    }

    if (!split) {
      out.push(item);
    }
  }
  return out;
}

function normalizeRoots(roots) {
  return roots.map((root) => {
    if (root.kind !== "list") {
      return root;
    }
    return {
      ...root,
      items: normalizeListItems(root.items),
    };
  });
}

function normalizeStringForKey(key, value) {
  if (!COLLAPSE_STRING_KEYS.has(key)) {
    return value;
  }
  return value.replace(/\s+/g, " ").trim();
}

function escapeString(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\"/g, '\\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

function nodeToInline(node) {
  if (node.kind === "atom") {
    return node.value;
  }
  if (node.kind === "string") {
    return `"${escapeString(node.value)}"`;
  }
  if (node.kind !== "list") {
    return null;
  }

  const open = node.bracket[0];
  const close = node.bracket[1];
  if (node.items.length === 0) {
    return `${open}${close}`;
  }

  const parts = [];
  for (const item of node.items) {
    const part = nodeToInline(item);
    if (part === null) {
      return null;
    }
    parts.push(part);
  }

  const joined = `${open}${parts.join(" ")}${close}`;
  if (open === "(" && joined.length > MAX_INLINE_LENGTH) {
    // seq forms stay on one line regardless of length
    if (parts.length > 0 && parts[0] === "seq") {
      return joined;
    }
    return null;
  }
  return joined;
}

function indentBlock(text, prefix) {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${prefix}${line}`))
    .join("\n");
}

function collectKeywordPairs(items, startIndex) {
  const pairs = [];
  let index = startIndex;
  while (index + 1 < items.length && isKeyword(items[index])) {
    pairs.push([items[index], items[index + 1]]);
    index += 2;
  }
  return { pairs, nextIndex: index };
}

function collectLeadArgs(items, startIndex, headSymbol) {
  const leadArgs = [];
  let index = startIndex;

  while (index < items.length) {
    if (
      LABELLED_FORMS.has(headSymbol) &&
      index === 1 &&
      isKeyword(items[index]) &&
      isKeyword(items[index + 1])
    ) {
      leadArgs.push(items[index]);
      index += 1;
      continue;
    }

    if (index + 1 < items.length && isKeyword(items[index])) {
      break;
    }

    // Stop at nested forms; these belong to the body section.
    if (items[index].kind === "list") {
      break;
    }

    leadArgs.push(items[index]);
    index += 1;
  }

  return { leadArgs, nextIndex: index };
}

function formatAlignedVectors(vectors) {
  if (vectors.length === 0) return [];

  const rows = vectors.map((vec) => {
    if (vec.kind !== "list" || vec.bracket[0] !== "[") return null;
    return vec.items.map((item) => {
      const inline = nodeToInline(item);
      return inline !== null ? inline : formatNode(item);
    });
  });

  const validRows = rows.filter((r) => r !== null);
  if (validRows.length === 0) return vectors.map((v) => formatNode(v));

  const numCols = Math.max(...validRows.map((r) => r.length));
  const colWidths = Array.from({ length: numCols }, (_, c) =>
    Math.max(...validRows.map((r) => (c < r.length ? r[c].length : 0))),
  );

  return vectors.map((vec, i) => {
    if (rows[i] === null) return formatNode(vec);
    const padded = rows[i].map((item, c) => item.padStart(colWidths[c]));
    return `[${padded.join(" ")}]`;
  });
}

function formatDefVoice(node) {
  // (def <name> :fm <ch-vec> <op-vec>...)
  const name = formatNode(node.items[1]);
  const tag = node.items[2].value;
  const chVec = node.items[3];
  const opVecs = node.items.slice(4);

  const chInline = nodeToInline(chVec);
  const chLine = chInline !== null ? chInline : formatNode(chVec);
  const opLines = formatAlignedVectors(opVecs);

  const lines = [`(def ${name} ${tag}`, `${INDENT}${chLine}`];
  for (let i = 0; i < opLines.length; i++) {
    const suffix = i === opLines.length - 1 ? ")" : "";
    lines.push(`${INDENT}${opLines[i]}${suffix}`);
  }
  if (opLines.length === 0) {
    lines.push(")");
  }
  return lines.join("\n");
}

function formatList(node) {
  const inline = nodeToInline(node);
  if (inline !== null) {
    return inline;
  }

  // Special case: (def <name> :fm <ch-vec> <op-vec>...)
  if (
    node.items.length >= 4 &&
    node.items[0].kind === "atom" &&
    node.items[0].value === "def" &&
    node.items[2].kind === "atom" &&
    node.items[2].value === ":fm"
  ) {
    return formatDefVoice(node);
  }

  const open = node.bracket[0];
  const close = node.bracket[1];
  const indent = "";
  const childIndent = INDENT;

  if (node.items.length === 0) {
    return `${open}${close}`;
  }

  if (open === "[") {
    // Fallback for long vectors; keep one item per line.
    const lines = [open];
    for (const item of node.items) {
      lines.push(indentBlock(formatNode(item), childIndent));
    }
    lines.push(`${indent}${close}`);
    return lines.join("\n");
  }

  const head = formatNode(node.items[0]);
  const headSymbol = node.items[0].kind === "atom" ? node.items[0].value : "";
  const { leadArgs, nextIndex: pairStartIndex } = collectLeadArgs(
    node.items,
    1,
    headSymbol,
  );
  const leadText = leadArgs.map((arg) => formatNode(arg)).join(" ");
  const lines = [leadText ? `(${head} ${leadText}` : `(${head}`];

  const { pairs, nextIndex } = collectKeywordPairs(node.items, pairStartIndex);
  let pairOffset = 0;
  if (leadArgs.length === 0 && pairs.length > 0) {
    const firstKey = formatNode(pairs[0][0]);
    const firstValue = formatNode(pairs[0][1]);
    if (!firstValue.includes("\n")) {
      lines[0] = `${lines[0]} ${firstKey} ${firstValue}`;
      pairOffset = 1;
    }
  }

  for (let i = pairOffset; i < pairs.length; i += 1) {
    const [keyNode, valueNode] = pairs[i];
    const keyText = formatNode(keyNode);
    let valueText = formatNode(valueNode);
    if (valueNode.kind === "string") {
      valueText = `"${escapeString(normalizeStringForKey(keyText, valueNode.value))}"`;
    }
    if (!valueText.includes("\n")) {
      lines.push(`${childIndent}${keyText} ${valueText}`);
      continue;
    }

    const valueLines = valueText.split("\n");
    lines.push(`${childIndent}${keyText} ${valueLines[0]}`);
    for (let i = 1; i < valueLines.length; i += 1) {
      lines.push(`${childIndent}${valueLines[i]}`);
    }
  }

  const bodyItems = node.items.slice(nextIndex);
  if (pairs.length > 0 && bodyItems.length > 0) {
    lines.push("");
  }

  let previousLine = node.items[0].line || 0;
  for (let i = 0; i < bodyItems.length; i += 1) {
    const child = bodyItems[i];
    if (i > 0) {
      const gap = (child.line || 0) - previousLine;
      if (gap > 1) {
        lines.push("");
      }
    }
    const childText = formatNode(child);
    lines.push(indentBlock(childText, childIndent));
    previousLine = child.line || previousLine;
  }

  lines.push(`${indent})`);
  return lines.join("\n");
}

function formatNode(node) {
  if (node.kind === "atom") {
    return node.value;
  }
  if (node.kind === "string") {
    return `"${escapeString(node.value)}"`;
  }
  if (node.kind === "list") {
    return formatList(node);
  }
  throw new Error(`Unsupported node kind: ${node.kind}`);
}

function leadingTrivia(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith(";")) {
      kept.push(lines[i].replace(/\s+$/g, ""));
      i += 1;
      continue;
    }
    break;
  }

  while (kept.length > 0 && kept[kept.length - 1] === "") {
    kept.pop();
  }

  return kept.join("\n");
}

function formatSource(source) {
  const roots = normalizeRoots(parse(source));
  const formattedRoots = roots.map((root) => formatNode(root)).join("\n\n");
  const lead = leadingTrivia(source);
  const combined = lead ? `${lead}\n\n${formattedRoots}` : formattedRoots;
  return `${combined.trimEnd()}\n`;
}

function parseArgs(argv) {
  const files = [];
  let check = false;
  let stdout = false;

  for (const arg of argv) {
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--stdout") {
      stdout = true;
      continue;
    }
    files.push(arg);
  }

  if (files.length === 0) {
    throw new Error(
      "Usage: node scripts/format-mmlisp.js [--check|--stdout] <file...>",
    );
  }

  return { files, check, stdout };
}

function main() {
  const { files, check, stdout } = parseArgs(process.argv.slice(2));
  let changed = false;

  for (const target of files) {
    const filePath = path.resolve(process.cwd(), target);
    const input = fs.readFileSync(filePath, "utf8");
    const output = formatSource(input);

    if (stdout) {
      process.stdout.write(output);
      continue;
    }

    if (input !== output) {
      changed = true;
      if (!check) {
        fs.writeFileSync(filePath, output, "utf8");
        process.stdout.write(`formatted ${target}\n`);
      }
    }
  }

  if (check && changed) {
    process.stderr.write("Some MMLisp files are not formatted.\n");
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

let parse; // assigned in main() via dynamic import

const INDENT = "  ";
const MAX_INLINE_LENGTH = 72;
const LABELLED_FORMS = new Set(["track", "defn"]);
const KEYWORD_VALUE_KEYS = [
  ":author",
  ":title",
  ":tempo",
  ":loop",
  ":loop-start",
  ":loop-end",
  ":role",
  ":len",
  ":ch",
  ":id",
  ":oct",
  ":gate",
  ":shuffle",
  ":csm-rate",
  ":rate",
  ":mode",
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

  // A trailing line comment on the same line is allowed; internal/leading comments are not.
  const nonCommentItems = node.items.filter((item) => item.kind !== "comment");
  const commentItems = node.items.filter((item) => item.kind === "comment");
  const trailingComment =
    commentItems.length === 1 &&
    node.items[node.items.length - 1].kind === "comment"
      ? commentItems[0]
      : null;
  if (commentItems.length > 0 && !trailingComment) {
    return null;
  }

  // Don't inline a form whose non-comment items span multiple source lines —
  // the author intentionally broke it across lines.
  const firstLine =
    nonCommentItems.length > 0 ? nonCommentItems[0].line || 0 : 0;
  if (
    firstLine > 0 &&
    nonCommentItems.some((item) => (item.line || 0) > firstLine)
  ) {
    return null;
  }

  // A trailing comment must be on the same source line.
  if (trailingComment && (trailingComment.line || 0) > firstLine) {
    return null;
  }

  const parts = [];
  for (const item of nonCommentItems) {
    const part = nodeToInline(item);
    if (part === null) {
      return null;
    }
    parts.push(part);
  }

  const joined = trailingComment
    ? `${open}${parts.join(" ")}${close} ${trailingComment.value}`
    : `${open}${parts.join(" ")}${close}`;
  if (open === "(" && joined.length > MAX_INLINE_LENGTH) {
    // seq forms stay on one line regardless of length
    if (parts.length > 0 && parts[0] === "seq") {
      return joined;
    }
    return null;
  }
  return joined;
}

/**
 * Join atoms preserving the original inter-token spacing from source columns.
 * Falls back to a single space when column info is unavailable.
 */
function joinAtomsWithSourceSpacing(atoms) {
  if (atoms.length === 0) return "";
  let result = atoms[0].text;
  for (let i = 1; i < atoms.length; i += 1) {
    const prev = atoms[i - 1];
    const curr = atoms[i];
    const gap =
      prev.column > 0 && curr.column > 0
        ? curr.column - (prev.column + prev.value.length)
        : 1;
    result += " ".repeat(Math.max(1, gap)) + curr.text;
  }
  return result;
}

function indentBlock(text, prefix) {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? "" : `${prefix}${line}`))
    .join("\n");
}

function collectKeywordPairs(items, startIndex) {
  const pairs = []; // each entry: [keyNode, valueNode, trailingComment | null]
  let index = startIndex;
  while (index < items.length) {
    // Skip comments between pairs; they'll be handled separately.
    if (items[index].kind === "comment") {
      index += 1;
      continue;
    }
    if (index + 1 >= items.length || !isKeyword(items[index])) break;
    const keyNode = items[index];
    const valueNode = items[index + 1];
    index += 2;
    // Attach a trailing comment on the same source line.
    let trailingComment = null;
    if (
      index < items.length &&
      items[index].kind === "comment" &&
      (items[index].line || 0) === (keyNode.line || 0)
    ) {
      trailingComment = items[index];
      index += 1;
    }
    pairs.push([keyNode, valueNode, trailingComment]);
  }
  return { pairs, nextIndex: index };
}

function collectLeadArgs(items, startIndex, headSymbol) {
  const leadArgs = [];
  let index = startIndex;
  // Track the source line of the previous item to detect intentional line breaks.
  let prevLine = index > 0 ? items[index - 1].line || 0 : 0;

  while (index < items.length) {
    if (
      LABELLED_FORMS.has(headSymbol) &&
      index === 1 &&
      isKeyword(items[index]) &&
      isKeyword(items[index + 1])
    ) {
      leadArgs.push(items[index]);
      prevLine = items[index].line || prevLine;
      index += 1;
      continue;
    }

    if (index + 1 < items.length && isKeyword(items[index])) {
      break;
    }

    // Stop at nested forms or comments; these belong to the body section.
    if (items[index].kind === "list" || items[index].kind === "comment") {
      break;
    }

    // Respect intentional source line breaks: stop collecting when the atom
    // moves to a new line (author-inserted line break).
    const itemLine = items[index].line || 0;
    if (prevLine > 0 && itemLine > prevLine) {
      break;
    }

    leadArgs.push(items[index]);
    prevLine = itemLine || prevLine;
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
    const padded = rows[i].map((item, c) =>
      item.padStart(Math.max(2, colWidths[c])),
    );
    return `[${padded.join(" ")}]`;
  });
}

function formatDefVoice(node) {
  // (def <name> :fm [comment...] <ch-vec> [comment...] <op-vec>...)
  const name = formatNode(node.items[1]);
  const tag = node.items[2].value;

  // Find ch-vec (first non-comment item after the tag), collecting any preceding comments
  let chVecIdx = 3;
  while (
    chVecIdx < node.items.length &&
    node.items[chVecIdx].kind === "comment"
  ) {
    chVecIdx += 1;
  }
  const preChComments = node.items.slice(3, chVecIdx);
  const chVec = node.items[chVecIdx];
  const rest = node.items.slice(chVecIdx + 1); // comments + op vecs

  const opVecs = rest.filter((n) => n.kind !== "comment");
  const chInline = nodeToInline(chVec);
  const chLine = chInline !== null ? chInline : formatNode(chVec);
  const opLines = formatAlignedVectors(opVecs);

  const lines = [`(def ${name} ${tag}`];
  for (const c of preChComments) {
    lines.push(`${INDENT}${c.value}`);
  }
  lines.push(`${INDENT}${chLine}`);

  let opIdx = 0;
  for (const item of rest) {
    if (item.kind === "comment") {
      lines.push(`${INDENT}${item.value}`);
    } else {
      const suffix = opIdx === opVecs.length - 1 ? ")" : "";
      lines.push(`${INDENT}${opLines[opIdx]}${suffix}`);
      opIdx += 1;
    }
  }
  if (opVecs.length === 0) {
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
    node.items[0].kind === "atom" &&
    node.items[0].value === "def" &&
    node.items.filter((n) => n.kind !== "comment")[2]?.value === ":fm"
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
  const leadText = joinAtomsWithSourceSpacing(
    leadArgs.map((arg) => ({
      text: formatNode(arg),
      column: arg.column || 0,
      value: arg.kind === "atom" ? arg.value : formatNode(arg),
    })),
  );
  const lines = [leadText ? `(${head} ${leadText}` : `(${head}`];

  const { pairs, nextIndex } = collectKeywordPairs(node.items, pairStartIndex);
  let pairOffset = 0;
  if (leadArgs.length === 0 && pairs.length > 0) {
    const firstKey = formatNode(pairs[0][0]);
    const firstValue = formatNode(pairs[0][1]);
    if (!firstValue.includes("\n")) {
      lines[0] = `${lines[0]} ${firstKey} ${firstValue}`;
      pairOffset = 1;
      // Also absorb subsequent pairs that are on the same source line.
      const firstLine = pairs[0][0].line || 0;
      while (pairOffset < pairs.length) {
        const [kNode, vNode] = pairs[pairOffset];
        if (firstLine === 0 || (kNode.line || 0) !== firstLine) break;
        const kText = formatNode(kNode);
        const vText = formatNode(vNode);
        if (vText.includes("\n")) break;
        lines[0] = `${lines[0]} ${kText} ${vText}`;
        pairOffset += 1;
      }
      // Attach trailing comment of the last absorbed pair to the first line.
      const lastAbsorbed = pairs[pairOffset - 1];
      if (lastAbsorbed[2]) {
        lines[0] = `${lines[0]} ${lastAbsorbed[2].value}`;
      }
    }
  }

  {
    let i = pairOffset;
    while (i < pairs.length) {
      // Group consecutive pairs that share the same source line.
      const groupSourceLine = pairs[i][0].line || 0;
      const groupParts = [];
      let groupTrailingComment = null;
      while (
        i < pairs.length &&
        (groupSourceLine === 0 || (pairs[i][0].line || 0) === groupSourceLine)
      ) {
        const [keyNode, valueNode, trailingComment] = pairs[i];
        const keyText = formatNode(keyNode);
        let valueText = formatNode(valueNode);
        if (valueNode.kind === "string") {
          valueText = `"${escapeString(normalizeStringForKey(keyText, valueNode.value))}"`;
        }
        groupParts.push({ keyText, valueText });
        if (trailingComment) groupTrailingComment = trailingComment;
        i += 1;
      }

      // If any value is multiline, fall back to one pair per line.
      const hasMultiline = groupParts.some((p) => p.valueText.includes("\n"));
      if (hasMultiline) {
        for (const { keyText, valueText } of groupParts) {
          if (!valueText.includes("\n")) {
            lines.push(`${childIndent}${keyText} ${valueText}`);
          } else {
            const valueLines = valueText.split("\n");
            lines.push(`${childIndent}${keyText} ${valueLines[0]}`);
            for (let j = 1; j < valueLines.length; j += 1) {
              lines.push(`${childIndent}${valueLines[j]}`);
            }
          }
        }
      } else {
        const combined = groupParts
          .map((p) => `${p.keyText} ${p.valueText}`)
          .join(" ");
        const suffix = groupTrailingComment
          ? ` ${groupTrailingComment.value}`
          : "";
        lines.push(`${childIndent}${combined}${suffix}`);
      }
    }
  }

  const bodyItems = node.items.slice(nextIndex);

  // Track position based on last keyword-pair value so blank lines between
  // the keyword section and the body are derived from source gaps, not forced.
  let previousLine =
    pairs.length > 0
      ? pairs[pairs.length - 1][1].line || node.items[0].line || 0
      : node.items[0].line || 0;
  let previousOutputLines = 1;
  let bodyIndex = 0;
  while (bodyIndex < bodyItems.length) {
    const child = bodyItems[bodyIndex];
    const currentSourceLine = child.line || 0;

    // Group all consecutive items that share the same source line.
    const groupStart = bodyIndex;
    const groupParts = [];
    while (bodyIndex < bodyItems.length) {
      const item = bodyItems[bodyIndex];
      // A trailing line comment on the same source line is appended and ends the group.
      if (item.kind === "comment") {
        if (
          currentSourceLine > 0 &&
          (item.line || 0) === currentSourceLine &&
          groupParts.length > 0
        ) {
          groupParts.push({
            text: item.value,
            column: item.column || 0,
            value: item.value,
          });
          bodyIndex += 1;
        }
        break;
      }
      // Stop when this item moves to a new source line.
      if (currentSourceLine > 0 && (item.line || 0) > currentSourceLine) break;
      const itemText = formatNode(item);
      // Don't group items whose formatted text spans multiple lines.
      if (itemText.includes("\n")) break;
      groupParts.push({
        text: itemText,
        column: item.column || 0,
        value: item.kind === "atom" ? item.value : itemText,
      });
      bodyIndex += 1;
    }

    // If nothing was collected (e.g. a comment or multiline item), emit it alone.
    if (groupParts.length === 0) {
      const childText = formatNode(child);
      if (previousLine > 0) {
        const sourceGap = (child.line || 0) - previousLine;
        const blankLines = Math.max(0, sourceGap - 1);
        for (let g = 0; g < blankLines; g += 1) lines.push("");
      }
      lines.push(indentBlock(childText, childIndent));
      previousLine = child.endLine || child.line || previousLine;
      previousOutputLines = 1;
      bodyIndex += 1;
      continue;
    }

    const childText = joinAtomsWithSourceSpacing(groupParts);
    if (previousLine > 0) {
      const sourceGap = (child.line || 0) - previousLine;
      const blankLines = Math.max(0, sourceGap - 1);
      for (let g = 0; g < blankLines; g += 1) lines.push("");
    }
    lines.push(indentBlock(childText, childIndent));
    const lastItem = bodyItems[bodyIndex - 1];
    previousLine = lastItem.endLine || lastItem.line || previousLine;
    previousOutputLines = 1;
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
  if (node.kind === "comment") {
    return node.value;
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
  // Root-level comments are preserved via leadingTrivia; filter them here to avoid duplication.
  const formattedRoots = roots
    .filter((root) => root.kind !== "comment")
    .map((root) => formatNode(root))
    .join("\n\n");
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

async function main() {
  ({ parse } = await import("../../live/src/mmlisp-parser.js"));
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

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});

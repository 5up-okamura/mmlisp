/**
 * MMLisp source formatter — shared ES module used by both the browser live
 * editor and the Node.js CLI (tools/scripts/format-mmlisp.js).
 *
 * Usage:
 *   import { formatMMLisp } from './mmlisp-formatter.js';
 *   const formatted = formatMMLisp(sourceString, parseFn);
 *
 * `parseFn` is the `parse` export from mmlisp-parser.js.
 * No Node.js dependencies; pure string-in / string-out.
 */

const INDENT = "  ";
const MAX_INLINE_LENGTH = 72;
const LABELLED_FORMS = new Set(["track"]);
const KEYWORD_VALUE_KEYS = [
  ":author",
  ":title",
  ":tempo",
  ":loop",
  ":loop-start",
  ":loop-end",
  ":prio",
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

function isCommentNode(node) {
  return node && node.kind === "comment";
}

function sourceLine(node) {
  return node?.line || 0;
}

function isSameSourceLine(a, b) {
  const la = sourceLine(a);
  return la > 0 && la === sourceLine(b);
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

    // Collapse whitespace in the value of a COLLAPSE_STRING_KEYS keyword, once
    // here so every downstream path (inline and multi-line) sees it normalized.
    if (item.kind === "string") {
      const prev = out[out.length - 1];
      if (prev && prev.kind === "atom" && COLLAPSE_STRING_KEYS.has(prev.value)) {
        out.push({ ...item, value: item.value.replace(/\s+/g, " ").trim() });
      } else {
        out.push(item);
      }
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

function escapeString(value) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

// Blank lines to emit between two source-adjacent items, derived from their line
// gap (an N-line gap → N-1 blanks). Returns 0 when either line is unknown.
function sourceGapBlanks(prevLine, curLine) {
  if (prevLine <= 0 || curLine <= 0) return 0;
  return Math.max(0, curLine - prevLine - 1);
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
  const nonCommentItems = node.items.filter((item) => !isCommentNode(item));
  const commentItems = node.items.filter((item) => isCommentNode(item));
  const trailingComment =
    commentItems.length === 1 &&
    isCommentNode(node.items[node.items.length - 1])
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
  if (trailingComment && sourceLine(trailingComment) > firstLine) {
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

// Lay out a run of items source-faithfully: items the author wrote on one
// source line stay on that line (joined with their original spacing), blank
// lines are derived from source gaps, and items whose formatted text spans
// multiple lines are emitted alone. Used for both list bodies and [ vectors.
function formatItemLines(items, childIndent, startLine) {
  const lines = [];
  let previousLine = startLine;
  let index = 0;
  while (index < items.length) {
    const child = items[index];
    const currentSourceLine = child.line || 0;

    // Group all consecutive items that share the same source line.
    const groupParts = [];
    while (index < items.length) {
      const item = items[index];
      // A trailing line comment on the same source line is appended and ends the group.
      if (isCommentNode(item)) {
        if (
          currentSourceLine > 0 &&
          sourceLine(item) === currentSourceLine &&
          groupParts.length > 0
        ) {
          groupParts.push({
            text: item.value,
            column: item.column || 0,
            value: item.value,
          });
          index += 1;
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
      index += 1;
    }

    // If nothing was collected (e.g. a comment or multiline item), emit it alone.
    if (groupParts.length === 0) {
      const childText = formatNode(child);
      for (let g = 0; g < sourceGapBlanks(previousLine, child.line || 0); g += 1) {
        lines.push("");
      }
      lines.push(indentBlock(childText, childIndent));
      previousLine = child.endLine || child.line || previousLine;
      index += 1;
      continue;
    }

    const childText = joinAtomsWithSourceSpacing(groupParts);
    for (let g = 0; g < sourceGapBlanks(previousLine, child.line || 0); g += 1) {
      lines.push("");
    }
    lines.push(indentBlock(childText, childIndent));
    const lastItem = items[index - 1];
    previousLine = lastItem.endLine || lastItem.line || previousLine;
  }
  return lines;
}

function collectKeywordPairs(items, startIndex) {
  const pairs = []; // each entry: [keyNode, valueNode | null, trailingComment | null]
  let index = startIndex;
  while (index < items.length) {
    // Stop at standalone comments so they remain in the body section.
    if (isCommentNode(items[index])) break;
    if (!isKeyword(items[index])) break;
    const keyNode = items[index];
    // A keyword immediately followed by another keyword is a valueless tag,
    // not a key whose value is that keyword.
    const isTag = isKeyword(items[index + 1]);
    if (!isTag && index + 1 >= items.length) break;
    const valueNode = isTag ? null : items[index + 1];
    index += isTag ? 1 : 2;
    // Attach a trailing comment on the same source line.
    let trailingComment = null;
    if (
      index < items.length &&
      isCommentNode(items[index]) &&
      isSameSourceLine(keyNode, items[index])
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
    if (items[index].kind === "list" || isCommentNode(items[index])) {
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

function formatList(node) {
  const inline = nodeToInline(node);
  if (inline !== null) {
    return inline;
  }

  const open = node.bracket[0];
  const close = node.bracket[1];
  const childIndent = INDENT;

  if (node.items.length === 0) {
    return `${open}${close}`;
  }

  if (open === "[") {
    // Vector that didn't fit inline: lay items out source-faithfully so the
    // author's per-line grouping (e.g. :key value pairs) is preserved.
    const lines = [open];
    const body = formatItemLines(node.items, childIndent, node.items[0].line || 0);
    for (const line of body) lines.push(line);
    lines.push(close);
    return lines.join("\n");
  }

  // The head is the first non-comment item; any comments before it are emitted
  // on their own lines rather than being mistaken for the head symbol.
  let headIndex = 0;
  while (headIndex < node.items.length && isCommentNode(node.items[headIndex])) {
    headIndex += 1;
  }
  const preHeadComments = node.items.slice(0, headIndex);
  if (headIndex === node.items.length) {
    // A form containing only comments — emit them and close.
    const lines = ["("];
    for (const c of preHeadComments) lines.push(`${childIndent}${c.value}`);
    lines.push(")");
    return lines.join("\n");
  }

  const head = formatNode(node.items[headIndex]);
  const headSymbol =
    node.items[headIndex].kind === "atom" ? node.items[headIndex].value : "";
  const { leadArgs, nextIndex: pairStartIndex } = collectLeadArgs(
    node.items,
    headIndex + 1,
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
  for (const c of preHeadComments) {
    lines.push(`${childIndent}${c.value}`);
  }

  const { pairs, nextIndex } = collectKeywordPairs(node.items, pairStartIndex);
  let pairOffset = 0;
  // Absorb onto the header line the keyword pairs the author wrote on the head's
  // own source line (source-faithful, regardless of lead args). Pairs the author
  // placed on later lines stay below.
  const headLine = node.items[headIndex].line || 0;
  while (pairOffset < pairs.length) {
    const [kNode, vNode] = pairs[pairOffset];
    if (headLine === 0 || (kNode.line || 0) !== headLine) break;
    const vText = vNode ? formatNode(vNode) : null;
    if (vText && vText.includes("\n")) break;
    lines[0] =
      vText === null
        ? `${lines[0]} ${formatNode(kNode)}`
        : `${lines[0]} ${formatNode(kNode)} ${vText}`;
    pairOffset += 1;
    // A trailing comment ends the source line; nothing else can be absorbed.
    if (pairs[pairOffset - 1][2]) {
      lines[0] = `${lines[0]} ${pairs[pairOffset - 1][2].value}`;
      break;
    }
  }

  {
    // Build the keyword groups (consecutive pairs sharing a source line).
    const groups = [];
    let i = pairOffset;
    while (i < pairs.length) {
      const sourceLine = pairs[i][0].line || 0;
      const parts = [];
      let trailingComment = null;
      while (
        i < pairs.length &&
        (sourceLine === 0 || (pairs[i][0].line || 0) === sourceLine)
      ) {
        const [keyNode, valueNode, tc] = pairs[i];
        parts.push({
          keyText: formatNode(keyNode),
          valueText: valueNode ? formatNode(valueNode) : null,
        });
        if (tc) trailingComment = tc;
        i += 1;
      }
      const valueLine = pairs[i - 1][1]?.line || pairs[i - 1][0].line || sourceLine;
      const hasMultiline = parts.some(
        (p) => p.valueText && p.valueText.includes("\n"),
      );
      // Alignable rows must be plain key/value pairs on one line.
      const alignable =
        !trailingComment &&
        !hasMultiline &&
        parts.every((p) => p.valueText !== null);
      groups.push({ sourceLine, valueLine, parts, trailingComment, hasMultiline, alignable });
    }

    // Two rows align when they share a key signature: the keys with trailing
    // digits stripped (so :ar1/:ar2/… group as one table) and equal length.
    const signature = (g) =>
      g.parts.map((p) => p.keyText.replace(/\d+$/, "")).join(" ");

    let prevPairLine =
      pairOffset > 0
        ? pairs[pairOffset - 1][1]?.line || pairs[pairOffset - 1][0].line || 0
        : leadArgs.length > 0
          ? leadArgs[leadArgs.length - 1].line || 0
          : node.items[headIndex].line || 0;
    const pushBlanks = (line) => {
      for (let b = 0; b < sourceGapBlanks(prevPairLine, line); b += 1) {
        lines.push("");
      }
    };

    let g = 0;
    while (g < groups.length) {
      // Extend an alignment run of same-signature alignable rows.
      let end = g;
      if (groups[g].alignable) {
        const sig = signature(groups[g]);
        while (
          end + 1 < groups.length &&
          groups[end + 1].alignable &&
          signature(groups[end + 1]) === sig
        ) {
          end += 1;
        }
      }

      if (end > g) {
        // Align values column by column across the run (keys are equal width).
        const numCols = groups[g].parts.length;
        const valW = Array.from({ length: numCols }, (_, c) =>
          Math.max(
            ...Array.from({ length: end - g + 1 }, (_, r) =>
              groups[g + r].parts[c].valueText.length,
            ),
          ),
        );
        for (let r = g; r <= end; r += 1) {
          pushBlanks(groups[r].sourceLine);
          const line = groups[r].parts
            .map((p, c) => `${p.keyText} ${p.valueText.padStart(valW[c])}`)
            .join(" ");
          lines.push(`${childIndent}${line}`);
          prevPairLine = groups[r].valueLine;
        }
        g = end + 1;
        continue;
      }

      const grp = groups[g];
      pushBlanks(grp.sourceLine);
      prevPairLine = grp.valueLine;
      if (grp.hasMultiline) {
        for (const { keyText, valueText } of grp.parts) {
          if (valueText === null) {
            lines.push(`${childIndent}${keyText}`);
          } else if (!valueText.includes("\n")) {
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
        const combined = grp.parts
          .map((p) => (p.valueText === null ? p.keyText : `${p.keyText} ${p.valueText}`))
          .join(" ");
        const suffix = grp.trailingComment
          ? ` ${grp.trailingComment.value}`
          : "";
        lines.push(`${childIndent}${combined}${suffix}`);
      }
      g += 1;
    }
  }

  const bodyItems = node.items.slice(nextIndex);

  // Blank lines between the keyword section and the body are derived from the
  // last keyword-pair value's source line (or the head's), not forced.
  const bodyStartLine =
    pairs.length > 0
      ? pairs[pairs.length - 1][1]?.line || node.items[headIndex].line || 0
      : node.items[headIndex].line || 0;
  for (const line of formatItemLines(bodyItems, childIndent, bodyStartLine)) {
    lines.push(line);
  }

  lines.push(")");
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

/**
 * Format a MMLisp source string.
 *
 * @param {string} source  - Raw MMLisp source text.
 * @param {Function} parse - The `parse` function from mmlisp-parser.js.
 * @returns {string} Formatted source (always ends with a newline).
 */
export function formatMMLisp(source, parse) {
  const roots = normalizeRoots(parse(source));

  const endLineOf = (node) => node.endLine || node.line || 0;

  // Render every root in order, separated by exactly the blank lines present in
  // the source (an N-line gap → N-1 blank lines) — the same rule already used
  // for items inside a form. A comment on the line directly above a form is
  // therefore adjacent and stays attached to it.
  let out = "";
  let prevEnd = 0;
  for (const root of roots) {
    const text = formatNode(root);
    if (prevEnd > 0) {
      out += "\n" + "\n".repeat(sourceGapBlanks(prevEnd, root.line || prevEnd));
    }
    out += text;
    prevEnd = endLineOf(root);
  }

  return `${out.trimEnd()}\n`;
}

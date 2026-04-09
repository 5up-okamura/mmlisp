"use strict";

function stripComments(input) {
  let out = "";
  let inString = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '"' && input[i - 1] !== "\\") {
      inString = !inString;
      out += ch;
      continue;
    }
    if (!inString && ch === ";") {
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      if (i < input.length && input[i] === "\n") {
        out += "\n";
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function tokenize(input) {
  const src = stripComments(input);
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;

  function push(type, value, startLine, startCol) {
    tokens.push({ type, value, line: startLine, column: startCol });
  }

  while (i < src.length) {
    const ch = src[i];

    if (ch === "\n") {
      i += 1;
      line += 1;
      column = 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      column += 1;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === "[" || ch === "]") {
      push(ch, ch, line, column);
      i += 1;
      column += 1;
      continue;
    }

    if (ch === '"') {
      const startLine = line;
      const startCol = column;
      i += 1;
      column += 1;
      let value = "";
      while (i < src.length) {
        const c = src[i];
        if (c === "\n") {
          line += 1;
          column = 1;
          value += c;
          i += 1;
          continue;
        }
        if (c === '"' && src[i - 1] !== "\\") {
          i += 1;
          column += 1;
          break;
        }
        value += c;
        i += 1;
        column += 1;
      }
      push("string", value, startLine, startCol);
      continue;
    }

    const startLine = line;
    const startCol = column;
    let value = "";
    while (i < src.length) {
      const c = src[i];
      if (
        c === "\n" ||
        c === " " ||
        c === "\t" ||
        c === "\r" ||
        c === "(" ||
        c === ")" ||
        c === "[" ||
        c === "]"
      ) {
        break;
      }
      value += c;
      i += 1;
      column += 1;
    }
    push("atom", value, startLine, startCol);
  }

  return tokens;
}

function parse(input) {
  const tokens = tokenize(input);
  let pos = 0;

  function current() {
    return tokens[pos];
  }

  function parseNode() {
    const token = current();
    if (!token) {
      throw new Error("Unexpected end of input");
    }

    if (token.type === "atom") {
      pos += 1;
      return {
        kind: "atom",
        value: token.value,
        line: token.line,
        column: token.column,
      };
    }

    if (token.type === "string") {
      pos += 1;
      return {
        kind: "string",
        value: token.value,
        line: token.line,
        column: token.column,
      };
    }

    if (token.type === "(" || token.type === "[") {
      const open = token.type;
      const close = open === "(" ? ")" : "]";
      pos += 1;
      const items = [];
      while (current() && current().type !== close) {
        items.push(parseNode());
      }
      if (!current() || current().type !== close) {
        throw new Error(
          `Unclosed ${open} at ${token.line}:${token.column}`
        );
      }
      pos += 1;
      return {
        kind: "list",
        bracket: open + close,
        items,
        line: token.line,
        column: token.column,
      };
    }

    throw new Error(
      `Unexpected token ${token.type} at ${token.line}:${token.column}`
    );
  }

  const roots = [];
  while (pos < tokens.length) {
    roots.push(parseNode());
  }
  return roots;
}

module.exports = {
  parse,
};

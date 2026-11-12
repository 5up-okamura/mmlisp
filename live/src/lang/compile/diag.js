// The compiler's diagnostics and its plainest readers: a diagnostic pushed
// once per source position (pushDiag), a node's place in the source, an
// atom's value, a number read loosely.

export function atomValue(node) {
  if (!node) return null;
  if (node.kind === "atom" || node.kind === "string") return node.value;
  return null;
}

export function describeNodeToken(node) {
  const atom = atomValue(node);
  if (atom !== null) return atom;
  if (node?.kind === "list") {
    const head = atomValue(node.items?.[0]);
    return head ? `(${head} ...)` : "(...)";
  }
  return node?.kind ?? "unknown";
}

export function pushUnknownDiag(diagnostics, code, label, node, trackName) {
  const diagSrc =
    node?.kind === "list" && Array.isArray(node.items) && node.items.length > 0
      ? nodeSrc(node.items[0])
      : nodeSrc(node);
  pushDiag(
    diagnostics,
    "error",
    code,
    `${label}: ${describeNodeToken(node)}`,
    diagSrc,
    trackName,
  );
}

export function parseIntLike(value) {
  if (typeof value !== "string") return null;
  if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
  if (/^0x[0-9a-f]+$/i.test(value)) return parseInt(value, 16); // e.g. :seed 0xDEAD
  return null;
}

export function parseNumberLike(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A position in an imported file says which (`file`, its import path): the
// line and column are that file's, not the score's.
// One diagnostic per place and message: a def expanded many times (a `for`,
// a def played on several tracks) reports its error once, at the one source
// position, with the track that met it first.
const diagSeen = new WeakMap(); // diagnostics array → Set of keys

export function pushDiag(diagnostics, severity, code, message, src, track) {
  const key = [severity, code, message, src?.file ?? "", src?.line ?? 1, src?.column ?? 1].join("\0");
  let seen = diagSeen.get(diagnostics);
  if (!seen) diagSeen.set(diagnostics, (seen = new Set()));
  if (seen.has(key)) return;
  seen.add(key);
  diagnostics.push({
    severity,
    code,
    message,
    line: src?.line ?? 1,
    column: src?.column ?? 1,
    ...(src?.file ? { file: src.file } : {}),
    track,
  });
}

// Source span for a node: { line, column } start plus { endLine, endColumn }
// end, all 1-based; endColumn is one past the last character. Lists carry their
// own end (from the parser); atom-likes span their literal text on one line.
export function markFile(node, file) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) markFile(n, file); return; }
  if (node.line != null) node.file = file;
  if (node.items) markFile(node.items, file);
}

export function nodeSrc(node) {
  const src = { line: node.line, column: node.column };
  if (node.file) src.file = node.file;
  if (node.kind === "list") {
    src.endLine = node.endLine ?? node.line;
    src.endColumn = node.endColumn ?? node.column + 1;
  } else {
    const len = typeof node.value === "string" ? node.value.length : 1;
    src.endLine = node.line;
    src.endColumn = node.column + Math.max(1, len);
  }
  return src;
}

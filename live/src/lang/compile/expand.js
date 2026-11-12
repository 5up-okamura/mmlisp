// A defn's call expanded: its parameters substituted (each local made
// fresh), the tree walked until no call is left.

import { atomValue, pushDiag, nodeSrc } from "./diag.js";
import { letPairs } from "../mmlisp-eval.js";

// Replace bare atoms matching a parameter name with the caller's argument node
// (lexically, within a parametric def body). Args are single nodes (atom/list).
// A `let`/`for` name in the body is its own scope: it shadows a parameter of
// the same name, and one that an argument mentions is renamed, so the
// argument keeps meaning what it meant at the call — `(tri n)` into a body
// binding `n` does not read the body's `n`.
let freshNameCounter = 0;
function atomsIn(node, out = new Set()) {
  if (node.kind === "atom") out.add(node.value);
  else if (node.kind === "list") for (const it of node.items) atomsIn(it, out);
  return out;
}
function substituteParams(node, paramMap, argAtoms = null) {
  if (node.kind === "atom") {
    const sub = paramMap.get(node.value);
    if (!sub) return { ...node };
    // A renamed binding keeps the use site's own position for diagnostics.
    return sub.rename ? { ...node, value: sub.rename } : { ...sub };
  }
  if (node.kind !== "list") return { ...node };
  argAtoms ??= new Set([...paramMap.values()].flatMap((a) => [...atomsIn(a)]));
  const head = atomValue(node.items[0]);
  const vec = node.items[1];
  if ((head === "let" || head === "for") && vec?.kind === "list" && vec.bracket === "[]") {
    let pairs = null;
    try { pairs = letPairs(vec); } catch (_) {}
    if (pairs) {
      // Bindings in turn: a value sees the names before it, not its own.
      const scope = new Map(paramMap);
      const out = new Map();
      for (const [name, value] of pairs) {
        out.set(value, substituteParams(value, scope, argAtoms));
        if (name.kind !== "atom") { out.set(name, { ...name }); continue; }
        if (!argAtoms.has(name.value)) { scope.delete(name.value); out.set(name, { ...name }); continue; }
        const fresh = { ...name, value: `${name.value}__${++freshNameCounter}` };
        scope.set(name.value, { rename: fresh.value });
        out.set(name, fresh);
      }
      const items = vec.items.map((it) => out.get(it) ?? { ...it });
      return {
        ...node,
        items: [{ ...node.items[0] }, { ...vec, items },
          ...node.items.slice(2).map((it) => substituteParams(it, scope, argAtoms))],
      };
    }
  }
  return { ...node, items: node.items.map((it) => substituteParams(it, paramMap, argAtoms)) };
}

// `depth` counts snippet expansions only — a def expanding into a def — so a
// deep expression is not mistaken for recursion (its own limit is E_EVAL_DEPTH).
export function expandNode(node, defs, paramDefs, depth, diagnostics) {
  if (depth > 16) {
    pushDiag(diagnostics, "error", "E_DEF_RECURSION",
      "snippet expansion nested more than 16 deep (a def that refers to itself?)",
      nodeSrc(node), null);
    return [];
  }
  if (node.kind === "atom" && defs.has(node.value))
    return defs
      .get(node.value)
      .flatMap((n) => expandNode(n, defs, paramDefs, depth + 1, diagnostics));
  if (node.kind !== "list") return [node];

  const head = atomValue(node.items[0]);
  // Parametric snippet call: (name arg…) — substitute then re-expand the body.
  if (head && paramDefs.has(head)) {
    const def = paramDefs.get(head);
    const args = node.items.slice(1).filter((n) => n.kind !== "comment");
    if (args.length !== def.params.length) {
      pushDiag(
        diagnostics,
        "error",
        "E_DEF_ARITY",
        `(${head} …) expects ${def.params.length} argument(s), got ${args.length}`,
        nodeSrc(node),
        null,
      );
      return [];
    }
    const paramMap = new Map();
    def.params.forEach((p, idx) => paramMap.set(p, args[idx]));
    return def.body.flatMap((n) =>
      expandNode(substituteParams(n, paramMap), defs, paramDefs, depth + 1, diagnostics),
    );
  }
  if (head && defs.has(head) && node.items.length === 1)
    return defs
      .get(head)
      .flatMap((n) => expandNode(n, defs, paramDefs, depth + 1, diagnostics));

  // An `if`'s branch is one item: a snippet that expands to several stays one
  // branch, wrapped in an empty `let` (which compiles in place), so the else
  // is still the item after it.
  if (head === "if") {
    const pos = { line: node.line, column: node.column, file: node.file };
    const asOne = (n) => {
      const out = expandNode(n, defs, paramDefs, depth, diagnostics);
      return out.length === 1 ? out
        : [{ kind: "list", bracket: "()", ...pos, line: n.line, column: n.column, items: [
          { kind: "atom", value: "let", ...pos }, { kind: "list", bracket: "[]", ...pos, items: [] }, ...out] }];
    };
    let seen = 0; // the head and the test expand as usual; each branch stays one item
    return [{ ...node, items: node.items.flatMap((n) =>
      n.kind === "comment" ? [n] : seen++ < 2 ? expandNode(n, defs, paramDefs, depth, diagnostics) : asOne(n)) }];
  }

  // A `let` or `for` binding's name is a new name, not a reference: it is not
  // expanded, and naming a snippet with it is E_LET_SHADOWS_DEF (a voice or a
  // sample is caught where the form binds, mmlisp-eval.js).
  // A malformed vector is left as written, for the form's own diagnostic.
  if ((head === "let" || head === "for") && node.items[1]?.kind === "list" && node.items[1].bracket === "[]") {
    let pairs = null;
    try { pairs = letPairs(node.items[1]); } catch (_) {}
    if (pairs) {
      const names = new Set(pairs.map(([n]) => n).filter((n) => n.kind === "atom"));
      for (const n of names)
        if (defs.has(n.value) || paramDefs.has(n.value))
          pushDiag(diagnostics, "error", "E_LET_SHADOWS_DEF",
            `${head} name '${n.value}' shadows a def`, nodeSrc(n), null);
      const bindings = node.items[1].items.flatMap((n) =>
        names.has(n) ? [n] : expandNode(n, defs, paramDefs, depth, diagnostics));
      const rest = node.items.slice(2).flatMap((n) => expandNode(n, defs, paramDefs, depth, diagnostics));
      return [{ ...node, items: [node.items[0], { ...node.items[1], items: bindings }, ...rest] }];
    }
  }

  const newItems = [];
  for (const item of node.items)
    newItems.push(...expandNode(item, defs, paramDefs, depth, diagnostics));
  return [{ ...node, items: newItems }];
}

export function expandRoots(roots, defs, paramDefs, diagnostics) {
  const result = [];
  for (const root of roots)
    result.push(...expandNode(root, defs, paramDefs, 0, diagnostics));
  return result;
}

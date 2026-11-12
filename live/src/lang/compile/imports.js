// Paths and imports: POSIX paths a score's :file and (import …) resolve
// by, an import's file found and its defs merged or overlaid.

import { collectDefs } from "./defs.js";
import { atomValue, pushDiag, markFile } from "./diag.js";
import { parse } from "../mmlisp-parser.js";

export function normalizePathSeparators(path) {
  return String(path || "").replace(/\\/g, "/");
}

export function isAbsolutePath(path) {
  const p = normalizePathSeparators(path);
  return (
    p.startsWith("/") ||
    /^[a-zA-Z]:\//.test(p) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)
  );
}

export function dirnamePosix(path) {
  const p = normalizePathSeparators(path);
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : "";
  return p.slice(0, idx);
}

function normalizePosixPath(path) {
  const p = normalizePathSeparators(path);
  const isAbs = p.startsWith("/");
  const segs = p.split("/");
  const out = [];
  for (const seg of segs) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbs) {
        out.push("..");
      }
      continue;
    }
    out.push(seg);
  }
  return (isAbs ? "/" : "") + out.join("/");
}

// A sample path is relative to the FILE THAT DEFINED IT (docs/language.md §16):
// a def written in the score resolves against the score, and one folded in by
// `import` against the imported file, so a preset set can ship its own wav/.
export function resolveSamplePath(sampleFile, baseDir) {
  const file = normalizePathSeparators(sampleFile);
  if (!file || isAbsolutePath(file)) return file;
  const base = normalizePathSeparators(baseDir || "");
  if (!base) return file;
  return normalizePosixPath(`${base}/${file}`);
}

// Where a file sits relative to the compiling score: its importer's directory
// joined with the path as written in that importer.
function importedFilePath(path, baseDir) {
  const p = normalizePathSeparators(path);
  if (isAbsolutePath(p) || !baseDir) return normalizePosixPath(p);
  return normalizePosixPath(`${baseDir}/${p}`);
}

// The def namespaces `import` folds across files (§9.2). def-val
// slots and tracks are deliberately NOT imported (a slot's index is the
// importing file's host-visible layout; tracks are songs, not a library) —
// an effect is a def, so a game's set of them is one file every song shares.
export const IMPORT_DEF_KINDS = ["defs", "paramDefs", "typedDefs", "sampleDefs", "waveDefs", "seDefs"];
// The kinds a name of `kind` hides: every one but a wave's, which a track tells
// from the rest by its part, so the two can share a name (`piano`).
const hiddenKinds = (kind) => IMPORT_DEF_KINDS.filter((k) => (k === "waveDefs") === (kind === "waveDefs"));

// Scan source text for its top-level (import "path") forms. Exported so the host
// can drive async file resolution (recursing through nested imports) before the
// synchronous compileMMLisp — the compiler itself never does I/O.
export function collectImports(src) {
  const parsed = parse(src);
  const paths = [];
  for (const root of parsed) {
    if (root.kind !== "list" || root.items.length < 2) continue;
    if (atomValue(root.items[0]) !== "import") continue;
    const pathNode = root.items[1];
    if (pathNode?.kind === "string" && typeof pathNode.value === "string")
      paths.push(pathNode.value);
  }
  return paths;
}

// Merge `incoming` def bundle into `base` with strict conflict detection. A name
// already present for the same kind is E_IMPORT_CONFLICT *only if it traces back
// to a different origin file* — a diamond (two imports pulling in the same third
// file) resolves to one origin and dedups silently. Used to fold sibling imports.
// An `:over` import (`over`) instead replaces what the earlier siblings define
// under its names, in every namespace, as a file's own defs do (overlayDefs) —
// so a kit layered on a base keeps the base's sounds it does not have.
function mergeImportsStrict(base, incoming, diagnostics, conflictSrc, over = false) {
  if (over) {
    for (const kind of IMPORT_DEF_KINDS)
      for (const name of incoming[kind].keys())
        for (const k of hiddenKinds(kind)) {
          if (base.origin[k].get(name) === incoming.origin[kind].get(name)) continue; // diamond
          base[k].delete(name);
          base.origin[k].delete(name);
        }
  }
  for (const kind of IMPORT_DEF_KINDS) {
    for (const [name, def] of incoming[kind]) {
      const incomingOrigin = incoming.origin[kind].get(name);
      if (base[kind].has(name)) {
        if (base.origin[kind].get(name) === incomingOrigin) continue; // diamond
        pushDiag(
          diagnostics,
          "error",
          "E_IMPORT_CONFLICT",
          `'${name}' is defined by more than one imported file`,
          conflictSrc,
          null,
        );
        continue;
      }
      base[kind].set(name, def);
      base.origin[kind].set(name, incomingOrigin);
    }
  }
}

// Overlay a file's *own* defs onto `base` for the four def kinds; they silently
// win (the importing file overrides imported defaults). `originPath` tags each
// entry so a later strict merge can tell diamonds from true conflicts.
export function overlayDefs(base, own, originPath) {
  // The overlaying file wins a name in every namespace: a local def-fm `pad`
  // hides an imported snippet `pad`, not just an imported def-fm `pad`.
  for (const kind of IMPORT_DEF_KINDS)
    for (const name of own[kind].keys())
      for (const k of hiddenKinds(kind)) {
        base[k].delete(name);
        base.origin[k].delete(name);
      }
  for (const kind of IMPORT_DEF_KINDS) {
    for (const [name, def] of own[kind]) {
      base[kind].set(name, def);
      base.origin[kind].set(name, originPath);
    }
  }
}

function emptyImportBundle() {
  return {
    defs: new Map(),
    paramDefs: new Map(),
    typedDefs: new Map(),
    sampleDefs: new Map(),
    waveDefs: new Map(),
    seDefs: new Map(),
    origin: {
      defs: new Map(),
      paramDefs: new Map(),
      typedDefs: new Map(),
      sampleDefs: new Map(),
      waveDefs: new Map(),
      seDefs: new Map(),
    },
  };
}

// Warn (once per file) about content in an imported file that import ignores:
// def-val slots and track/other top-level forms — import brings defs only.
function warnImportIgnored(bundle, importPath, diagnostics, importSrc) {
  if (bundle.vals.size > 0) {
    pushDiag(
      diagnostics,
      "warning",
      "W_IMPORT_IGNORED",
      `imported file '${importPath}' declares def-val slots; import folds defs only, so they are ignored`,
      importSrc,
      null,
    );
  }
  if (Object.values(bundle.fileMeta).some((v) => v !== null)) {
    pushDiag(
      diagnostics,
      "warning",
      "W_IMPORT_IGNORED",
      `imported file '${importPath}' has a def-score; the settings are the importing score's own, so they are ignored`,
      importSrc,
      null,
    );
  }
  if (bundle.mods.length > 0) {
    pushDiag(
      diagnostics,
      "warning",
      "W_IMPORT_IGNORED",
      `imported file '${importPath}' contains def-mod forms; a modifier is the importing score's own, so they are ignored`,
      importSrc,
      null,
    );
  }
  const hasTracks = bundle.remaining.some(
    (n) => n?.kind === "list" && n.items.length > 0,
  );
  if (hasTracks) {
    pushDiag(
      diagnostics,
      "warning",
      "W_IMPORT_IGNORED",
      `imported file '${importPath}' contains track/other forms; import folds defs only, so they are ignored`,
      importSrc,
      null,
    );
  }
}

// Resolve one imported file to its merged def bundle (its own defs winning over
// what it in turn imports). `stack` detects cycles; `cache` dedups diamonds.
// Next to the importing file first; failing that, from the root (a served
// score's `presets/…`) — and the file is then where it was found, so its
// samples and its own imports resolve from there.
export function importKeyOf(path, baseDir, importSources) {
  const joined = importedFilePath(path, baseDir);
  return !importSources?.has(joined) && importSources?.has(normalizePosixPath(path))
    ? normalizePosixPath(path)
    : joined;
}

function resolveImportFile(path, importSrc, importSources, diagnostics, cache, stack, baseDir = "") {
  const selfPath = importKeyOf(path, baseDir, importSources);
  const selfDir = dirnamePosix(selfPath);
  if (stack.includes(selfPath)) {
    pushDiag(
      diagnostics,
      "error",
      "E_IMPORT_CYCLE",
      `import cycle: ${[...stack, selfPath].join(" -> ")}`,
      importSrc,
      null,
    );
    return emptyImportBundle();
  }
  if (cache.has(selfPath)) return cache.get(selfPath);

  const text = importSources?.get(selfPath);
  if (typeof text !== "string") {
    pushDiag(
      diagnostics,
      "error",
      "E_IMPORT_NOT_FOUND",
      `imported file '${path}' could not be resolved`,
      importSrc,
      null,
    );
    const empty = emptyImportBundle();
    cache.set(selfPath, empty);
    return empty;
  }

  // Its nodes say which file they are from, so a position taken from one
  // (an event's src) is not read as a place in the score.
  const ast = parse(text);
  markFile(ast, path);
  const bundle = collectDefs(ast, diagnostics);
  warnImportIgnored(bundle, path, diagnostics, importSrc);
  // The set's own wav/ lives next to it, not next to the score that imports it
  // — and so does an extending sample's own :file.
  for (const sample of bundle.sampleDefs.values()) sample.baseDir = selfDir;

  // Resolve this file's own imports first (siblings merged strictly), then let
  // this file's defs overlay them.
  const merged = emptyImportBundle();
  const nextStack = [...stack, selfPath];
  for (const imp of bundle.imports) {
    const sub = resolveImportFile(
      imp.path,
      imp.src,
      importSources,
      diagnostics,
      cache,
      nextStack,
      selfDir,
    );
    mergeImportsStrict(merged, withImportEffect(sub, imp.fxNode), diagnostics, imp.src, imp.over);
  }
  overlayDefs(merged, bundle, selfPath);

  cache.set(selfPath, merged);
  return merged;
}

// Fold all of the root file's imports into one bundle (siblings merged strictly).
export function resolveImports(importForms, importSources, diagnostics, scoreDir) {
  const merged = emptyImportBundle();
  const cache = new Map();
  for (const imp of importForms) {
    const sub = resolveImportFile(
      imp.path,
      imp.src,
      importSources,
      diagnostics,
      cache,
      [],
      scoreDir,
    );
    mergeImportsStrict(merged, withImportEffect(sub, imp.fxNode), diagnostics, imp.src, imp.over);
  }
  return merged;
}

// An import's `:fx` rides on every sample it brings in, AHEAD of the def's
// own chain (the outermost import first): the kit is processed as a whole, then
// each sound is adjusted on top, so a per-sound level survives a kit-wide
// normalize. A copy — the cached bundle is shared by every importer.
function withImportEffect(bundle, fxNode) {
  if (!fxNode) return bundle;
  const sampleDefs = new Map();
  for (const [name, s] of bundle.sampleDefs)
    sampleDefs.set(name, { ...s, importFx: [fxNode, ...(s.importFx ?? [])] });
  return { ...bundle, sampleDefs };
}

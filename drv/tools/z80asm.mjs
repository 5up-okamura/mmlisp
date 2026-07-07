// Minimal two-pass Z80 assembler — first-party, zero dependencies.
//
// Scope: exactly the instruction subset MMLispDRV uses (a broad, standard
// subset of the documented Z80 set; unknown mnemonics are errors). Syntax is
// classic Z80 / sjasmplus-compatible so the driver source can later move to a
// full assembler unchanged:
//
//   label:  ld a,(hl)      ; comment
//   NAME    equ $1F80
//           org $0038
//           db 1,2,"text",'c'
//           dw 0x1234, label+2
//           ds 16 [, fill]
//           include "tables.z80"
//
// Expressions: decimal, $hex, 0xhex, %binary, 'c'; labels; $ (current addr);
// unary - ~; binary * / % + - << >> & ^ |; parentheses. C-like precedence.
//
// Not supported (deliberately): macros, conditionals, undocumented opcodes,
// DDCB-indexed rotates. The driver must not need them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const R8 = { b: 0, c: 1, d: 2, e: 3, h: 4, l: 5, a: 7 };
const RP = { bc: 0, de: 1, hl: 2, sp: 3 };
const RP2 = { bc: 0, de: 1, hl: 2, af: 3 }; // push/pop
const CC = { nz: 0, z: 1, nc: 2, c: 3, po: 4, pe: 5, p: 6, m: 7 };
const CC_JR = { nz: 0x20, z: 0x28, nc: 0x30, c: 0x38 };
const ALU = { add: 0, adc: 1, sub: 2, sbc: 3, and: 4, xor: 5, or: 6, cp: 7 };
const ROT = { rlc: 0, rrc: 1, rl: 2, rr: 3, sla: 4, sra: 5, srl: 7 };

class AsmError extends Error {
  constructor(msg, line) {
    super(line ? `${line.file}:${line.no}: ${msg}  [${line.src.trim()}]` : msg);
  }
}

// ── Tokenizer for operand expressions ──────────────────────────────────────
function tokenizeExpr(s) {
  const toks = [];
  let i = 0;
  const isIdent = (c) => /[A-Za-z0-9_.]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "$" && isIdent(s[i + 1] ?? "")) {
      // $hex
      let j = i + 1;
      while (j < s.length && /[0-9A-Fa-f]/.test(s[j])) j++;
      toks.push({ t: "num", v: parseInt(s.slice(i + 1, j), 16) });
      i = j;
      continue;
    }
    if (c === "$") {
      toks.push({ t: "here" });
      i++;
      continue;
    }
    if (c === "%" && /[01]/.test(s[i + 1] ?? "")) {
      let j = i + 1;
      while (j < s.length && /[01]/.test(s[j])) j++;
      toks.push({ t: "num", v: parseInt(s.slice(i + 1, j), 2) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && isIdent(s[j])) j++;
      const word = s.slice(i, j);
      let v;
      if (/^0x[0-9A-Fa-f]+$/.test(word)) v = parseInt(word.slice(2), 16);
      else if (/^[0-9A-Fa-f]+[Hh]$/.test(word)) v = parseInt(word.slice(0, -1), 16);
      else if (/^[0-9]+$/.test(word)) v = parseInt(word, 10);
      else throw new AsmError(`bad number "${word}"`);
      toks.push({ t: "num", v });
      i = j;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end !== i + 2) throw new AsmError(`bad char literal in "${s}"`);
      toks.push({ t: "num", v: s.charCodeAt(i + 1) });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_.]/.test(c)) {
      let j = i;
      while (j < s.length && isIdent(s[j])) j++;
      toks.push({ t: "ident", v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "<" && s[i + 1] === "<") {
      toks.push({ t: "op", v: "<<" });
      i += 2;
      continue;
    }
    if (c === ">" && s[i + 1] === ">") {
      toks.push({ t: "op", v: ">>" });
      i += 2;
      continue;
    }
    if ("+-*/%&^|~()".includes(c)) {
      toks.push({ t: "op", v: c });
      i++;
      continue;
    }
    throw new AsmError(`unexpected character "${c}" in "${s}"`);
  }
  return toks;
}

// Precedence-climbing evaluator. `resolve` maps identifier → value | undefined.
function evalExpr(s, resolve, here) {
  const toks = tokenizeExpr(s);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const PREC = {
    "|": 1,
    "^": 2,
    "&": 3,
    "<<": 4,
    ">>": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6,
    "%": 6,
  };
  function primary() {
    const t = next();
    if (!t) throw new AsmError(`unexpected end of expression "${s}"`);
    if (t.t === "num") return t.v;
    if (t.t === "here") return here;
    if (t.t === "ident") {
      const v = resolve(t.v);
      if (v === undefined) throw new AsmError(`undefined symbol "${t.v}"`);
      return v;
    }
    if (t.t === "op" && t.v === "(") {
      const v = binary(0);
      const close = next();
      if (!close || close.v !== ")") throw new AsmError(`missing ) in "${s}"`);
      return v;
    }
    if (t.t === "op" && t.v === "-") return -primary() & 0xffff;
    if (t.t === "op" && t.v === "+") return primary();
    if (t.t === "op" && t.v === "~") return ~primary() & 0xffff;
    throw new AsmError(`unexpected token in "${s}"`);
  }
  function binary(minPrec) {
    let lhs = primary();
    while (peek() && peek().t === "op" && PREC[peek().v] >= minPrec + 1) {
      const op = next().v;
      const rhs = binary(PREC[op]);
      switch (op) {
        case "|": lhs |= rhs; break;
        case "^": lhs ^= rhs; break;
        case "&": lhs &= rhs; break;
        case "<<": lhs = (lhs << rhs) & 0xffff; break;
        case ">>": lhs >>>= rhs; break;
        case "+": lhs = (lhs + rhs) & 0xffff; break;
        case "-": lhs = (lhs - rhs) & 0xffff; break;
        case "*": lhs = (lhs * rhs) & 0xffff; break;
        case "/": lhs = Math.trunc(lhs / rhs); break;
        case "%": lhs %= rhs; break;
      }
    }
    return lhs & 0xffff;
  }
  const v = binary(0);
  if (pos !== toks.length) throw new AsmError(`trailing tokens in "${s}"`);
  return v;
}

// ── Operand classification ─────────────────────────────────────────────────
// Returns one of:
//   {k:'r8', code}            b c d e h l a
//   {k:'rp', name}            bc de hl sp af ix iy
//   {k:'mem-hl'} {k:'mem-bc'} {k:'mem-de'} {k:'mem-sp'}
//   {k:'mem-ix', dispExpr} {k:'mem-iy', dispExpr}
//   {k:'mem-nn', expr}
//   {k:'cc', code, jr}        condition
//   {k:'expr', expr}          immediate
//   {k:'afp'}                 af'
function classify(op) {
  const s = op.trim();
  const low = s.toLowerCase();
  if (low in R8) return { k: "r8", code: R8[low] };
  if (low === "af'") return { k: "afp" };
  if (["bc", "de", "hl", "sp", "af", "ix", "iy"].includes(low))
    return { k: "rp", name: low };
  if (low.startsWith("(") && low.endsWith(")")) {
    const inner = s.slice(1, -1).trim();
    const il = inner.toLowerCase();
    if (il === "hl") return { k: "mem-hl" };
    if (il === "bc") return { k: "mem-bc" };
    if (il === "de") return { k: "mem-de" };
    if (il === "sp") return { k: "mem-sp" };
    if (il === "ix") return { k: "mem-ix", dispExpr: "0" };
    if (il === "iy") return { k: "mem-iy", dispExpr: "0" };
    const m = /^(ix|iy)\s*([+-].*)$/i.exec(inner);
    if (m) return { k: `mem-${m[1].toLowerCase()}`, dispExpr: m[2] };
    return { k: "mem-nn", expr: inner };
  }
  return { k: "expr", expr: s };
}

const isCond = (s) => s.trim().toLowerCase() in CC;

// ── Line splitting (respects quotes, strips comments) ─────────────────────
function splitOperands(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  let quote = null;
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"') quote = c;
    else if (c === "'" && s[i + 2] === "'") quote = c; // char literal
    else if (c === ";") return s.slice(0, i);
  }
  return s;
}

// ── The assembler ──────────────────────────────────────────────────────────
// `preload` seeds the symbol table (a Map) before assembling — used to build
// overlays: an overlay is assembled with the resident image's symbols preloaded
// so it can reference resident routines and equates directly (no import file).
export function assemble(entryPath, { preload = null } = {}) {
  const symbols = new Map(preload ?? []);
  const lines = [];

  function loadFile(path) {
    const text = readFileSync(path, "utf8");
    text.split(/\r?\n/).forEach((src, idx) => {
      const line = { file: path, no: idx + 1, src };
      const body = stripComment(src).trimEnd();
      if (!body.trim()) return;
      // include is resolved at load time so line order is source order.
      const inc = /^\s*include\s+"([^"]+)"\s*$/i.exec(body);
      if (inc) {
        loadFile(join(dirname(path), inc[1]));
        return;
      }
      lines.push({ ...line, body });
    });
  }
  loadFile(entryPath);

  // Parse each line into {label, mnem, ops}.
  const parsed = [];
  for (const line of lines) {
    let body = line.body;
    let label = null;
    const lm = /^([A-Za-z_.][A-Za-z0-9_.]*):/.exec(body);
    if (lm) {
      label = lm[1];
      body = body.slice(lm[0].length);
    }
    body = body.trim();
    let mnem = null;
    let ops = [];
    if (body) {
      const sp = body.search(/[\s]/);
      mnem = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
      const rest = sp < 0 ? "" : body.slice(sp).trim();
      // `NAME equ expr` — label without colon.
      if (mnem !== "equ" && rest.toLowerCase().startsWith("equ ") === false) {
        ops = splitOperands(rest);
      } else {
        ops = [rest];
      }
      const em = /^([A-Za-z_.][A-Za-z0-9_.]*)\s+equ\s+(.+)$/i.exec(body);
      if (em) {
        label = em[1];
        mnem = "equ";
        ops = [em[2].trim()];
      }
    }
    parsed.push({ line, label, mnem, ops });
  }

  // Two passes: pass 1 sizes instructions and assigns labels; pass 2 encodes.
  for (const pass of [1, 2]) {
    let pc = 0;
    const out = pass === 2 ? [] : null;
    const resolve = (name) => symbols.get(name);
    const evalE = (expr, line) => {
      try {
        return evalExpr(expr, pass === 1 ? (n) => symbols.get(n) ?? 0 : resolve, pc);
      } catch (e) {
        throw new AsmError(e.message, line);
      }
    };

    for (const p of parsed) {
      const { line, label, mnem, ops } = p;
      if (label && mnem !== "equ") {
        if (pass === 1) {
          if (symbols.has(label))
            throw new AsmError(`duplicate label "${label}"`, line);
          symbols.set(label, pc);
        }
      }
      if (!mnem) continue;
      if (mnem === "equ") {
        if (pass === 1) symbols.set(label, evalE(ops[0], line));
        continue;
      }
      if (mnem === "org") {
        const target = evalE(ops[0], line);
        if (pass === 2) {
          if (target < pc)
            throw new AsmError(`org $${target.toString(16)} behind pc`, line);
          while (pc < target) {
            out.push(0);
            pc++;
          }
        } else {
          if (target < pc)
            throw new AsmError(`org $${target.toString(16)} behind pc`, line);
          pc = target;
        }
        continue;
      }
      const bytes = pass === 2 ? out : null;
      const emit = (...bs) => {
        if (pass === 2)
          for (const b of bs) {
            if (b < -128 || b > 255)
              throw new AsmError(`byte out of range: ${b}`, line);
            bytes.push(b & 0xff);
          }
        pc += bs.length;
      };
      const emitW = (v) => emit(v & 0xff, (v >> 8) & 0xff);
      const patchLast = (b) => {
        if (pass === 2) bytes[bytes.length - 1] = b & 0xff;
      };

      try {
        encodeLine(mnem, ops, {
          line,
          pass,
          pcRef: () => pc,
          emit,
          emitW,
          patchLast,
          evalE: (e) => evalE(e, line),
        });
      } catch (e) {
        if (e instanceof AsmError) throw e;
        throw new AsmError(e.message, line);
      }
    }
    if (pass === 2) {
      return { bytes: Uint8Array.from(out), symbols };
    }
  }
}

// Encode one instruction/directive. All sizes are pass-invariant.
function encodeLine(mnem, ops, ctx) {
  const { emit, emitW, evalE, pass, pcRef, line } = ctx;
  const err = (m) => {
    throw new AsmError(m, line);
  };
  const A = ops.map(classify);
  const imm8 = (o) => {
    const v = pass === 2 ? evalE(o.expr) : 0;
    if (pass === 2 && (v < -128 || v > 255)) err(`imm8 out of range: ${v}`);
    return v & 0xff;
  };
  const disp = (o) => {
    const v = pass === 2 ? evalE(o.dispExpr) & 0xffff : 0;
    const sv = v > 0x7fff ? v - 0x10000 : v;
    if (pass === 2 && (sv < -128 || sv > 127)) err(`index disp out of range`);
    return sv & 0xff;
  };
  const ixPfx = (name) => (name === "ix" || name === "mem-ix" ? 0xdd : 0xfd);

  switch (mnem) {
    // ── data directives ────────────────────────────────────────────────
    case "db":
    case "defb": {
      for (const o of ops) {
        const t = o.trim();
        if (t.startsWith('"') && t.endsWith('"')) {
          for (const ch of t.slice(1, -1)) emit(ch.charCodeAt(0));
        } else {
          emit(pass === 2 ? evalE(t) & 0xff : 0);
        }
      }
      return;
    }
    case "dw":
    case "defw": {
      for (const o of ops) emitW(pass === 2 ? evalE(o) : 0);
      return;
    }
    case "ds":
    case "defs": {
      const n = evalE(ops[0]);
      const fill = ops[1] ? evalE(ops[1]) & 0xff : 0;
      for (let i = 0; i < n; i++) emit(fill);
      return;
    }

    // ── loads ──────────────────────────────────────────────────────────
    case "ld": {
      const [d, s] = A;
      if (!d || !s) err("ld needs 2 operands");
      // r8 ← r8 / (hl) / (ix+d) / imm / (nn) [a only] / (bc)/(de) [a only]
      if (d.k === "r8") {
        if (s.k === "r8") return emit(0x40 | (d.code << 3) | s.code);
        if (s.k === "mem-hl") return emit(0x46 | (d.code << 3));
        if (s.k === "mem-ix" || s.k === "mem-iy")
          return emit(ixPfx(s.k), 0x46 | (d.code << 3), disp(s));
        if (s.k === "mem-bc") {
          if (d.code !== 7) err("ld r,(bc) only a");
          return emit(0x0a);
        }
        if (s.k === "mem-de") {
          if (d.code !== 7) err("ld r,(de) only a");
          return emit(0x1a);
        }
        if (s.k === "mem-nn") {
          if (d.code !== 7) err("ld r,(nn) only a");
          emit(0x3a);
          return emitW(pass === 2 ? evalE(s.expr) : 0);
        }
        if (s.k === "expr") return emit(0x06 | (d.code << 3), imm8(s));
        err("bad ld source");
      }
      if (d.k === "mem-hl") {
        if (s.k === "r8") return emit(0x70 | s.code);
        if (s.k === "expr") return emit(0x36, imm8(s));
        err("bad ld (hl),src");
      }
      if (d.k === "mem-ix" || d.k === "mem-iy") {
        if (s.k === "r8") return emit(ixPfx(d.k), 0x70 | s.code, disp(d));
        if (s.k === "expr") return emit(ixPfx(d.k), 0x36, disp(d), imm8(s));
        err("bad ld (ix+d),src");
      }
      if (d.k === "mem-bc") {
        if (s.k === "r8" && s.code === 7) return emit(0x02);
        err("ld (bc),a only");
      }
      if (d.k === "mem-de") {
        if (s.k === "r8" && s.code === 7) return emit(0x12);
        err("ld (de),a only");
      }
      if (d.k === "mem-nn") {
        const addr = () => emitW(pass === 2 ? evalE(d.expr) : 0);
        if (s.k === "r8" && s.code === 7) {
          emit(0x32);
          return addr();
        }
        if (s.k === "rp") {
          if (s.name === "hl") {
            emit(0x22);
            return addr();
          }
          if (s.name === "ix" || s.name === "iy") {
            emit(ixPfx(s.name), 0x22);
            return addr();
          }
          emit(0xed, 0x43 | (RP[s.name] << 4));
          return addr();
        }
        err("bad ld (nn),src");
      }
      if (d.k === "rp") {
        if (s.k === "expr") {
          if (d.name === "ix" || d.name === "iy") {
            emit(ixPfx(d.name), 0x21);
            return emitW(pass === 2 ? evalE(s.expr) : 0);
          }
          emit(0x01 | (RP[d.name] << 4));
          return emitW(pass === 2 ? evalE(s.expr) : 0);
        }
        if (s.k === "mem-nn") {
          const addr = () => emitW(pass === 2 ? evalE(s.expr) : 0);
          if (d.name === "hl") {
            emit(0x2a);
            return addr();
          }
          if (d.name === "ix" || d.name === "iy") {
            emit(ixPfx(d.name), 0x2a);
            return addr();
          }
          emit(0xed, 0x4b | (RP[d.name] << 4));
          return addr();
        }
        if (d.name === "sp" && s.k === "rp") {
          if (s.name === "hl") return emit(0xf9);
          if (s.name === "ix" || s.name === "iy") return emit(ixPfx(s.name), 0xf9);
        }
        err("bad ld rp,src");
      }
      err("bad ld");
      break;
    }

    // ── ALU ────────────────────────────────────────────────────────────
    case "add":
    case "adc":
    case "sbc": {
      const [d, s] = A;
      if (d.k === "rp" && d.name === "hl") {
        if (s.k !== "rp" || !(s.name in RP)) err(`bad ${mnem} hl,rp`);
        if (mnem === "add") return emit(0x09 | (RP[s.name] << 4));
        if (mnem === "adc") return emit(0xed, 0x4a | (RP[s.name] << 4));
        return emit(0xed, 0x42 | (RP[s.name] << 4));
      }
      if (d.k === "rp" && (d.name === "ix" || d.name === "iy")) {
        if (mnem !== "add") err(`${mnem} ix,rp unsupported`);
        const map = { bc: 0, de: 1, sp: 3 };
        if (s.k === "rp" && s.name === d.name) return emit(ixPfx(d.name), 0x29);
        if (s.k !== "rp" || !(s.name in map)) err("bad add ix,rp");
        return emit(ixPfx(d.name), 0x09 | (map[s.name] << 4));
      }
      // fall through to 8-bit alu
    }
    // eslint-disable-next-line no-fallthrough
    case "sub":
    case "and":
    case "xor":
    case "or":
    case "cp": {
      let src = A.length === 2 ? A[1] : A[0];
      if (A.length === 2 && !(A[0].k === "r8" && A[0].code === 7))
        err(`bad ${mnem} operands`);
      const base = ALU[mnem];
      if (src.k === "r8") return emit(0x80 | (base << 3) | src.code);
      if (src.k === "mem-hl") return emit(0x86 | (base << 3));
      if (src.k === "mem-ix" || src.k === "mem-iy")
        return emit(ixPfx(src.k), 0x86 | (base << 3), disp(src));
      if (src.k === "expr") return emit(0xc6 | (base << 3), imm8(src));
      err(`bad ${mnem} operand`);
      break;
    }

    case "inc":
    case "dec": {
      const [d] = A;
      const decBit = mnem === "dec" ? 1 : 0;
      if (d.k === "r8") return emit(0x04 | (d.code << 3) | decBit);
      if (d.k === "mem-hl") return emit(0x34 | decBit);
      if (d.k === "mem-ix" || d.k === "mem-iy")
        return emit(ixPfx(d.k), 0x34 | decBit, disp(d));
      if (d.k === "rp") {
        if (d.name === "ix" || d.name === "iy")
          return emit(ixPfx(d.name), mnem === "inc" ? 0x23 : 0x2b);
        return emit((mnem === "inc" ? 0x03 : 0x0b) | (RP[d.name] << 4));
      }
      err(`bad ${mnem}`);
      break;
    }

    // ── rotates / bits ─────────────────────────────────────────────────
    case "rlca": return emit(0x07);
    case "rrca": return emit(0x0f);
    case "rla": return emit(0x17);
    case "rra": return emit(0x1f);
    case "cpl": return emit(0x2f);
    case "scf": return emit(0x37);
    case "ccf": return emit(0x3f);
    case "neg": return emit(0xed, 0x44);

    case "rlc":
    case "rrc":
    case "rl":
    case "rr":
    case "sla":
    case "sra":
    case "srl": {
      const [d] = A;
      const base = ROT[mnem] << 3;
      if (d.k === "r8") return emit(0xcb, base | d.code);
      if (d.k === "mem-hl") return emit(0xcb, base | 6);
      err(`bad ${mnem}`);
      break;
    }
    case "bit":
    case "set":
    case "res": {
      const n = evalE(ops[0]);
      if (n < 0 || n > 7) err("bit index 0..7");
      const d = classify(ops[1]);
      const base = { bit: 0x40, set: 0xc0, res: 0x80 }[mnem] | (n << 3);
      if (d.k === "r8") return emit(0xcb, base | d.code);
      if (d.k === "mem-hl") return emit(0xcb, base | 6);
      if (d.k === "mem-ix" || d.k === "mem-iy")
        return emit(ixPfx(d.k), 0xcb, disp(d), base | 6);
      err(`bad ${mnem}`);
      break;
    }

    // ── control flow ───────────────────────────────────────────────────
    case "jp": {
      if (A.length === 1 && A[0].k === "mem-hl") return emit(0xe9);
      if (A.length === 1 && A[0].k === "expr") {
        emit(0xc3);
        return emitW(pass === 2 ? evalE(A[0].expr) : 0);
      }
      if (A.length === 2 && isCond(ops[0])) {
        emit(0xc2 | (CC[ops[0].trim().toLowerCase()] << 3));
        return emitW(pass === 2 ? evalE(A[1].expr) : 0);
      }
      err("bad jp");
      break;
    }
    case "jr": {
      let target;
      let opByte = 0x18;
      if (A.length === 2) {
        const cond = ops[0].trim().toLowerCase();
        if (!(cond in CC_JR)) err(`jr condition must be nz/z/nc/c`);
        opByte = CC_JR[cond];
        target = A[1];
      } else {
        target = A[0];
      }
      emit(opByte, 0);
      if (pass === 2) {
        const dest = evalE(target.expr);
        const off = dest - pcRef();
        if (off < -128 || off > 127) err(`jr out of range (${off})`);
        // patch the placeholder we just emitted
        ctx.patchLast?.(off & 0xff);
      }
      return;
    }
    case "djnz": {
      emit(0x10, 0);
      if (pass === 2) {
        const dest = evalE(A[0].expr);
        const off = dest - pcRef();
        if (off < -128 || off > 127) err(`djnz out of range (${off})`);
        ctx.patchLast?.(off & 0xff);
      }
      return;
    }
    case "call": {
      if (A.length === 1) {
        emit(0xcd);
        return emitW(pass === 2 ? evalE(A[0].expr) : 0);
      }
      if (isCond(ops[0])) {
        emit(0xc4 | (CC[ops[0].trim().toLowerCase()] << 3));
        return emitW(pass === 2 ? evalE(A[1].expr) : 0);
      }
      err("bad call");
      break;
    }
    case "ret": {
      if (A.length === 0) return emit(0xc9);
      if (isCond(ops[0]))
        return emit(0xc0 | (CC[ops[0].trim().toLowerCase()] << 3));
      err("bad ret");
      break;
    }
    case "reti": return emit(0xed, 0x4d);
    case "retn": return emit(0xed, 0x45);
    case "rst": {
      const v = evalE(ops[0]);
      if (v & ~0x38 || v % 8) err("bad rst target");
      return emit(0xc7 | v);
    }

    // ── stack / exchange ───────────────────────────────────────────────
    case "push":
    case "pop": {
      const [d] = A;
      const base = mnem === "push" ? 0xc5 : 0xc1;
      if (d.k === "rp") {
        if (d.name === "ix" || d.name === "iy")
          return emit(ixPfx(d.name), base | 0x20);
        if (d.name in RP2) return emit(base | (RP2[d.name] << 4));
      }
      err(`bad ${mnem}`);
      break;
    }
    case "ex": {
      const [d, s] = A;
      if (d.k === "mem-sp" && s.k === "rp" && s.name === "hl") return emit(0xe3);
      if (d.k === "rp" && d.name === "de" && s.k === "rp" && s.name === "hl")
        return emit(0xeb);
      if (d.k === "rp" && d.name === "af" && s.k === "afp") return emit(0x08);
      err("bad ex");
      break;
    }
    case "exx": return emit(0xd9);

    // ── block / misc ───────────────────────────────────────────────────
    case "ldi": return emit(0xed, 0xa0);
    case "ldir": return emit(0xed, 0xb0);
    case "ldd": return emit(0xed, 0xa8);
    case "lddr": return emit(0xed, 0xb8);
    case "nop": return emit(0x00);
    case "halt": return emit(0x76);
    case "di": return emit(0xf3);
    case "ei": return emit(0xfb);
    case "im": {
      const v = evalE(ops[0]);
      return emit(0xed, [0x46, 0x56, 0x5e][v]);
    }

    default:
      err(`unknown mnemonic "${mnem}"`);
  }
}

// jr/djnz need to patch their displacement after pc advanced; wire patchLast
// through a wrapper on assemble()'s emit. Simplest: re-implement here by
// wrapping encodeLine — see assemble() where ctx.patchLast is provided.

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error("usage: node z80asm.mjs <in.z80> <out.bin>");
    process.exit(2);
  }
  const { writeFileSync } = await import("node:fs");
  const { bytes } = assemble(inPath);
  writeFileSync(outPath, bytes);
  console.log(`${outPath}: ${bytes.length} bytes`);
}

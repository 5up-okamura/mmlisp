// FM single-voice patch importers — pure byte parsers for the DefleMask .dmp,
// .tfi, .vgi, .opni and Furnace .fui formats, plus the MMLisp `(def …)` voice
// text they lower to. Sibling of import-mucom.js. No DOM/app dependencies: the
// UI glue (file pickers, editor insertion) stays in index.html, so this module
// is unit-testable from node.

function readDmpU8(bytes, cursor) {
  if (cursor.i >= bytes.length) throw new Error('Unexpected end of DMP data');
  const v = bytes[cursor.i];
  cursor.i += 1;
  return v;
}

function skipBytes(bytes, cursor, count) {
  if (count <= 0) return;
  if (cursor.i + count > bytes.length) throw new Error('Unexpected end of data');
  cursor.i += count;
}

function readFixedAscii(bytes, cursor, len) {
  if (cursor.i + len > bytes.length) throw new Error('Unexpected end of data');
  let s = '';
  for (let i = 0; i < len; i++) {
    s += String.fromCharCode(bytes[cursor.i + i]);
  }
  cursor.i += len;
  return s;
}

function readLeU16(bytes, cursor) {
  const lo = readDmpU8(bytes, cursor);
  const hi = readDmpU8(bytes, cursor);
  return lo | (hi << 8);
}

function readLeU32(bytes, cursor) {
  const b0 = readDmpU8(bytes, cursor);
  const b1 = readDmpU8(bytes, cursor);
  const b2 = readDmpU8(bytes, cursor);
  const b3 = readDmpU8(bytes, cursor);
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

function readCString(bytes, cursor, maxLen = 1 << 20) {
  let out = '';
  let n = 0;
  while (cursor.i < bytes.length) {
    const c = readDmpU8(bytes, cursor);
    if (c === 0) return out;
    out += String.fromCharCode(c);
    n += 1;
    if (n >= maxLen) throw new Error('String too long in instrument data');
  }
  throw new Error('Unterminated string in instrument data');
}

function clampDmpValue(v, min, max) {
  const n = Number(v) | 0;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function normalizeFmOp(raw) {
  return {
    mul: clampDmpValue(raw.mul, 0, 15),
    tl: clampDmpValue(raw.tl, 0, 127),
    ar: clampDmpValue(raw.ar, 0, 31),
    dr: clampDmpValue(raw.dr, 0, 31),
    sl: clampDmpValue(raw.sl, 0, 15),
    rr: clampDmpValue(raw.rr, 0, 15),
    am: clampDmpValue(raw.am ? 1 : 0, 0, 1),
    rs: clampDmpValue(raw.rs, 0, 3),
    dt: clampDmpValue(raw.dt, 0, 7),
    sr: clampDmpValue(raw.sr, 0, 31),
    ssg: clampDmpValue(raw.ssg, 0, 15),
  };
}

function readFmOps(bytes, cursor, count, readOne) {
  const ops = [];
  // Read only the operators the file actually carries. A source with fewer
  // than 4 (e.g. a 2-op instrument) yields a shorter list; the voice writer
  // emits just those, leaving the rest at the compiler's operator defaults.
  for (let i = 0; i < count; i++) {
    ops.push(normalizeFmOp(readOne(bytes, cursor)));
  }
  return ops.slice(0, 4); // YM2612 is 4-op; never keep more
}

function normalizeFmPatchFields(patch) {
  return {
    ...patch,
    alg: clampDmpValue(patch.alg, 0, 7),
    fb: clampDmpValue(patch.fb, 0, 7),
    ams: clampDmpValue(patch.ams, 0, 3),
    fms: clampDmpValue(patch.fms, 0, 7),
  };
}

function parseDefleMaskDmpFm(bytes) {
  const cursor = { i: 0 };
  const version = readDmpU8(bytes, cursor);
  if (version > 11) throw new Error(`Unsupported DMP version: ${version}`);

  let sys = 2; // Assume Genesis for legacy DMP variants without a system byte.
  if (version >= 11) {
    sys = readDmpU8(bytes, cursor);
  }

  let mode = 1;
  if (version > 1) {
    mode = readDmpU8(bytes, cursor);
  }
  if (!mode) {
    throw new Error('This DMP is not in FM mode');
  }

  if (sys !== 2 && sys !== 9) {
    throw new Error(`Unsupported DMP system for this importer: ${sys} (only Genesis/Neo Geo FM supported)`);
  }

  let ops = 4;
  if (version < 10) {
    if (version > 1) {
      if (bytes.length === 51) {
        readDmpU8(bytes, cursor);
        ops = 4;
      } else {
        ops = readDmpU8(bytes, cursor) ? 4 : 2;
      }
    } else if (bytes.length === 49) {
      ops = 4;
      readDmpU8(bytes, cursor);
    } else {
      ops = readDmpU8(bytes, cursor) ? 2 : 4;
    }
  }
  const fms = version > 1 ? readDmpU8(bytes, cursor) : 0;
  const fb = readDmpU8(bytes, cursor);
  const alg = readDmpU8(bytes, cursor);
  const ams = sys !== 1 ? readDmpU8(bytes, cursor) : 0;

  const opsOut = readFmOps(bytes, cursor, ops, (b, c) => {
    const mul = readDmpU8(b, c);
    const tl = readDmpU8(b, c);
    const ar = readDmpU8(b, c);
    const dr = readDmpU8(b, c);
    const sl = readDmpU8(b, c);
    const rr = readDmpU8(b, c);
    const am = readDmpU8(b, c);
    const rs = readDmpU8(b, c);
    const dtRaw = readDmpU8(b, c);
    const sr = readDmpU8(b, c);
    const ssg = readDmpU8(b, c);
    return {
      mul,
      tl,
      ar,
      dr,
      sl,
      rr,
      am,
      rs,
      dt: dtRaw & 0x0f,
      sr,
      ssg,
    };
  });

  return normalizeFmPatchFields({
    version,
    sys,
    alg,
    fb,
    ams,
    fms,
    ops: opsOut,
  });
}

function parseTfiFm(bytes) {
  const cursor = { i: 0 };
  const alg = readDmpU8(bytes, cursor);
  const fb = readDmpU8(bytes, cursor);
  const ops = readFmOps(bytes, cursor, 4, (b, c) => ({
    mul: readDmpU8(b, c),
    dt: readDmpU8(b, c),
    tl: readDmpU8(b, c),
    rs: readDmpU8(b, c),
    ar: readDmpU8(b, c),
    dr: readDmpU8(b, c),
    sr: readDmpU8(b, c),
    rr: readDmpU8(b, c),
    sl: readDmpU8(b, c),
    ssg: readDmpU8(b, c),
    am: 0,
  }));
  return normalizeFmPatchFields({
    alg,
    fb,
    ams: 0,
    fms: 0,
    ops,
  });
}

function parseVgiFm(bytes) {
  const cursor = { i: 0 };
  const alg = readDmpU8(bytes, cursor);
  const fb = readDmpU8(bytes, cursor);
  const fmsAms = readDmpU8(bytes, cursor);
  const ops = readFmOps(bytes, cursor, 4, (b, c) => {
    const mul = readDmpU8(b, c);
    const dt = readDmpU8(b, c);
    const tl = readDmpU8(b, c);
    const rs = readDmpU8(b, c);
    const ar = readDmpU8(b, c);
    const drAmp = readDmpU8(b, c);
    const sr = readDmpU8(b, c);
    const rr = readDmpU8(b, c);
    const sl = readDmpU8(b, c);
    const ssg = readDmpU8(b, c);
    return {
      mul,
      dt,
      tl,
      rs,
      ar,
      dr: drAmp & 0x7f,
      am: (drAmp & 0x80) ? 1 : 0,
      sr,
      rr,
      sl,
      ssg,
    };
  });
  return normalizeFmPatchFields({
    alg,
    fb,
    ams: (fmsAms >> 4) & 0x03,
    fms: fmsAms & 0x07,
    ops,
  });
}

function parseOpniFm(bytes) {
  const cursor = { i: 0 };
  const header = readFixedAscii(bytes, cursor, 11);
  if (header !== 'WOPN2-INST' && header !== 'WOPN2-IN2T') {
    throw new Error('Invalid OPNI header');
  }

  // OPNI v1 has no explicit version field. If v2+ marker is invalid, rewind.
  const maybeVersionPos = cursor.i;
  let version = readLeU16(bytes, cursor);
  if (!(version >= 2 && version <= 0x0f)) {
    cursor.i = maybeVersionPos;
    version = 1;
  }

  readDmpU8(bytes, cursor); // isPerc
  skipBytes(bytes, cursor, 32); // name
  skipBytes(bytes, cursor, 3); // MIDI params

  const feedAlgo = readDmpU8(bytes, cursor);
  readDmpU8(bytes, cursor); // global bank flags

  const ops = readFmOps(bytes, cursor, 4, (b, c) => {
    const dtMul = readDmpU8(b, c);
    const totalLevel = readDmpU8(b, c);
    const arRateScale = readDmpU8(b, c);
    const drAmpEnable = readDmpU8(b, c);
    const sr = readDmpU8(b, c);
    const susRelease = readDmpU8(b, c);
    const ssg = readDmpU8(b, c);
    return {
      mul: dtMul & 0x0f,
      dt: (dtMul >> 4) & 0x07,
      tl: totalLevel & 0x7f,
      rs: (arRateScale >> 6) & 0x03,
      ar: arRateScale & 0x1f,
      dr: drAmpEnable & 0x1f,
      am: (drAmpEnable >> 7) & 0x01,
      sr: sr & 0x1f,
      rr: susRelease & 0x0f,
      sl: (susRelease >> 4) & 0x0f,
      ssg,
    };
  });

  if (version >= 2) {
    skipBytes(bytes, cursor, 4); // keyon/keyoff delay
  }

  return normalizeFmPatchFields({
    alg: feedAlgo & 0x07,
    fb: (feedAlgo >> 3) & 0x07,
    ams: 0,
    fms: 0,
    ops,
  });
}

function slotToDisplayOps(ops) {
  // Every supported FM instrument format (DMP/TFI/VGI/OPNI/FUI) stores the
  // 4 operators in YM2612 hardware slot order OP1,OP3,OP2,OP4. Swap the
  // middle pair to display order OP1,OP2,OP3,OP4 so imports match the
  // source tool (Furnace/DefleMask).
  if (!Array.isArray(ops) || ops.length !== 4) return ops;
  return [ops[0], ops[2], ops[1], ops[3]];
}

function parseFuiFmFeature(bytes, cursor, version, featEnd) {
  const opFlags = readDmpU8(bytes, cursor);
  const opCount = opFlags & 0x0f;

  let next = readDmpU8(bytes, cursor);
  const alg = (next >> 4) & 0x07;
  const fb = next & 0x07;

  next = readDmpU8(bytes, cursor);
  const ams = (next >> 3) & 0x03;
  const fms = next & 0x07;

  // ams2/ops/opllPreset
  readDmpU8(bytes, cursor);
  if (version >= 224) readDmpU8(bytes, cursor); // block

  const ops = readFmOps(bytes, cursor, opCount, (b, c) => {
    const b1 = readDmpU8(b, c);
    const b2 = readDmpU8(b, c);
    const b3 = readDmpU8(b, c);
    const b4 = readDmpU8(b, c);
    const b5 = readDmpU8(b, c);
    const b6 = readDmpU8(b, c);
    const b7 = readDmpU8(b, c);
    readDmpU8(b, c); // dam/dt2/ws
    return {
      mul: b1 & 0x0f,
      dt: (b1 >> 4) & 0x07,
      tl: b2 & 0x7f,
      rs: (b3 >> 6) & 0x03,
      ar: b3 & 0x1f,
      dr: b4 & 0x1f,
      am: (b4 >> 7) & 0x01,
      sr: b5 & 0x1f,
      rr: b6 & 0x0f,
      sl: (b6 >> 4) & 0x0f,
      ssg: b7 & 0x0f,
    };
  });

  cursor.i = featEnd;

  return normalizeFmPatchFields({
    alg,
    fb,
    ams,
    fms,
    ops,
  });
}

function parseFuiNew(bytes) {
  const cursor = { i: 0 };
  const magic = readFixedAscii(bytes, cursor, 4);
  if (magic !== 'FINS' && magic !== 'FINB') {
    throw new Error('Invalid FUI header (expected FINS/FINB)');
  }

  const version = readLeU16(bytes, cursor);
  // Instrument type (FM=1, OPM=33) is not strictly required if FM feature exists.
  readLeU16(bytes, cursor);

  let parsedFm = null;
  while (cursor.i + 4 <= bytes.length) {
    const code = readFixedAscii(bytes, cursor, 2);
    if (code === 'EN') break;
    const featLen = readLeU16(bytes, cursor);
    const featEnd = cursor.i + featLen;
    if (featEnd > bytes.length) throw new Error('Corrupt FUI feature length');

    if (code === 'FM') {
      parsedFm = parseFuiFmFeature(bytes, cursor, version, featEnd);
    } else {
      cursor.i = featEnd;
    }
  }

  if (!parsedFm) throw new Error('FUI contains no FM feature');
  return parsedFm;
}

function parseFuiOld(bytes) {
  const cursor = { i: 0 };
  const header = readFixedAscii(bytes, cursor, 16);
  if (header !== '-Furnace instr.-') {
    throw new Error('Invalid old FUI header');
  }

  const version = readLeU16(bytes, cursor);
  readLeU16(bytes, cursor); // reserved
  const insPtr = readLeU32(bytes, cursor);

  if (insPtr <= 0 || insPtr >= bytes.length) {
    throw new Error('Invalid old FUI instrument pointer');
  }

  cursor.i = insPtr;
  const instMagic = readFixedAscii(bytes, cursor, 4);
  if (instMagic !== 'INST') {
    throw new Error('Invalid old FUI INST block');
  }

  readLeU32(bytes, cursor); // block size
  readLeU16(bytes, cursor); // format version
  readDmpU8(bytes, cursor); // instrument type
  readDmpU8(bytes, cursor); // reserved
  readCString(bytes, cursor); // instrument name

  const alg = readDmpU8(bytes, cursor);
  const fb = readDmpU8(bytes, cursor);
  const fms = readDmpU8(bytes, cursor);
  const ams = readDmpU8(bytes, cursor);
  const opCount = readDmpU8(bytes, cursor);
  readDmpU8(bytes, cursor); // opll preset/reserved
  skipBytes(bytes, cursor, 2); // reserved

  const ops = readFmOps(bytes, cursor, opCount, (b, c) => {
    const am = readDmpU8(b, c);
    const ar = readDmpU8(b, c);
    const dr = readDmpU8(b, c);
    const mul = readDmpU8(b, c);
    const rr = readDmpU8(b, c);
    const sl = readDmpU8(b, c);
    const tl = readDmpU8(b, c);
    readDmpU8(b, c); // dt2
    const rs = readDmpU8(b, c);
    const dt = readDmpU8(b, c);
    const sr = readDmpU8(b, c); // d2r
    const ssg = readDmpU8(b, c);
    skipBytes(b, c, 8); // dam,dvb,egt,ksl,sus,vib,ws,ksr
    if (version >= 114) readDmpU8(b, c); else readDmpU8(b, c); // enable/reserved
    if (version >= 115) readDmpU8(b, c); else readDmpU8(b, c); // kvs/reserved
    skipBytes(b, c, 10); // reserved
    return { mul, tl, ar, dr, sl, rr, am, rs, dt, sr, ssg };
  });

  return normalizeFmPatchFields({
    alg,
    fb,
    ams,
    fms,
    ops,
  });
}

function parseFuiFm(bytes) {
  if (bytes.length < 8) throw new Error('FUI file is too small');
  if (bytes[0] === 0x46 && bytes[1] === 0x49 && bytes[2] === 0x4e) {
    // FINS / FINB
    return parseFuiNew(bytes);
  }
  return parseFuiOld(bytes);
}

function makeVoiceNameFromFile(fileName) {
  const base = String(fileName || '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return '@' + (base || 'dmp-voice');
}

function buildMmlispVoiceFromDmp(parsed, voiceName) {
  const header = [`  :alg ${parsed.alg}`, `:fb ${parsed.fb}`];
  if (parsed.ams !== 0) header.push(`:ams ${parsed.ams}`);
  if (parsed.fms !== 0) header.push(`:fms ${parsed.fms}`);

  const lines = [
    `(def ${voiceName}`,
    header.join(' '),
  ];

  // Right-pad each parameter to the widest value across the 4 operators so
  // the per-operator rows line up as an aligned table.
  const cols = [
    ['ar', (o) => o.ar], ['dr', (o) => o.dr], ['sr', (o) => o.sr],
    ['rr', (o) => o.rr], ['sl', (o) => o.sl], ['tl', (o) => o.tl],
    ['ks', (o) => o.rs], ['ml', (o) => o.mul], ['dt', (o) => o.dt],
  ];
  const widths = cols.map(([, get]) =>
    Math.max(...parsed.ops.map((o) => String(get(o)).length)));

  for (let i = 0; i < parsed.ops.length; i++) {
    const op = parsed.ops[i];
    const n = i + 1;
    const parts = cols.map(([key, get], c) =>
      `:${key}${n} ${String(get(op)).padStart(widths[c])}`);
    if (op.ssg !== 0) parts.push(`:ssg${n} ${op.ssg}`);
    if (op.am !== 0) parts.push(`:am${n} ${op.am}`);
    lines.push('  ' + parts.join(' '));
  }
  lines.push(')');
  return lines.join('\n');
}

const FM_IMPORT_FORMATS = Object.freeze({
  DMP: Object.freeze({
    key: 'DMP',
    label: 'DMP',
    description: 'DefleMask instrument dump',
    extensions: ['.dmp'],
    parser: parseDefleMaskDmpFm,
  }),
  FUI: Object.freeze({
    key: 'FUI',
    label: 'FUI',
    description: 'Furnace instrument',
    extensions: ['.fui'],
    parser: parseFuiFm,
  }),
  TFI: Object.freeze({
    key: 'TFI',
    label: 'TFI',
    description: 'TFM Music Maker instrument',
    extensions: ['.tfi'],
    parser: parseTfiFm,
  }),
  VGI: Object.freeze({
    key: 'VGI',
    label: 'VGI',
    description: 'VGM Music Maker instrument',
    extensions: ['.vgi'],
    parser: parseVgiFm,
  }),
  OPNI: Object.freeze({
    key: 'OPNI',
    label: 'OPNI',
    description: 'OPN2BankEditor instrument',
    extensions: ['.opni'],
    parser: parseOpniFm,
  }),
});

function detectFmImportFormatKey(fileName) {
  const name = String(fileName || '').toLowerCase();
  if (name.endsWith('.dmp')) return 'DMP';
  if (name.endsWith('.fui')) return 'FUI';
  if (name.endsWith('.tfi')) return 'TFI';
  if (name.endsWith('.vgi')) return 'VGI';
  if (name.endsWith('.opni')) return 'OPNI';
  return null;
}

export {
  FM_IMPORT_FORMATS,
  buildMmlispVoiceFromDmp,
  makeVoiceNameFromFile,
  detectFmImportFormatKey,
};

// A .zip or .lzh read as the files inside it, for File > Open… and a drop: the
// archive opens as a folder would (source-folder.js). Only the index is read up
// front — each file is cut out of the archive and inflated when it is read, so
// a large pack costs the memory of the songs actually opened.
//
// ZIP: stored and deflate (through the platform's DecompressionStream); no
// encryption, no ZIP64. LZH: -lh0- / -lz4- stored, -lh1- (LHarc's adaptive
// Huffman), -lh4- / -lh5- / -lh6- / -lh7-, in header levels 0, 1 and 2. Names without a UTF-8 mark are read as UTF-8 when
// they are, else as Shift_JIS — the archives this app meets are Japanese ones.
// Both formats carry a CRC, which every read checks.

export const ARCHIVE_EXT = /\.(zip|lzh|lha)$/i;

/** The archive's files: [{ path, size, read(): Promise<Uint8Array> }], directories left out. */
export async function readArchive(blob) {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (head[0] === 0x50 && head[1] === 0x4b) return readZip(blob);
  const lzh = await findLzhStart(blob);
  if (lzh >= 0) return readLzh(blob, lzh);
  throw new Error('not a ZIP or LZH archive');
}

async function bytesOf(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

function decodeName(bytes, utf8) {
  if (!utf8) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('shift_jis').decode(bytes);
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// A path the folder may hand out: forward slashes, no empty, `.` or `..`
// segment (an entry that climbs out of the archive is dropped, not clamped).
function cleanPath(name) {
  // eslint-disable-next-line no-control-regex
  const segs = name.replace(/[\x00-\x1f\x7f]/g, '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (segs.includes('..')) return null;
  return segs.join('/');
}

// ---- ZIP ----------------------------------------------------------------

const CRC32 = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC32[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(blob) {
  // The end-of-central-directory record: the last 22 bytes, plus a comment of
  // up to 64 KiB before them.
  const tailStart = Math.max(0, blob.size - 22 - 0xffff);
  const tail = await bytesOf(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP: no central directory (a truncated download?)');
  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const cd = await bytesOf(blob, cdOffset, cdOffset + cdSize);
  const files = [];
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (u32(cd, p) !== 0x02014b50) throw new Error('ZIP: damaged central directory');
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const crc = u32(cd, p + 16);
    const csize = u32(cd, p + 20);
    const size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const local = u32(cd, p + 42);
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    let name = decodeName(rawName, (flags & 0x0800) !== 0);
    // Info-ZIP's Unicode Path field: the name in UTF-8 beside a legacy one.
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length;) {
      const id = u16(extra, e), len = u16(extra, e + 2);
      if (id === 0x7075 && len > 5 && extra[e + 4] === 1 && u32(extra, e + 5) === crc32(rawName)) {
        name = new TextDecoder('utf-8').decode(extra.subarray(e + 9, e + 4 + len));
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.endsWith('\\')) continue; // a directory
    const path = cleanPath(name);
    if (!path) continue;
    files.push({
      path,
      size,
      async read() {
        if (flags & 1) throw new Error(`${path}: encrypted ZIP entries are not supported`);
        if (method !== 0 && method !== 8) throw new Error(`${path}: ZIP method ${method} is not supported (stored and deflate are)`);
        const lh = await bytesOf(blob, local, local + 30);
        if (u32(lh, 0) !== 0x04034b50) throw new Error(`${path}: damaged ZIP entry`);
        const start = local + 30 + u16(lh, 26) + u16(lh, 28);
        const data = await bytesOf(blob, start, start + csize);
        const out = method === 0 ? data : await inflateRaw(data);
        if (out.length !== size || crc32(out) !== crc) throw new Error(`${path}: CRC mismatch — the archive is damaged`);
        return out;
      },
    });
  }
  return files;
}

// ---- LZH ----------------------------------------------------------------

// The window's bits; 0 = stored.
const LZH_METHODS = { '-lh0-': 0, '-lz4-': 0, '-lh1-': 12, '-lh4-': 12, '-lh5-': 13, '-lh6-': 15, '-lh7-': 16 };

// Level 3 is recognized only to be refused by name.
function isLzhHeader(b, i) {
  return b[i + 2] === 0x2d && b[i + 3] === 0x6c && b[i + 6] === 0x2d && b[i + 20] <= 3;
}

// An archive starts with a header; a self-extracting one has the extractor
// first, so look for a header within the first 64 KiB.
async function findLzhStart(blob) {
  const b = await bytesOf(blob, 0, Math.min(blob.size, 0x10000 + 22));
  for (let i = 0; i + 22 <= b.length; i++) if (isLzhHeader(b, i)) return i;
  return -1;
}

const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xa001 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc16(u8) {
  let c = 0;
  for (let i = 0; i < u8.length; i++) c = CRC16[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return c;
}

// The extended headers of levels 1 and 2: [size u16 (incl. itself), type, data]…
// until a size of 0. Type 1 is the file name, 2 the directory (0xFF between
// its parts).
function readExtHeaders(b, p, info) {
  let size = u16(b, p);
  p += 2;
  while (size) {
    // Each one is at least its type and the next size: anything less, or one
    // running past what was read, would never end.
    if (size < 3 || p + size > b.length) throw new Error('LZH: damaged header');
    const type = b[p];
    const data = b.subarray(p + 1, p + size - 2);
    if (type === 0x01) info.name = data;
    else if (type === 0x02) info.dir = data.map((c) => (c === 0xff ? 0x2f : c));
    info.extSize += size;
    p += size - 2;
    size = u16(b, p);
    p += 2;
  }
  return p;
}

async function readLzh(blob, start) {
  const files = [];
  let pos = start;
  while (pos < blob.size) {
    const b = await bytesOf(blob, pos, Math.min(blob.size, pos + 0x10000 + 32));
    if (b.length === 0 || b[0] === 0) break; // the end mark
    if (!isLzhHeader(b, 0)) throw new Error('LZH: damaged header');
    if (b[20] === 3) throw new Error('LZH header level 3 is not supported (levels 0 to 2 are)');
    const method = String.fromCharCode(...b.subarray(2, 7));
    const level = b[20];
    const size = u32(b, 11);
    let csize = u32(b, 7);
    const info = { name: null, dir: null, extSize: 0 };
    let crc, dataStart;
    if (level === 0 || level === 1) {
      const nameLen = b[21];
      info.name = b.subarray(22, 22 + nameLen);
      crc = u16(b, 22 + nameLen);
      let p = 2 + b[0];
      if (level === 1) {
        p = readExtHeaders(b, p - 2, info); // the first size sits in the base header's last two bytes
        csize -= info.extSize; // a level 1 header counts its extended headers in the size
      }
      dataStart = pos + p;
    } else {
      crc = u16(b, 21);
      readExtHeaders(b, 24, info);
      dataStart = pos + u16(b, 0);
    }
    const nameBytes = info.dir ? [...info.dir, ...(info.dir.at(-1) === 0x2f ? [] : [0x2f]), ...(info.name ?? [])] : [...(info.name ?? [])];
    // Level 0/1 names may carry the DOS separator, or 0xFF as level 2 does.
    const name = decodeName(new Uint8Array(nameBytes.map((c) => (c === 0xff ? 0x2f : c))), false);
    const path = method === '-lhd-' ? null : cleanPath(name);
    if (path) {
      const at = dataStart;
      const len = csize;
      files.push({
        path,
        size,
        async read() {
          if (!(method in LZH_METHODS)) throw new Error(`${path}: LZH method ${method} is not supported (-lh0- -lh1- -lh4- to -lh7- are)`);
          const data = await bytesOf(blob, at, at + len);
          const out = method === '-lh1-' ? decodeLh1(data, size)
            : LZH_METHODS[method] ? decodeLh(data, size, LZH_METHODS[method]) : data;
          if (out.length !== size || crc16(out) !== crc) throw new Error(`${path}: CRC mismatch — the archive is damaged`);
          return out;
        },
      });
    }
    pos = dataStart + csize;
  }
  return files;
}

// MSB first, as LHA writes; past the end it reads zeros.
function bitReader(src) {
  let pos = 0, buf = 0, nbits = 0;
  const peek16 = () => {
    while (nbits < 16) {
      buf = ((buf << 8) | (pos < src.length ? src[pos++] : 0)) >>> 0;
      nbits += 8;
    }
    return (buf >>> (nbits - 16)) & 0xffff;
  };
  const skip = (k) => {
    nbits -= k;
    buf &= (1 << nbits) - 1;
  };
  const get = (k) => {
    if (!k) return 0;
    const v = peek16() >>> (16 - k);
    skip(k);
    return v;
  };
  return { peek16, skip, get };
}

// Copy a match out of what is already decoded. The window starts out filled
// with spaces, as LHA's does.
function copyMatch(out, o, size, dist, len) {
  for (let k = 0, from = o - dist - 1; k < len && o < size; k++, from++) out[o++] = from >= 0 ? out[from] : 0x20;
  return o;
}

// -lh4- / -lh5- / -lh6- / -lh7-: LZSS over a 2^dicbit window, coded in blocks, each
// with three static Huffman codes (canonical, as LHA's make_table assigns
// them) — the code lengths' code, the literal/length code, the distance code.
function decodeLh(src, size, dicbit) {
  const NC = 510, NT = 19, TBIT = 5, CBIT = 9;
  // -lh4- is -lh5- in a smaller window: the same 14 distance codes.
  const np = Math.max(14, dicbit + 1);
  const pbit = dicbit <= 13 ? 4 : 5;
  const { peek16, skip, get } = bitReader(src);

  // A 16-bit lookup: entry = symbol | length << 16; -1 where no code lands.
  const table = (lens, n) => {
    const t = new Int32Array(1 << 16).fill(-1);
    const count = new Uint32Array(17);
    for (let i = 0; i < n; i++) count[lens[i]]++;
    const next = new Uint32Array(18);
    for (let l = 1; l <= 16; l++) next[l + 1] = next[l] + (count[l] << (16 - l));
    for (let i = 0; i < n; i++) {
      const l = lens[i];
      if (!l) continue;
      const code = next[l];
      next[l] += 1 << (16 - l);
      t.fill(i | (l << 16), code, Math.min(1 << 16, code + (1 << (16 - l))));
    }
    return t;
  };
  const single = (sym) => new Int32Array(1 << 16).fill(sym); // one symbol, zero bits
  const decode = (t) => {
    const e = t[peek16()];
    if (e < 0) throw new Error('LZH: bad Huffman code — the archive is damaged');
    skip(e >>> 16);
    return e & 0xffff;
  };

  // The lengths of the code-length code (nn = NT, with a run of zeros after
  // the third) and of the distance code (nn = np).
  const readPtLen = (nn, nbit, special) => {
    const n = get(nbit);
    if (!n) return { t: single(get(nbit)) };
    const lens = new Uint8Array(Math.max(nn, n));
    let i = 0;
    while (i < n) {
      let c = peek16() >>> 13;
      if (c === 7) {
        for (let mask = 1 << 12; mask & peek16(); mask >>= 1) c++;
      }
      skip(c < 7 ? 3 : c - 3);
      lens[i++] = c;
      if (i === special) for (let z = get(2); z > 0 && i < n; z--) lens[i++] = 0;
    }
    return { t: table(lens, nn) };
  };
  const readCLen = (pt) => {
    const n = get(CBIT);
    if (!n) return single(get(CBIT));
    const lens = new Uint8Array(NC);
    let i = 0;
    while (i < n) {
      let c = decode(pt);
      if (c <= 2) {
        c = c === 0 ? 1 : c === 1 ? get(4) + 3 : get(CBIT) + 20;
        while (c-- > 0 && i < NC) lens[i++] = 0;
      } else lens[i++] = c - 2;
    }
    return table(lens, NC);
  };

  const out = new Uint8Array(size);
  let o = 0, block = 0, cTable = null, pTable = null;
  while (o < size) {
    if (!block) {
      block = get(16);
      const pt = readPtLen(NT, TBIT, 3).t;
      cTable = readCLen(pt);
      pTable = readPtLen(np, pbit, -1).t;
    }
    block--;
    const c = decode(cTable);
    if (c < 256) {
      out[o++] = c;
      continue;
    }
    let p = decode(pTable);
    if (p) p = (1 << (p - 1)) + get(p - 1);
    o = copyMatch(out, o, size, p, c - 253);
  }
  return out;
}

// -lh1-: LHarc's LZHUF — a 4 KiB window, the literal/length code an adaptive
// Huffman tree (Okumura and Yoshizaki's), the distance's upper 6 bits a fixed
// code and its lower 6 bits plain.
const LH1_DCODE = new Uint8Array(256), LH1_DLEN = new Uint8Array(256);
for (let i = 0, code = 0, len = 3; len <= 8; len++) {
  // How many distances have a code of each length, 3 bits to 8.
  for (let n = [1, 3, 8, 12, 24, 16][len - 3]; n > 0; n--, code++) {
    const span = 1 << (8 - len);
    LH1_DCODE.fill(code, i, i + span);
    LH1_DLEN.fill(len, i, i + span);
    i += span;
  }
}

function decodeLh1(src, size) {
  const N_CHAR = 314, T = N_CHAR * 2 - 1, R = T - 1, MAX_FREQ = 0x8000;
  const freq = new Uint32Array(T + 1), son = new Int32Array(T), prnt = new Int32Array(T + N_CHAR);
  for (let i = 0; i < N_CHAR; i++) {
    freq[i] = 1;
    son[i] = i + T;
    prnt[i + T] = i;
  }
  for (let i = 0, j = N_CHAR; j <= R; i += 2, j++) {
    freq[j] = freq[i] + freq[i + 1];
    son[j] = i;
    prnt[i] = prnt[i + 1] = j;
  }
  freq[T] = 0xffff;
  prnt[R] = 0;

  // The counts halved, the tree rebuilt from its leaves.
  const reconst = () => {
    let j = 0;
    for (let i = 0; i < T; i++) {
      if (son[i] >= T) {
        freq[j] = (freq[i] + 1) >>> 1;
        son[j] = son[i];
        j++;
      }
    }
    for (let i = 0, j = N_CHAR; j < T; i += 2, j++) {
      const f = (freq[j] = freq[i] + freq[i + 1]);
      let k = j - 1;
      while (f < freq[k]) k--;
      k++;
      freq.copyWithin(k + 1, k, j);
      freq[k] = f;
      son.copyWithin(k + 1, k, j);
      son[k] = i;
    }
    for (let i = 0; i < T; i++) {
      const k = son[i];
      if (k >= T) prnt[k] = i;
      else prnt[k] = prnt[k + 1] = i;
    }
  };
  const update = (sym) => {
    if (freq[R] === MAX_FREQ) reconst();
    let c = prnt[sym + T];
    do {
      const k = ++freq[c];
      // Keep the counts in order: swap with the last node of a lower count.
      let l = c + 1;
      if (k > freq[l]) {
        while (k > freq[++l]);
        l--;
        freq[c] = freq[l];
        freq[l] = k;
        const i = son[c];
        prnt[i] = l;
        if (i < T) prnt[i + 1] = l;
        const j = son[l];
        son[l] = i;
        prnt[j] = c;
        if (j < T) prnt[j + 1] = c;
        son[c] = j;
        c = l;
      }
    } while ((c = prnt[c]) !== 0);
  };

  const { get } = bitReader(src);
  const out = new Uint8Array(size);
  let o = 0;
  while (o < size) {
    let c = son[R];
    while (c < T) c = son[c + get(1)];
    c -= T;
    update(c);
    if (c < 256) {
      out[o++] = c;
      continue;
    }
    let d = get(8);
    const upper = LH1_DCODE[d] << 6;
    for (let n = LH1_DLEN[d] - 2; n > 0; n--) d = (d << 1) | get(1);
    o = copyMatch(out, o, size, upper | (d & 0x3f), c - 253);
  }
  return out;
}

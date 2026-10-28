// The source folder (File > Open Folder…): what a score's relative `:file`
// samples and (import …) paths resolve against, and what File > Files in
// Folder lists. Two kinds behind one face — a directory the browser grants
// (Chrome, Edge), and an archive (.zip .lzh) read in memory, which every
// browser can open, a phone's too.
//
//   name            shown in the File menu
//   handle          the FileSystemDirectoryHandle, or null for an archive
//   archive         { name, handle } for an archive (handle null when it came
//                   from a plain file input), else null
//   readable()      true when the folder can be read now (a directory's grant)
//   files()         the top-level files: [{ name, handle, file() }], `handle`
//                   null inside an archive — there is nothing to write back to
//   read(path)      a file's bytes by folder-relative path, or null
//   pathOf(handle)  a file handle's folder-relative path, or null when it is
//                   not inside (always null for an archive)
//   same(folder)    whether two folders are the same one

import { readArchive } from './archive.js';

export function folderFromHandle(handle) {
  const walk = async (segs) => {
    let dir = handle;
    for (const seg of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
    return dir.getFileHandle(segs[segs.length - 1]);
  };
  return {
    name: handle.name,
    handle,
    archive: null,
    async readable() {
      try {
        return (await handle.queryPermission({ mode: 'read' })) === 'granted';
      } catch {
        return false;
      }
    },
    async files() {
      const out = [];
      for await (const [name, entry] of handle.entries()) {
        if (entry.kind === 'file') out.push({ name, handle: entry, file: () => entry.getFile() });
      }
      return out;
    },
    async read(path) {
      const segs = splitPath(path);
      if (!segs) return null;
      try {
        return new Uint8Array(await (await (await walk(segs)).getFile()).arrayBuffer());
      } catch {
        return null;
      }
    },
    async pathOf(fileHandle) {
      try {
        const segs = await handle.resolve(fileHandle);
        return segs?.length ? segs.join('/') : null;
      } catch {
        return null;
      }
    },
    async same(other) {
      if (!other?.handle) return false;
      try {
        return await handle.isSameEntry(other.handle);
      } catch {
        return false;
      }
    },
  };
}

// What an archive made on a Mac carries besides its files.
const JUNK = /(^|\/)(__MACOSX\/|\._|\.DS_Store$|Thumbs\.db$)/i;

/** `blob` is the archive's File; `handle` its FileSystemFileHandle, when there is one. */
export async function folderFromArchive(blob, { name = blob.name, handle = null } = {}) {
  let entries = (await readArchive(blob)).filter((e) => !JUNK.test(e.path));
  // An archive that holds one folder opens as that folder.
  for (;;) {
    const top = new Set(entries.map((e) => e.path.split('/')[0]));
    if (top.size !== 1 || entries.some((e) => !e.path.includes('/'))) break;
    const root = [...top][0] + '/';
    entries = entries.map((e) => ({ ...e, path: e.path.slice(root.length) }));
  }
  const byPath = new Map(entries.map((e) => [e.path.toLowerCase(), e]));
  const self = {
    name,
    handle: null,
    archive: { name, handle },
    async readable() {
      return true;
    },
    async files() {
      return entries
        .filter((e) => !e.path.includes('/'))
        .map((e) => ({ name: e.path, handle: null, file: async () => new File([await e.read()], e.path) }));
    },
    // Matched without regard to case: the names in a DOS-era archive are
    // upper case, the ones a score was written with seldom are.
    async read(path) {
      const segs = splitPath(path);
      const e = segs && byPath.get(segs.join('/').toLowerCase());
      return e ? e.read() : null;
    },
    async pathOf() {
      return null;
    },
    async same(other) {
      if (other === self) return true;
      if (!handle || !other?.archive?.handle) return false;
      try {
        return await handle.isSameEntry(other.archive.handle);
      } catch {
        return false;
      }
    },
  };
  return self;
}

function splitPath(path) {
  const segs = String(path).split('/').filter((s) => s && s !== '.');
  return segs.length === 0 || segs.includes('..') ? null : segs;
}

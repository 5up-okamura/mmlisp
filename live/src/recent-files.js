// File > Open Recent: the scores opened or saved lately, kept as File System
// Access handles in IndexedDB (a handle survives a reload there; a path would
// not, and the page never learns one). A score that was opened from its folder
// keeps the folder's handle with it, so reopening brings its samples back too.
//
// Reopening asks the browser for access again unless it already holds it — an
// installed Chrome app can keep the grant between launches.

const DB_NAME = 'mmlisp';
const STORE = 'recent';
const KEY = 'list';
export const RECENT_MAX = 10;

export const recentSupported = typeof indexedDB !== 'undefined'
  && typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// [{ file: FileSystemFileHandle, dir: FileSystemDirectoryHandle | null }],
// newest first. Never throws: no storage means no list.
export async function loadRecent() {
  try {
    const list = await withStore('readonly', (s) => s.get(KEY));
    return Array.isArray(list) ? list.filter((e) => e?.file) : [];
  } catch {
    return [];
  }
}

async function saveRecent(list) {
  try {
    await withStore('readwrite', (s) => s.put(list, KEY));
  } catch { /* private window or storage off: the list just isn't kept */ }
}

async function sameEntry(a, b) {
  if (!a || !b) return a === b;
  try { return await a.isSameEntry(b); } catch { return false; }
}

// Move (or add) a score to the top. Returns the new list.
export async function addRecent(file, dir = null) {
  const list = await loadRecent();
  const kept = [];
  for (const e of list) if (!(await sameEntry(e.file, file))) kept.push(e);
  const next = [{ file, dir }, ...kept].slice(0, RECENT_MAX);
  await saveRecent(next);
  return next;
}

export async function removeRecent(file) {
  const list = await loadRecent();
  const kept = [];
  for (const e of list) if (!(await sameEntry(e.file, file))) kept.push(e);
  await saveRecent(kept);
  return kept;
}

export async function clearRecent() {
  await saveRecent([]);
  return [];
}

// Read access is enough to open; Save asks for write on its own. Must run from
// a user gesture when the browser has to ask.
export async function ensureReadAccess(handle) {
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

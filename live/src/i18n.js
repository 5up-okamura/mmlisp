// The app's display language, and the texts it translates: the reference's
// summaries and category names (reference.js) and the snippets' leading
// comments, as the Library, the completion and the hover show them. The rest
// of the app — the menus, the log, the compiler's diagnostics — stays in
// English: the words of a music tool read the same everywhere, and an AI on
// the MCP link reads the diagnostics.
//
// A language is one pack, i18n/<lang>.js, generated from the English by
// tools/scripts/i18n-sync.mjs (never edited by hand); each text sits beside
// a hash of the English it translates, so the sync finds what went stale.
// A text with no translation falls back to the English.
import ja from './i18n/ja.js';
import es from './i18n/es.js';

export const LANGUAGES = [['en', 'English'], ['ja', '日本語'], ['es', 'Español']];
const PACKS = { ja, es };
const STORE_KEY = 'mmlisp.lang';

function initialLanguage() {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved === 'en' || PACKS[saved]) return saved;
  } catch (_) { /* no storage: the browser's language */ }
  const nav = (globalThis.navigator?.language || 'en').slice(0, 2).toLowerCase();
  return PACKS[nav] ? nav : 'en';
}

let _lang = initialLanguage();
if (typeof document !== 'undefined') document.documentElement.lang = _lang;

export function language() { return _lang; }

export function setLanguage(lang) {
  _lang = PACKS[lang] ? lang : 'en';
  try { localStorage.setItem(STORE_KEY, _lang); } catch (_) {}
  if (typeof document !== 'undefined') document.documentElement.lang = _lang;
}

function pick(section, key, english) {
  const row = PACKS[_lang]?.[section]?.[key];
  return row ? row[1] : english;
}

export const refSummary = (entry) => pick('reference', entry.name, entry.summary);
export const refCategoryLabel = (id, english) => pick('categories', id, english);
export const snippetAbout = (path, english) => pick('snippets', path.replace(/^snippets\//, ''), english);

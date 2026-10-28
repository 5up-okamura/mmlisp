// What the song importers share between reading a file and writing the
// score (import-song.js): the defs a score names, keyed by what they hold,
// and the small notations every importer writes the same way.

/**
 * A score's defs, in the order they are first named. `of(key, make)` gives
 * the def `key` stands for, made on its first use: `make()` returns what the
 * caller keeps for it — `{ name, text }` puts `text` in the score, anything
 * else (a ROM voice's name, a level, null for a missing one) is kept only.
 * `uniq(base)` a name no def has taken; `taken` the names the score has
 * already (a preset's).
 */
export function defTable(taken = []) {
  const used = new Set(taken);
  const byKey = new Map();
  const texts = [];
  return {
    uniq(base) {
      let n = base;
      for (let k = 2; used.has(n); k++) n = `${base}-${k}`;
      used.add(n);
      return n;
    },
    of(key, make) {
      if (!byKey.has(key)) {
        const d = make();
        byKey.set(key, d);
        if (d?.text) texts.push(d.text);
      }
      return byKey.get(key);
    },
    /** A def no key names: written once, where it is added. */
    add(text) { texts.push(text); },
    texts,
  };
}

/** Text in Shift-JIS, as an X68000's or an MSX's file holds it. */
export const sjis = (u8) => { try { return new TextDecoder("shift-jis").decode(u8); } catch { return String.fromCharCode(...u8); } };

/**
 * Frame values as a macro vector: a run of one value is the value and a
 * wait; `sus` the frame `#sus` goes before.
 */
export function frameVector(values, sus) {
  const items = [];
  for (let k = 0; k < values.length; ) {
    if (k === sus) items.push("#sus");
    let n = 1;
    while (k + n < values.length && values[k + n] === values[k] && k + n !== sus) n++;
    items.push(String(values[k]));
    // The last value holds: a wait at the end only keeps a loop's length.
    if (n > 1 && (k + n < values.length || sus != null)) items.push(`(wait ${n - 1}f)`);
    k += n;
  }
  return `[${items.join(" ")}]`;
}

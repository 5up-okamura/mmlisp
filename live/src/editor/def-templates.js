// The defs the editor's completion writes out whole — a def-fm holding every
// parameter the machine's FM has, a def-wave as long as its wave memory, a
// def-pcm — read off the parts of the score's machine (targets.js). No
// machine is named here: a part brings its template as it brings its words,
// and `tools npm run check:def-templates` compiles each one on its machine.
import { FM_CHANNEL_WORDS, OPS, opWords, fmInitVoice } from "../machine/chips/fm-words.js";

/**
 * A def-fm's text: `values` (Map IR word → value, any order) laid out the
 * family's way — the channel's words on one line, then one line per
 * operator — over `base`. Words `values` lacks are left out.
 */
export function fmDefText(name, values, base = "init-fm") {
  const line = (ws) => ws.filter((w) => values.has(w.word)).map((w) => `${w.kw} ${values.get(w.word)}`).join(" ");
  const ops = OPS.map((op) => line(opWords().filter((w) => w.op === op)));
  const lines = [line(FM_CHANNEL_WORDS), ...ops].filter(Boolean);
  return `(def-fm ${name} ${base}\n${lines.map((l) => `  ${l}`).join("\n")})`;
}

// One cycle of a sine over a wave memory's steps, at the def-wave's range.
const sineSteps = (n) => Array.from({ length: n }, (_, i) => Math.round(127 * Math.sin((2 * Math.PI * i) / n)));

/**
 * The templates for `target` (a targets.js profile), one per part that has
 * a def of its own, a text written by two parts once: [{ head, part, text }].
 * An FM part's is its `init-fm` written out, every value to edit; a wave
 * part's a sine of its `waveLen` steps; a sample part's (not a ROM kit's) a
 * file to name.
 */
export function defTemplates(target, name = "name") {
  const out = [];
  for (const part of target.parts) {
    const text = part.kind === "fm" ? fmDefText(name, fmInitVoice(part))
      : part.kind === "wave" ? `(def-wave ${name} :wave [${sineSteps(part.waveLen ?? 32).join(" ")}])`
      : part.kind === "sample" && !part.kit ? `(def-pcm ${name} :file "sample.wav")`
      : null;
    if (text && !out.some((t) => t.text === text)) out.push({ head: text.slice(1, text.indexOf(" ")), part, text });
  }
  return out;
}

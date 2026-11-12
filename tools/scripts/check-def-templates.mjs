#!/usr/bin/env node
// The editor's def templates (live/src/editor/def-templates.js) are written out from
// each machine's parts: every one must compile clean on its machine, played
// by a channel of the part it was written for — and a def-fm must hold the
// part's own init-fm, the voice it starts from.
import { compileMMLisp } from "../../live/src/lang/mmlisp2ir.js";
import { TARGETS } from "../../live/src/machine/targets.js";
import { defTemplates } from "../../live/src/editor/def-templates.js";
import { fmInitVoice } from "../../live/src/machine/chips/fm-words.js";

let n = 0;
for (const [name, target] of Object.entries(TARGETS)) {
  for (const t of defTemplates(target, "tmpl")) {
    const head = target.headsOf(t.part.name)[0];
    const src = `(def-score :target ${name})\n${t.text}\n(${head} tmpl c)\n`;
    const { ir, diagnostics } = compileMMLisp(src, "template.mmlisp", {});
    const errors = diagnostics.filter((d) => d.severity === "error");
    if (errors.length) {
      for (const d of errors) console.error(`${name} ${t.part.name}: ${d.code} ${d.line}:${d.column} ${d.message}`);
      throw new Error(`the ${t.head} template for ${name}'s ${t.part.name} does not compile`);
    }
    if (t.part.kind === "fm") {
      const written = new Map([...t.text.matchAll(/:([a-z0-9-]+) (-?\d+)/g)].map((m) => [m[1], Number(m[2])]));
      if (written.size !== fmInitVoice(t.part).size) throw new Error(`${name}'s ${t.head} template leaves out some of its init-fm`);
    }
    if (!ir) throw new Error(`${name} ${t.part.name}: no IR`);
    n++;
  }
}
console.log(`Def templates ok: ${n} template(s) over ${Object.keys(TARGETS).length} machines`);

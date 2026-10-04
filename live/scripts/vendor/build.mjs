// Builds live/vendor/: the editor's CodeMirror packages as one ES module, and
// the Open Sans faces the UI uses — so the app needs no CDN and can run
// offline. Run `npm install && npm run build` here when bumping them, and
// commit the output.

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../vendor');
const mod = (p) => join(here, 'node_modules', p);
mkdirSync(join(out, 'fonts'), { recursive: true });

const PACKAGES = [
  '@codemirror/view', '@codemirror/state', '@codemirror/language',
  '@codemirror/commands', '@codemirror/autocomplete', '@codemirror/search',
  '@lezer/highlight',
];
const version = (p) => JSON.parse(readFileSync(mod(`${p}/package.json`), 'utf8')).version;

await build({
  stdin: {
    contents: PACKAGES.map((p) => `export * from '${p}';`).join('\n'),
    resolveDir: here,
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  minify: true,
  legalComments: 'none',
  banner: {
    js: `/* CodeMirror 6 bundle (MIT, see LICENSE-codemirror.txt): ${PACKAGES.map((p) => `${p}@${version(p)}`).join(' ')} */`,
  },
  outfile: join(out, 'codemirror.js'),
  logLevel: 'warning',
});
copyFileSync(mod('@codemirror/view/LICENSE'), join(out, 'LICENSE-codemirror.txt'));

// Open Sans 400/600/700, latin + latin-ext — the subsets Google Fonts served.
const ranges = JSON.parse(readFileSync(mod('@fontsource/open-sans/unicode.json'), 'utf8'));
const css = [`/* Open Sans ${version('@fontsource/open-sans')} (SIL OFL 1.1, see fonts/LICENSE-open-sans.txt) */`];
for (const subset of ['latin-ext', 'latin']) {
  for (const weight of [400, 600, 700]) {
    const file = `open-sans-${subset}-${weight}-normal.woff2`;
    copyFileSync(mod(`@fontsource/open-sans/files/${file}`), join(out, 'fonts', file));
    css.push(`@font-face{font-family:'Open Sans';font-style:normal;font-weight:${weight};font-display:swap;src:url(fonts/${file}) format('woff2');unicode-range:${ranges[subset]}}`);
  }
}
writeFileSync(join(out, 'open-sans.css'), css.join('\n') + '\n');
copyFileSync(mod('@fontsource/open-sans/LICENSE'), join(out, 'fonts', 'LICENSE-open-sans.txt'));

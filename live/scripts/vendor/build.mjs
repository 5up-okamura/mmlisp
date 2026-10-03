// Builds live/vendor/: the editor's CodeMirror packages as one ES module, so
// the app needs no CDN for its editor and can run offline. Run
// `npm install && npm run build` here when bumping them, and commit the output.

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../vendor');
const mod = (p) => join(here, 'node_modules', p);
mkdirSync(out, { recursive: true });

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

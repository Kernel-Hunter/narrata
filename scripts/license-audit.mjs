// Lists the licence of everything the web app and the extension ship, and fails on GPL, LGPL or
// AGPL (or an unknown licence).
//
//   node scripts/license-audit.mjs
//
// It builds both with source maps into a temporary folder and reads which npm packages the
// bundles were made from, then adds the files copied as they are (ONNX Runtime Web, pdf.js data,
// fonts) and the G2P data in src/engine/g2p/data.
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'narrata-licenses-'));

const quiet = { logLevel: 'silent' };
await build({ ...quiet, configFile: join(root, 'vite.config.ts'), root, build: { outDir: join(tmp, 'web'), emptyOutDir: true, sourcemap: true } });
await build({ ...quiet, configFile: join(root, 'vite.ext.config.ts'), define: { __NARRATA_TEST__: 'false' }, build: { outDir: join(tmp, 'ext'), emptyOutDir: true, sourcemap: true } });
await build({
  ...quiet,
  configFile: false,
  root,
  publicDir: false,
  define: { __NARRATA_TEST__: 'false' },
  build: {
    outDir: join(tmp, 'content'),
    sourcemap: true,
    lib: { entry: join(root, 'extension/src/content/index.ts'), formats: ['iife'], name: 'narrataContent', fileName: () => 'content.js' },
  },
});

/** Package directory of a file inside node_modules (the innermost package). */
function packageDir(file) {
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0) return null;
  const n = parts[i + 1]?.startsWith('@') ? 2 : 1;
  return parts.slice(0, i + 1 + n).join(sep);
}

const packages = new Map(); // dir -> { name, version, license, via }
function addPackage(dir, via) {
  if (packages.has(dir)) return;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN');
  packages.set(dir, { name: pkg.name, version: pkg.version, license, via });
}

const walk = (d, out = []) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
for (const map of walk(tmp).filter((f) => f.endsWith('.map'))) {
  const { sources = [] } = JSON.parse(readFileSync(map, 'utf8'));
  for (const s of sources) {
    const dir = packageDir(join(dirname(map), s));
    if (!dir) continue;
    // Source map paths are relative to the temporary folder: resolve them in the project.
    const rel = dir.slice(dir.indexOf('node_modules'));
    addPackage(realpathSync(join(root, rel)), 'bundled');
  }
}
rmSync(tmp, { recursive: true, force: true });

// Files shipped as they are (scripts/copy-assets.mjs, CSS imports).
const resolvePkg = (name, from = root) => {
  let d = from;
  for (;;) {
    const p = join(d, 'node_modules', name);
    try {
      statSync(join(p, 'package.json'));
      return realpathSync(p);
    } catch {
      if (dirname(d) === d) throw new Error(`Cannot find ${name}`);
      d = dirname(d);
    }
  }
};
const transformers = resolvePkg('@huggingface/transformers');
addPackage(resolvePkg('onnxruntime-web', transformers), 'copied (ort/)');
addPackage(resolvePkg('pdfjs-dist'), 'copied (pdfjs/)');
addPackage(resolvePkg('@fontsource/opendyslexic'), 'copied (font)');
addPackage(resolvePkg('signalsmith-stretch'), 'copied (audio worklet)');

const rows = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
// The G2P data (src/engine/g2p/data) and generated code.
const data = [
  { name: 'misaki lexicons (en-us.lex.gz, en-gb.lex.gz)', version: '0.9.4', license: 'Apache-2.0', via: 'G2P data' },
  { name: 'misaki fallback networks by Peter Reid (fallback-*.safetensors)', version: '-', license: 'Apache-2.0', via: 'G2P data' },
  { name: 'part-of-speech tagger (tagger.json.gz), trained by Narrata', version: '-', license: 'MIT', via: 'G2P data' },
  { name: 'spaCy tokenizer rules (spacy-rules.ts)', version: '3.8.16', license: 'MIT', via: 'G2P code' },
  // pdf.js data copied from pdfjs-dist (see the LICENSE_* files next to each).
  { name: 'pdf.js JBIG2 and OpenJPEG decoders (pdfjs/wasm)', version: '-', license: 'BSD-3-Clause, BSD-2-Clause, Apache-2.0', via: 'copied (pdfjs/)' },
  { name: 'pdf.js qcms and QuickJS (pdfjs/wasm)', version: '-', license: 'MIT', via: 'copied (pdfjs/)' },
  { name: 'pdf.js ICC profile (pdfjs/iccs)', version: '-', license: 'CC0-1.0', via: 'copied (pdfjs/)' },
  { name: 'pdf.js Foxit standard fonts (pdfjs/standard_fonts)', version: '-', license: 'BSD-3-Clause', via: 'copied (pdfjs/)' },
  // Font files, not code: used by pdf.js to draw PDFs whose fonts are not embedded. The font
  // exception keeps them from covering anything they are used with, and they ship as separate
  // files next to their licence, so they don't change Narrata's licence.
  { name: 'Liberation Sans fonts (pdfjs/standard_fonts)', version: '-', license: 'GPL-2.0 WITH font-exception', via: 'copied (pdfjs/), font files', allowed: true },
];

const BLOCKED = /\b(A|L)?GPL\b|GPL-|UNKNOWN/i;
let failed = false;
const w = [64, 32, 12];
console.log(`${'Component'.padEnd(w[0])} ${'Version'.padEnd(w[1])} ${'License'.padEnd(w[2])} Shipped as`);
for (const r of [...rows, ...data]) {
  const bad = BLOCKED.test(r.license) && !r.allowed;
  failed ||= bad;
  const note = bad ? '   <-- not allowed' : r.allowed ? '   (separate font files, allowed)' : '';
  console.log(`${r.name.padEnd(w[0])} ${String(r.version).padEnd(w[1])} ${r.license.padEnd(w[2])} ${r.via}${note}`);
}
console.log(`\n${rows.length} npm packages, ${data.length} data components.`);
if (failed) {
  console.error('License audit failed: GPL, LGPL, AGPL or unknown licence in the shipped code.');
  process.exit(1);
}
console.log('License audit passed: no GPL, LGPL or AGPL code is shipped. The only GPL files are the Liberation Sans fonts, under their font exception.');

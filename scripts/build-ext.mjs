// Builds the browser extension into dist-ext/ (load it with "Load unpacked").
// With --test it builds into dist-ext-test/ instead and keeps the hooks used by
// tests/e2e/verify-ext.mjs (__NARRATA_TEST__); the normal build has none of them.
//
// Everything the extension runs is bundled: Manifest V3 does not allow code from the network.
// The voice model is data and is downloaded at runtime into the extension's own storage.
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolveObjectURL } from 'node:buffer';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const test = process.argv.includes('--test');
// vite.ext.config.ts reads this too.
process.env.NARRATA_TEST = test ? '1' : '0';
const out = join(root, test ? 'dist-ext-test' : 'dist-ext');

// 1. Popup, offscreen document (with the TTS worker) and service worker.
await build({ configFile: join(root, 'vite.ext.config.ts'), logLevel: 'warn' });

// 2. Content script: one classic script, no imports.
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  publicDir: false,
  define: { __NARRATA_TEST__: JSON.stringify(test) },
  build: {
    outDir: out,
    emptyOutDir: false,
    target: 'es2022',
    sourcemap: false,
    minify: true,
    lib: { entry: join(root, 'extension/src/content/index.ts'), formats: ['iife'], name: 'narrataContent', fileName: () => 'content.js' },
  },
});

// 3. ONNX Runtime Web, loaded by the worker from ort/ (copied into public/ort by copy-assets).
// transformers.js makes Vite emit a second copy of the wasm; the worker never loads it.
for (const f of readdirSync(join(out, 'assets'))) if (/^ort-wasm.*\.wasm$/.test(f)) rmSync(join(out, 'assets', f));
cpSync(join(root, 'public/ort'), join(out, 'ort'), { recursive: true });

// 4. The Signalsmith Stretch audio worklet. The library builds it at runtime as a blob: URL,
// which extension pages may not load, so capture that module code once and ship it as a file.
{
  const { default: SignalsmithStretch } = await import(join(root, 'node_modules/signalsmith-stretch/SignalsmithStretch.mjs'));
  let url = null;
  globalThis.AudioWorkletNode = class {
    constructor() {
      throw new Error('not registered');
    }
  };
  const fakeContext = {
    audioWorklet: {
      addModule: (u) => {
        url = u;
        return Promise.reject(new Error('captured'));
      },
    },
  };
  await SignalsmithStretch(fakeContext).catch(() => {});
  delete globalThis.AudioWorkletNode;
  if (!url) throw new Error('Could not capture the Signalsmith Stretch worklet module');
  const code = await resolveObjectURL(url).text();
  writeFileSync(join(out, 'stretch-worklet.js'), code);
}

// 5. Manifest (version from package.json) and icons.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
mkdirSync(join(out, 'icons'), { recursive: true });
for (const f of readdirSync(join(root, 'extension/logo'))) copyFileSync(join(root, 'extension/logo', f), join(out, 'icons', f));

// 6. Licence and third-party notices next to the code.
copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
copyFileSync(join(root, 'NOTICE'), join(out, 'NOTICE'));
cpSync(join(root, 'LICENSES'), join(out, 'LICENSES'), { recursive: true });

let bytes = 0;
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else bytes += statSync(p).size;
  }
};
walk(out);
console.log(`${test ? 'dist-ext-test' : 'dist-ext'}/ built (${(bytes / 1e6).toFixed(1)} MB). Load it from chrome://extensions with "Load unpacked".`);

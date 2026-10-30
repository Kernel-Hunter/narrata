import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/** Writes dist/sw.js with the list of every built file, so the app works offline. */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'narrata-sw',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      // ONNX Runtime's bundled builds make Vite emit their own copy of the wasm. The worker loads
      // the self-hosted copy in ort/ (env.wasm.wasmPaths), so drop the duplicates.
      const assets = join(outDir, 'assets');
      for (const f of readdirSync(assets)) if (/^ort-wasm.*\.wasm$/.test(f)) rmSync(join(assets, f));
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split('\\').join('/'));
        }
      };
      walk(outDir);
      const list = files.filter((f) => f !== 'sw.js' && !f.endsWith('.map')).sort();
      const template = readFileSync('src/pwa/sw.js', 'utf8');
      const hash = createHash('sha256').update(template);
      for (const f of list) hash.update(f).update(readFileSync(join(outDir, f)));
      const precache = ['./', ...list.filter((f) => f !== 'index.html').map((f) => `./${f}`), './index.html'];
      const src = template
        .replaceAll('__VERSION__', hash.digest('hex').slice(0, 12))
        .replaceAll('__PRECACHE__', JSON.stringify(precache));
      writeFileSync(join(outDir, 'sw.js'), src);
    },
  };
}

/** Copies the licence and the third-party notices into the build. */
function notices(): Plugin {
  let outDir = 'dist';
  return {
    name: 'narrata-notices',
    apply: 'build',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      for (const f of ['LICENSE', 'NOTICE']) copyFileSync(f, join(outDir, f));
      cpSync('LICENSES', join(outDir, 'LICENSES'), { recursive: true });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [notices(), serviceWorker()],
  server: { port: 5330, strictPort: true, headers: isolationHeaders },
  // No headers in preview on purpose: the production build must isolate itself via the service worker.
  preview: { port: 5331, strictPort: true, headers: {} },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, sourcemap: false },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});

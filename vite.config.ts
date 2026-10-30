import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Files the page needs to start: index.html, what it links to (entry script, stylesheet, icons,
 * manifest), the modules those import statically, and the TTS worker script. Everything else is
 * cached when first used or warmed in the background after the service worker is active.
 */
function shellFiles(outDir: string, all: Set<string>): string[] {
  const shell = new Set<string>(['index.html', 'manifest.webmanifest']);
  for (const f of all) if (f.startsWith('icons/')) shell.add(f);
  const html = readFileSync(join(outDir, 'index.html'), 'utf8');
  const queue = [...html.matchAll(/(?:src|href)="\.\/([^"?#]+)"/g)].map((m) => m[1]);
  while (queue.length) {
    const f = queue.shift()!;
    if (!all.has(f) || shell.has(f)) continue;
    shell.add(f);
    if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue;
    const code = readFileSync(join(outDir, f), 'utf8');
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
    // Static imports (not import(...)), and the worker script the entry starts with new Worker().
    for (const m of code.matchAll(/(?:\bimport|\bfrom)\s*["'`]\.\/([^"'`]+)["'`]/g)) queue.push(dir + m[1]);
    for (const m of code.matchAll(/["'`](?:\.\/)?(worker-[\w-]+\.js)["'`]/g)) queue.push(dir + m[1]);
  }
  return [...shell].filter((f) => all.has(f));
}

/**
 * Writes dist/sw.js with two lists: SHELL, cached while the worker installs (small, so the page
 * becomes cross-origin isolated within seconds even on a slow link), and PRECACHE, every other
 * built file with a short content hash, cached in the background once the worker runs so the
 * app works offline after the first visit.
 */
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
      const version = createHash('sha256').update(template);
      const revs: Record<string, string> = {};
      for (const f of list) {
        const data = readFileSync(join(outDir, f));
        version.update(f).update(data);
        revs[`./${f}`] = createHash('sha256').update(data).digest('hex').slice(0, 10);
      }
      revs['./'] = revs['./index.html'];
      const shell = ['./', ...shellFiles(outDir, new Set(list)).map((f) => `./${f}`)];
      const rest = Object.keys(revs).filter((f) => !shell.includes(f));
      const src = template
        .replaceAll('__VERSION__', version.digest('hex').slice(0, 12))
        .replaceAll('__SHELL__', JSON.stringify(shell))
        .replaceAll('__PRECACHE__', JSON.stringify(rest))
        .replaceAll('__REVS__', JSON.stringify(revs));
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

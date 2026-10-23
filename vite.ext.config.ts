// Build of the browser extension pages (popup, offscreen document) and the service worker.
// The content script is built separately as one classic script (see scripts/build-ext.mjs),
// because content scripts cannot load modules.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = resolve(import.meta.dirname, 'extension');

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  worker: { format: 'es' },
  build: {
    outDir: resolve(import.meta.dirname, 'dist-ext'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: resolve(root, 'popup.html'),
        offscreen: resolve(root, 'offscreen.html'),
        background: resolve(root, 'src/background.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});

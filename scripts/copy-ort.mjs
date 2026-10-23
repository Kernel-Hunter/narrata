// Copies the ONNX Runtime Web files that transformers.js loads at runtime into public/ort,
// so the app serves them itself (no CDN, works offline).
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'node_modules', '@huggingface', 'transformers', 'dist');
const out = join(root, 'public', 'ort');
mkdirSync(out, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  const src = join(dist, f);
  const dst = join(out, f);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  console.log(`copied ${f}`);
}

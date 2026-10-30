// Copies runtime files that libraries load by URL into public/, so the app serves them itself
// (no CDN, works offline): the ONNX Runtime Web builds, and the pdf.js
// fonts, character maps and image decoders.
import { cpSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');

const ortDir = join(nm, 'onnxruntime-web', 'dist');
const ortOut = join(root, 'public', 'ort');
mkdirSync(ortOut, { recursive: true });
// The plain build runs the model on the processor; the JSEP build adds WebGPU.
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  const src = join(ortDir, f);
  const dst = join(ortOut, f);
  if (existsSync(dst) && statSync(dst).size === statSync(src).size) continue;
  copyFileSync(src, dst);
  console.log(`copied ort/${f}`);
}

const pdfOut = join(root, 'public', 'pdfjs');
for (const d of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
  const dst = join(pdfOut, d);
  if (existsSync(dst)) continue;
  cpSync(join(nm, 'pdfjs-dist', d), dst, { recursive: true });
  console.log(`copied pdfjs/${d}`);
}

// Builds the G2P data files in src/engine/g2p/data/ from their sources:
//
//   node scripts/g2p/build-data.mjs <misaki checkout> <bart-us dir> <bart-gb dir> <tagger.json>
//
// - misaki lexicons (misaki/data/{us,gb}_{gold,silver}.json, Apache-2.0, hexgrad/misaki)
//     -> en-us.lex.gz, en-gb.lex.gz: sorted "word<TAB>phonemes" lines, gold then silver. Homographs
//        are written as "@TAG=phonemes|TAG=phonemes" (an empty value stands for null).
// - misaki's fallback networks (config.json + model.safetensors from
//   huggingface.co/PeterReid/graphemes_to_phonemes_en_{us,gb}, Apache-2.0)
//     -> fallback-us.safetensors, fallback-gb.safetensors: the same tensors in float16, with the
//        grapheme and phoneme alphabets in the header metadata.
// - the tagger trained by scripts/g2p/train_tagger.py -> tagger.json.gz
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const [misaki, bartUs, bartGb, taggerJson] = process.argv.slice(2);
if (!taggerJson) {
  console.error('usage: node scripts/g2p/build-data.mjs <misaki checkout> <bart-us dir> <bart-gb dir> <tagger.json>');
  process.exit(1);
}
const out = join(dirname(fileURLToPath(import.meta.url)), '../../src/engine/g2p/data');
mkdirSync(out, { recursive: true });

const sizes = {};
const write = (name, data) => {
  writeFileSync(join(out, name), data);
  sizes[name] = data.length;
};

function lexiconLines(file) {
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const keys = Object.keys(d).sort();
  return keys.map((k) => {
    const v = d[k];
    if (typeof v === 'string') return `${k}\t${v}`;
    const parts = Object.keys(v)
      .sort()
      .map((tag) => `${tag}=${v[tag] ?? ''}`);
    return `${k}\t@${parts.join('|')}`;
  });
}

for (const acc of ['us', 'gb']) {
  const dir = join(misaki, 'misaki/data');
  const text = ['#gold', ...lexiconLines(join(dir, `${acc}_gold.json`)), '#silver', ...lexiconLines(join(dir, `${acc}_silver.json`)), ''].join('\n');
  write(`en-${acc}.lex.gz`, gzipSync(text, { level: 9 }));
}

function toF16(dir) {
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  const buf = readFileSync(join(dir, 'model.safetensors'));
  const n = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + n).toString('utf8'));
  const base = 8 + n;
  const tensors = [];
  for (const [name, t] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    if (t.dtype !== 'F32') throw new Error(`${name}: expected F32`);
    const [a, b] = t.data_offsets;
    const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset + base + a, buf.byteOffset + base + b));
    tensors.push({ name, shape: t.shape, data: new Uint8Array(new Float16Array(f32).buffer) });
  }
  tensors.sort((x, y) => (x.name < y.name ? -1 : 1));
  const meta = { format: 'pt', grapheme_chars: cfg.grapheme_chars, phoneme_chars: cfg.phoneme_chars, source: dir.split('/').pop() };
  const h = { __metadata__: meta };
  let off = 0;
  for (const t of tensors) {
    h[t.name] = { dtype: 'F16', shape: t.shape, data_offsets: [off, off + t.data.length] };
    off += t.data.length;
  }
  let hjson = Buffer.from(JSON.stringify(h), 'utf8');
  const pad = (8 - (hjson.length % 8)) % 8;
  hjson = Buffer.concat([hjson, Buffer.from(' '.repeat(pad))]);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(hjson.length));
  return Buffer.concat([len, hjson, ...tensors.map((t) => Buffer.from(t.data))]);
}

write('fallback-us.safetensors', toF16(bartUs));
write('fallback-gb.safetensors', toF16(bartGb));

const tagger = JSON.parse(readFileSync(taggerJson, 'utf8'));
write('tagger.json.gz', gzipSync(JSON.stringify(tagger), { level: 9 }));

for (const [k, v] of Object.entries(sizes)) console.log(`${k.padEnd(28)} ${(v / 1024).toFixed(0).padStart(6)} KB`);

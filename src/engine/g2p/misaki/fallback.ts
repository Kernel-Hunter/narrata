// Spelling-to-sound model for words that are not in the lexicon. It is the network misaki uses
// as its own fallback (FallbackNetwork in misaki/en.py): a one-layer BART trained on misaki's
// lexicons by Peter Reid, https://huggingface.co/PeterReid/graphemes_to_phonemes_en_us (and _gb),
// Apache-2.0. The model is tiny (128 dimensions, one encoder and one decoder layer, 0.7 M weights),
// so it runs here in plain TypeScript with greedy decoding.

export interface BartConfig {
  graphemeChars: string;
  phonemeChars: string;
}

export type Tensors = Map<string, Float32Array>;

const D = 128;
const FFN = 1024;
const BOS = 1;
const EOS = 2;
const UNK = 3;
/** Learned position embeddings have 64 + 2 rows (BART offsets positions by 2). */
const MAX_POSITIONS = 64;

/** Reads a safetensors file (F32 or F16 tensors). */
export function readSafetensors(buf: ArrayBuffer): Tensors {
  const view = new DataView(buf);
  const n = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))) as Record<string, { dtype: string; shape: number[]; data_offsets: [number, number] }>;
  const base = 8 + n;
  const out: Tensors = new Map();
  for (const [name, t] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    const [a, b] = t.data_offsets;
    const bytes = new Uint8Array(buf.slice(base + a, base + b));
    if (t.dtype === 'F32') out.set(name, new Float32Array(bytes.buffer));
    else if (t.dtype === 'F16') {
      const h = new Uint16Array(bytes.buffer);
      const f = new Float32Array(h.length);
      for (let i = 0; i < h.length; i++) f[i] = halfToFloat(h[i]);
      out.set(name, f);
    } else throw new Error(`Unsupported tensor type ${t.dtype}`);
  }
  return out;
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** erf, accurate to about 1e-9 (enough for GELU). */
function erf(x: number): number {
  const ax = Math.abs(x);
  if (ax > 4) return Math.sign(x);
  // Maclaurin series: erf(x) = 2/sqrt(pi) * sum (-1)^n x^(2n+1) / (n! (2n+1))
  let term = ax;
  let sum = ax;
  const x2 = ax * ax;
  for (let n = 1; n < 100; n++) {
    term *= -x2 / n;
    const add = term / (2 * n + 1);
    sum += add;
    if (Math.abs(add) < 1e-17) break;
  }
  return Math.sign(x) * (2 / Math.sqrt(Math.PI)) * sum;
}

const gelu = (x: number) => 0.5 * x * (1 + erf(x / Math.SQRT2));

/** y = x W^T + b for each row of x (rows of length `inDim`). */
function linear(x: Float32Array, rows: number, w: Float32Array, b: Float32Array, inDim: number, outDim: number): Float32Array {
  const y = new Float32Array(rows * outDim);
  for (let r = 0; r < rows; r++) {
    const xo = r * inDim;
    for (let o = 0; o < outDim; o++) {
      let s = b[o];
      const wo = o * inDim;
      for (let i = 0; i < inDim; i++) s += x[xo + i] * w[wo + i];
      y[r * outDim + o] = s;
    }
  }
  return y;
}

function layerNorm(x: Float32Array, rows: number, g: Float32Array, b: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  for (let r = 0; r < rows; r++) {
    const o = r * D;
    let mean = 0;
    for (let i = 0; i < D; i++) mean += x[o + i];
    mean /= D;
    let v = 0;
    for (let i = 0; i < D; i++) v += (x[o + i] - mean) ** 2;
    const inv = 1 / Math.sqrt(v / D + 1e-5);
    for (let i = 0; i < D; i++) y[o + i] = (x[o + i] - mean) * inv * g[i] + b[i];
  }
  return y;
}

function add(a: Float32Array, b: Float32Array): Float32Array {
  const y = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) y[i] = a[i] + b[i];
  return y;
}

export class BartFallback {
  private readonly w: Tensors;
  private readonly g2t: Map<string, number>;
  private readonly phonemes: string[];

  constructor(tensors: Tensors, config: BartConfig) {
    this.w = tensors;
    this.g2t = new Map([...config.graphemeChars].map((c, i) => [c, i]));
    this.phonemes = [...config.phonemeChars];
  }

  private t(name: string): Float32Array {
    const v = this.w.get(name);
    if (!v) throw new Error(`Missing tensor ${name}`);
    return v;
  }

  private embed(ids: number[], prefix: 'encoder' | 'decoder', past: number): Float32Array {
    const shared = this.t('model.shared.weight');
    const pos = this.t(`model.${prefix}.embed_positions.weight`);
    const x = new Float32Array(ids.length * D);
    ids.forEach((id, r) => {
      for (let i = 0; i < D; i++) x[r * D + i] = shared[id * D + i] + pos[(past + r + 2) * D + i];
    });
    return layerNorm(x, ids.length, this.t(`model.${prefix}.layernorm_embedding.weight`), this.t(`model.${prefix}.layernorm_embedding.bias`));
  }

  private project(p: string, x: Float32Array, rows: number, which: 'q' | 'k' | 'v'): Float32Array {
    return linear(x, rows, this.t(`${p}.${which}_proj.weight`), this.t(`${p}.${which}_proj.bias`), D, D);
  }

  /** Single-head attention of query rows over projected keys and values (`limit` keys per row). */
  private attend(p: string, Q: Float32Array, qRows: number, K: Float32Array, V: Float32Array, limit: (r: number) => number): Float32Array {
    const scale = 1 / Math.sqrt(D);
    const out = new Float32Array(qRows * D);
    const scores = new Float64Array(K.length / D);
    for (let r = 0; r < qRows; r++) {
      const n = limit(r);
      let max = -Infinity;
      for (let k = 0; k < n; k++) {
        let s = 0;
        for (let i = 0; i < D; i++) s += Q[r * D + i] * scale * K[k * D + i];
        scores[k] = s;
        if (s > max) max = s;
      }
      let sum = 0;
      for (let k = 0; k < n; k++) sum += scores[k] = Math.exp(scores[k] - max);
      for (let k = 0; k < n; k++) {
        const a = scores[k] / sum;
        for (let i = 0; i < D; i++) out[r * D + i] += a * V[k * D + i];
      }
    }
    return linear(out, qRows, this.t(`${p}.out_proj.weight`), this.t(`${p}.out_proj.bias`), D, D);
  }

  private ffn(p: string, x: Float32Array, rows: number): Float32Array {
    const h = linear(x, rows, this.t(`${p}.fc1.weight`), this.t(`${p}.fc1.bias`), D, FFN);
    for (let i = 0; i < h.length; i++) h[i] = gelu(h[i]);
    return linear(h, rows, this.t(`${p}.fc2.weight`), this.t(`${p}.fc2.bias`), FFN, D);
  }

  private encode(ids: number[]): Float32Array {
    const p = 'model.encoder.layers.0';
    const n = ids.length;
    let h = this.embed(ids, 'encoder', 0);
    const a = `${p}.self_attn`;
    const att = this.attend(a, this.project(a, h, n, 'q'), n, this.project(a, h, n, 'k'), this.project(a, h, n, 'v'), () => n);
    h = layerNorm(add(h, att), n, this.t(`${p}.self_attn_layer_norm.weight`), this.t(`${p}.self_attn_layer_norm.bias`));
    return layerNorm(add(h, this.ffn(p, h, n)), n, this.t(`${p}.final_layer_norm.weight`), this.t(`${p}.final_layer_norm.bias`));
  }

  /** Phonemes for a word (graphemes outside the model's alphabet become the unknown token). */
  run(word: string, maxTokens = MAX_POSITIONS - 2): string {
    const enc = [BOS, ...[...word].map((g) => this.g2t.get(g) ?? UNK), EOS].slice(0, MAX_POSITIONS);
    const memory = this.encode(enc);
    const p = 'model.decoder.layers.0';
    const shared = this.t('model.shared.weight');
    const bias = this.t('final_logits_bias');
    const vocab = bias.length;
    const out = [BOS];
    const sa = `${p}.self_attn`;
    const ca = `${p}.encoder_attn`;
    // Keys and values: the cross-attention ones are fixed, the self-attention ones grow by one row
    // per generated token (the decoder has one layer, so earlier rows never change).
    const crossK = this.project(ca, memory, enc.length, 'k');
    const crossV = this.project(ca, memory, enc.length, 'v');
    const selfK = new Float32Array(MAX_POSITIONS * D);
    const selfV = new Float32Array(MAX_POSITIONS * D);
    for (let step = 0; step < maxTokens; step++) {
      const n = out.length;
      let h = this.embed([out[n - 1]], 'decoder', n - 1);
      selfK.set(this.project(sa, h, 1, 'k'), (n - 1) * D);
      selfV.set(this.project(sa, h, 1, 'v'), (n - 1) * D);
      h = layerNorm(add(h, this.attend(sa, this.project(sa, h, 1, 'q'), 1, selfK, selfV, () => n)), 1, this.t(`${p}.self_attn_layer_norm.weight`), this.t(`${p}.self_attn_layer_norm.bias`));
      h = layerNorm(add(h, this.attend(ca, this.project(ca, h, 1, 'q'), 1, crossK, crossV, () => enc.length)), 1, this.t(`${p}.encoder_attn_layer_norm.weight`), this.t(`${p}.encoder_attn_layer_norm.bias`));
      h = layerNorm(add(h, this.ffn(p, h, 1)), 1, this.t(`${p}.final_layer_norm.weight`), this.t(`${p}.final_layer_norm.bias`));
      let best = 0;
      let bestScore = -Infinity;
      for (let v = 0; v < vocab; v++) {
        let s = bias[v];
        for (let i = 0; i < D; i++) s += h[i] * shared[v * D + i];
        if (s > bestScore) {
          bestScore = s;
          best = v;
        }
      }
      if (best === EOS) break;
      out.push(best);
    }
    return out
      .slice(1)
      .filter((t) => t > 3)
      .map((t) => this.phonemes[t] ?? '')
      .join('');
  }
}

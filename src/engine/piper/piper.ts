// Piper (VITS) voices: much smaller and faster than Kokoro, for computers that cannot generate
// Kokoro's audio in real time. Input is eSpeak-style IPA (from Narrata's G2P, see espeak-ipa.ts);
// the graph is patched to also return each phoneme's length so words can be highlighted.

import type { PhonemeToken } from '../g2p/types';
import type { OrtModule, Session } from '../runtime';
import { toEspeakIpa } from './espeak-ipa';
import { addGraphOutput, findNodeOutput } from './onnx-patch';

export interface PiperConfig {
  audio: { sample_rate: number };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
}

/** Samples per duration frame (the VITS decoder's hop length). */
const HOP = 256;

export interface PiperInput {
  ids: number[];
  /** The eSpeak phoneme characters, one per model phoneme (pads excluded). */
  phonemes: string[];
  /** Index into the G2P tokens for each phoneme, -1 for a space between tokens. */
  owner: number[];
}

/** Model input for G2P tokens: ^ _ p1 _ p2 _ ... pn _ $ (Piper's layout). */
export function piperInput(tokens: PhonemeToken[], british: boolean, idMap: Record<string, number[]>): PiperInput {
  const phonemes: string[] = [];
  const owner: number[] = [];
  const space = () => {
    if (phonemes.length && phonemes[phonemes.length - 1] !== ' ') {
      phonemes.push(' ');
      owner.push(-1);
    }
  };
  tokens.forEach((t, i) => {
    for (const c of toEspeakIpa(t.phonemes, british)) {
      if (c === ' ') space();
      else if (idMap[c]) {
        phonemes.push(c);
        owner.push(i);
      }
    }
    if (t.whitespace) space();
  });
  while (phonemes[phonemes.length - 1] === ' ') {
    phonemes.pop();
    owner.pop();
  }
  const pad = idMap._[0];
  const ids = [idMap['^'][0], pad];
  for (const c of phonemes) ids.push(idMap[c][0], pad);
  ids.push(idMap.$[0]);
  return { ids, phonemes, owner };
}

/**
 * Per-phoneme durations in the layout the word timing code expects (Kokoro's): the leading
 * pad, one value per phoneme, the trailing pad. Each phoneme takes the pad that follows it.
 */
export function phonemeDurations(perId: number[], count: number): number[] {
  const out = [perId[0] + perId[1]];
  for (let k = 0; k < count; k++) out.push(perId[2 + 2 * k] + perId[3 + 2 * k]);
  out.push(perId[perId.length - 1]);
  return out;
}

/** Cubic (Catmull-Rom) resampling. Used to bring Piper's 22.05 kHz up to the app's 24 kHz. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const n = Math.floor((x.length * to) / from);
  const out = new Float32Array(n);
  const step = from / to;
  const at = (i: number) => x[Math.min(x.length - 1, Math.max(0, i))];
  for (let j = 0; j < n; j++) {
    const t = j * step;
    const i = Math.floor(t);
    const f = t - i;
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    out[j] = p1 + 0.5 * f * (p2 - p0 + f * (2 * p0 - 5 * p1 + 4 * p2 - p3 + f * (3 * (p1 - p2) + p3 - p0)));
  }
  return out;
}

export class PiperModel {
  private constructor(
    private readonly ort: OrtModule,
    private readonly session: Session,
    readonly config: PiperConfig,
    private readonly durationsName: string,
  ) {}

  static async load(ort: OrtModule, model: Uint8Array, config: PiperConfig): Promise<PiperModel> {
    const name = findNodeOutput(model, 'Ceil');
    if (!name) throw new Error('This Piper voice has no duration output');
    const session = await ort.InferenceSession.create(addGraphOutput(model, name), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return new PiperModel(ort, session, config, name);
  }

  get sampleRate(): number {
    return this.config.audio.sample_rate;
  }

  /** Audio at the voice's sample rate and the frames of each id of `ids`. */
  async run(ids: number[]): Promise<{ audio: Float32Array; frames: number[] }> {
    const { noise_scale, length_scale, noise_w } = this.config.inference;
    const out = await this.session.run({
      input: new this.ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      input_lengths: new this.ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new this.ort.Tensor('float32', new Float32Array([noise_scale, length_scale, noise_w]), [3]),
    });
    const audio = new Float32Array(out.output.data as Float32Array);
    const frames = Array.from(out[this.durationsName].data as Float32Array);
    for (const t of Object.values(out)) t.dispose();
    return { audio, frames };
  }

  async release(): Promise<void> {
    await this.session.release();
  }
}

export const PIPER_HOP = HOP;

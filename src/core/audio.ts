// Pure audio helpers: chunk sanity checks, silence trimming at chunk joints, WAV encoding.

import type { ChunkEnd } from './chunker';

export interface SanityResult {
  ok: boolean;
  reason?: 'empty' | 'nan' | 'clipping' | 'silent' | 'silent-tail';
  peak: number;
  nan: number;
}

/**
 * Detects the broken outputs seen in the spike: NaN samples (WASM fp16), clipping (WebGPU q8,
 * peak 6.8) and audio that goes silent part way (WebGPU fp16, silent after 65,535 samples).
 * `speechEnd` (seconds) comes from the model durations when available.
 */
export function checkAudio(a: Float32Array, sampleRate: number, speechEnd?: number): SanityResult {
  if (a.length === 0) return { ok: false, reason: 'empty', peak: 0, nan: 0 };
  let peak = 0;
  let nan = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x !== x) nan++;
    else {
      const ax = x < 0 ? -x : x;
      if (ax > peak) peak = ax;
    }
  }
  if (nan > 0) return { ok: false, reason: 'nan', peak, nan };
  if (peak > 1.5) return { ok: false, reason: 'clipping', peak, nan };
  if (peak < 1e-3) return { ok: false, reason: 'silent', peak, nan };
  // Silent tail: the last audible sample must come close to where speech should end.
  const thr = peak * 0.01;
  let last = a.length - 1;
  while (last > 0 && Math.abs(a[last]) < thr) last--;
  const lastSec = last / sampleRate;
  const expected = speechEnd ?? a.length / sampleRate;
  if (expected > 1 && lastSec < expected * 0.75 - 0.25) return { ok: false, reason: 'silent-tail', peak, nan };
  return { ok: true, peak, nan };
}

/** Pause targets (ms) after a chunk, by what ends it. */
export const PAUSE_MS: Record<ChunkEnd, number> = {
  none: 40,
  clause: 170,
  sentence: 330,
  block: 520,
  heading: 650,
};

export interface Trimmed {
  audio: Float32Array;
  /** Seconds removed from the start (word timings must be shifted by this). */
  leadTrimmed: number;
}

/** First and last audible samples, using 5 ms frames and a threshold relative to the peak. */
export function speechBounds(a: Float32Array, sampleRate: number): [number, number] {
  const frame = Math.max(1, Math.round(sampleRate * 0.005));
  let peak = 0;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, Math.abs(a[i]));
  const thr = Math.max(peak * 0.02, 1e-4);
  const loud = (i: number) => {
    let m = 0;
    for (let k = i; k < Math.min(a.length, i + frame); k++) m = Math.max(m, Math.abs(a[k]));
    return m >= thr;
  };
  let first = 0;
  while (first < a.length && !loud(first)) first += frame;
  let last = a.length - frame;
  while (last > first && !loud(last)) last -= frame;
  return [Math.min(first, a.length), Math.min(a.length, last + frame)];
}

/**
 * Normalise the silence around a chunk so joints sound like natural pauses: keep a short lead-in,
 * and make the trailing silence match the pause expected after the chunk.
 */
export function shapeJoint(a: Float32Array, sampleRate: number, endsWith: ChunkEnd, leadMs = 30): Trimmed {
  const [first, last] = speechBounds(a, sampleRate);
  if (first >= last) return { audio: a, leadTrimmed: 0 };
  const lead = Math.round((leadMs / 1000) * sampleRate);
  const start = Math.max(0, first - lead);
  // Keep a short release after the last audible frame so soft endings are not cut.
  const release = Math.round(0.06 * sampleRate);
  const speechEnd = Math.min(a.length, last + release);
  const pause = Math.round((PAUSE_MS[endsWith] / 1000) * sampleRate);
  const total = speechEnd - start + Math.max(0, pause - release);
  const out = new Float32Array(total);
  out.set(a.subarray(start, speechEnd));
  // Short fade-out over the release to avoid clicks where the tail is cut.
  const fade = Math.min(release, speechEnd - start);
  for (let i = 0; i < fade; i++) out[speechEnd - start - fade + i] *= 1 - i / fade;
  return { audio: out, leadTrimmed: start / sampleRate };
}

export function concatFloat32(parts: Float32Array[]): Float32Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(n);
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return buf;
}

/** Duration in seconds of a 16-bit mono WAV produced by encodeWav. */
export function wavDuration(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  return v.getUint32(40, true) / 2 / v.getUint32(24, true);
}

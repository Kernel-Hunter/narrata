// Choices that depend on how fast this device is: model variant, thread count, chunk sizes and
// when to suggest the faster voice. Pure functions, so the policy can be tested without a browser.

import { MERGE_CHARS, type PlanOptions } from './chunker';

export type CpuVariant = 'q8' | 'uint8';

/**
 * Model for the CPU path. uint8 (static quantisation) runs about twice as fast as q8 in ONNX
 * Runtime Web, so new installs get it. A browser that already stored q8 and not uint8 keeps q8
 * instead of downloading the model again.
 */
export function cpuVariant(hasQ8: boolean, hasUint8: boolean): CpuVariant {
  return hasQ8 && !hasUint8 ? 'q8' : 'uint8';
}

/**
 * WASM threads. Without cross-origin isolation there is no SharedArrayBuffer, so one thread.
 * Otherwise one core is left for the page, up to four threads (more gave nothing). A two-core
 * device still gets two: the second thread made generation 1.5 times faster in measurements, and
 * the audio runs on its own high-priority thread.
 */
export function threadCount(hardwareConcurrency: number | undefined, crossOriginIsolated: boolean): number {
  if (!crossOriginIsolated) return 1;
  const cores = hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, cores <= 2 ? cores : cores - 1));
}

/**
 * Chunk sizes for the device's speed (rtf = seconds of audio per second of compute):
 * sentences when generation is fast; short chunks first when it is barely faster than playback,
 * to build a lead; joined sentences when playback has to wait anyway, since fewer chunks
 * generate faster.
 */
export function chunkPlan(rtf: number, rate: number): PlanOptions {
  const ratio = rtf / rate;
  if (ratio >= 2) return {};
  if (ratio >= 1.3) return { ramp: true };
  return { merge: MERGE_CHARS };
}

/** Seconds of natural-voice audio measured before the faster voice may be suggested. */
export const OFFER_AFTER_SEC = 15;
/** Below this real-time factor (times the speed, at least 1x) the natural voice cannot keep up. */
export const OFFER_RTF = 1.1;

/**
 * Whether to suggest the faster voice: only once, only for the natural voice on the CPU, and only
 * after enough audio to trust the measured speed.
 */
export function shouldOfferFastVoice(o: {
  offered: boolean;
  piper: boolean;
  device: 'wasm' | 'webgpu' | undefined;
  rtf: number;
  seconds: number;
  rate: number;
}): boolean {
  if (o.offered || o.piper || o.device !== 'wasm') return false;
  return o.seconds >= OFFER_AFTER_SEC && o.rtf < OFFER_RTF * Math.max(1, o.rate);
}

// ---- first run: which voice to recommend ----------------------------------------------------

/** What the worker found out about this device before the first download (engine/probe.ts). */
export interface DeviceProbe {
  /** navigator.hardwareConcurrency (logical cores). */
  cores?: number;
  /** navigator.deviceMemory in GB (Chromium only, rounded and capped at 8). */
  memoryGB?: number;
  /** A WebGPU adapter is available. */
  webgpu: boolean;
  /** Multi-threaded WebAssembly is possible. */
  crossOriginIsolated: boolean;
  /** WebAssembly SIMD benchmark, millions of rounds per second on one thread (none without SIMD). */
  benchScore?: number;
  benchMs?: number;
}

export type VoiceKind = 'natural' | 'fast';

export interface VoiceAdvice {
  pick: VoiceKind;
  /** Estimated speed of the natural voice on the processor (seconds of audio per second). */
  naturalRtf: number | null;
  /** One plain sentence on why. */
  reason: string;
}

/**
 * Calibration, measured with scripts/bench/device-check.mjs on the reference computer (Apple M5
 * laptop, Chrome, benchmark in the TTS worker, natural voice uint8 with 4 threads) and on the same
 * computer slowed down by the operating system (cpu-bench.mjs levels):
 *
 *   level             score   natural voice (x real time)
 *   reference          755    2.52
 *   2 (duty cycle)     356    1.24
 *   4 (E-cores+duty)   309    0.70
 *   6 (E-cores+duty)   156    0.34
 *
 * The voice slows down faster than the single-thread score once the work moves to the efficiency
 * cores (memory and four threads on slower cores), so the speed follows the score to the power
 * 1.2 rather than linearly: 1.02, 0.86 and 0.38 for the three slower levels, within about 20%.
 */
export const REF_SCORE = 755;
export const REF_RTF = 2.5;
export const SCORE_EXP = 1.2;
/** Speed of the natural voice with 1, 2, 3 and 4 threads, relative to 4 (M5: 0.86, 1.51, 2.08, 2.46x). */
export const THREAD_SPEED = [0.35, 0.61, 0.84, 1];

/** Natural voice speed on the processor, from the benchmark score and the threads it would get. */
export function estimateNaturalRtf(score: number, threads: number): number {
  const t = Math.max(1, Math.min(4, Math.round(threads)));
  return REF_RTF * Math.pow(score / REF_SCORE, SCORE_EXP) * THREAD_SPEED[t - 1];
}

/** Without a graphics chip, the natural voice is recommended from this estimated speed up. */
export const NATURAL_RTF = 1.3;

/**
 * Which voice to suggest before the first download. The natural voice needs to generate speech
 * faster than it is played; the estimate has some error, so without WebGPU it is recommended only
 * with a margin (1.3x). With WebGPU the voice normally runs on the graphics chip, which is faster
 * than the processor, but that is not measured here: it is recommended when even the processor
 * would keep up (the bar at which the fast voice is offered during reading, OFFER_RTF). Little
 * memory (under 4 GB) always gets the fast voice. The user can pick either; this is a suggestion.
 */
export function recommendVoice(p: DeviceProbe): VoiceAdvice {
  if (p.memoryGB !== undefined && p.memoryGB < 4) {
    return { pick: 'fast', naturalRtf: null, reason: `This device reports ${p.memoryGB} GB of memory, which is tight for the natural voice.` };
  }
  if (p.benchScore === undefined) {
    const strong = p.webgpu || (p.cores ?? 0) >= 8;
    return {
      pick: strong ? 'natural' : 'fast',
      naturalRtf: null,
      reason: strong ? 'The speed test could not run, but this device looks fast enough.' : 'The speed test could not run, so the safer choice is suggested.',
    };
  }
  const rtf = estimateNaturalRtf(p.benchScore, threadCount(p.cores, p.crossOriginIsolated));
  const bar = p.webgpu ? OFFER_RTF : NATURAL_RTF;
  const natural = rtf >= bar;
  const speed = `${rtf < 1 ? rtf.toFixed(2) : rtf.toFixed(1)}x`;
  return {
    pick: natural ? 'natural' : 'fast',
    naturalRtf: +rtf.toFixed(2),
    reason: natural
      ? `A quick speed test suggests this computer can run the natural voice without pauses (about ${speed} real time on the processor${p.webgpu ? ', faster on the graphics chip' : ''}).`
      : `A quick speed test suggests the natural voice would pause often on this computer (about ${speed} real time on the processor). The fast voice reads without pauses.`,
  };
}

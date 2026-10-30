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

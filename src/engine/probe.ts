// A quick look at this device before the first download: how many cores and how much memory the
// browser reports, whether WebGPU has an adapter, and a short WebAssembly benchmark. The voice
// recommendation built from it is in core/device.ts (recommendVoice).

import type { DeviceProbe } from '../core/device';

const SIMD = 0xfd;
const f32 = (x: number) => [...new Uint8Array(new Float32Array([x]).buffer)];
const leb = (n: number) => {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];

/**
 * A WebAssembly module with one function, run(n): n rounds of four independent SIMD multiply-adds
 * (c = c * 0.999 + 0.001, which stays near 1, so no denormals). It needs WebAssembly SIMD, as
 * ONNX Runtime Web does.
 */
function benchModule(): Uint8Array<ArrayBuffer> {
  // Locals: 0 = n (param), 1 = x, 2 = y, 3..6 = accumulators (v128), 7 = counter (i32).
  const body = [
    0x02, 0x06, 0x7b, 0x01, 0x7f,
    0x43, ...f32(0.999), SIMD, 0x13, 0x21, 1,
    0x43, ...f32(0.001), SIMD, 0x13, 0x21, 2,
    0x03, 0x40,
    ...[3, 4, 5, 6].flatMap((c) => [0x20, c, 0x20, 1, SIMD, 0xe6, 0x01, 0x20, 2, SIMD, 0xe4, 0x01, 0x21, c]),
    0x20, 7, 0x41, 1, 0x6a, 0x22, 7, 0x20, 0, 0x49, 0x0d, 0,
    0x0b,
    0x20, 3, 0x20, 4, SIMD, 0xe4, 0x01, 0x20, 5, SIMD, 0xe4, 0x01, 0x20, 6, SIMD, 0xe4, 0x01, SIMD, 0x1f, 0,
    0x0b,
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x01, 0x60, 0x01, 0x7f, 0x01, 0x7d]),
    ...section(3, [0x01, 0x00]),
    ...section(7, [0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00]),
    ...section(10, [0x01, ...leb(body.length), ...body]),
  ]);
}

export interface BenchResult {
  /** Millions of loop rounds per second, single thread. */
  score: number;
  /** Wall time of the whole benchmark, including compilation and warm-up. */
  ms: number;
}

/**
 * Runs the benchmark for about `measureMs` after a warm-up. The engine first runs new WebAssembly
 * with its baseline compiler and swaps in optimized code when a background thread has compiled
 * it; while the page is still loading that can take a while, and the baseline code is about three
 * times slower. So the warm-up lasts until the speed stops improving (no gain over 10% in 30 ms),
 * at most `maxWarmupMs`. Returns null without WebAssembly SIMD. The score is rounds per
 * millisecond over the whole measuring window, not the best slice: on a device slowed by other
 * work, the slow slices count.
 */
export function runBench(measureMs = 120, maxWarmupMs = 150): BenchResult | null {
  const t0 = performance.now();
  const bytes = benchModule();
  if (typeof WebAssembly === 'undefined' || !WebAssembly.validate(bytes)) return null;
  const run = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.run as (n: number) => number;
  let n = 20_000;
  let sink = 0;
  // Size one call to about 5 ms and wait for the optimized code.
  let best = 0;
  let bestAt = performance.now();
  for (let w = performance.now(); performance.now() - w < maxWarmupMs; ) {
    const s = performance.now();
    sink += run(n);
    const d = performance.now() - s;
    const rate = n / Math.max(d, 0.01);
    if (rate > best * 1.1) {
      best = rate;
      bestAt = performance.now();
    } else if (d >= 2 && performance.now() - bestAt > 30) break;
    if (d < 2) n *= 2;
    else if (d > 10) n = Math.max(1000, Math.floor(n / 2));
  }
  let rounds = 0;
  const m0 = performance.now();
  let elapsed = 0;
  while (elapsed < measureMs) {
    sink += run(n);
    rounds += n;
    elapsed = performance.now() - m0;
  }
  if (!Number.isFinite(sink)) return null;
  return { score: +(rounds / elapsed / 1000).toFixed(1), ms: Math.round(performance.now() - t0) };
}

/**
 * Everything recommendVoice needs; the benchmark only runs when `bench` is true. `threads` is the
 * number of WASM threads the voice would run with here.
 */
export function probeDevice(webgpu: boolean, bench: boolean, threads?: number): DeviceProbe {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const r = bench ? runBench() : null;
  return {
    cores: nav.hardwareConcurrency || undefined,
    memoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    webgpu,
    crossOriginIsolated: !!self.crossOriginIsolated,
    threads,
    benchScore: r?.score,
    benchMs: r?.ms,
  };
}

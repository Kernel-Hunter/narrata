import { describe, expect, it } from 'vitest';
import { MERGE_CHARS } from '../src/core/chunker';
import { NATURAL_RTF, OFFER_AFTER_SEC, OFFER_RTF, REF_RTF, REF_SCORE, SCORE_EXP, chunkPlan, cpuVariant, estimateNaturalRtf, probeThreads, recommendVoice, shouldOfferFastVoice, threadCount, type DeviceProbe } from '../src/core/device';

describe('cpuVariant', () => {
  it('picks uint8 for new installs', () => {
    expect(cpuVariant(false, false)).toBe('uint8');
    expect(cpuVariant(false, true)).toBe('uint8');
    expect(cpuVariant(true, true)).toBe('uint8');
  });

  it('keeps an already stored q8 model instead of downloading again', () => {
    expect(cpuVariant(true, false)).toBe('q8');
  });
});

describe('threadCount', () => {
  it('uses one thread without cross-origin isolation', () => {
    expect(threadCount(8, false)).toBe(1);
  });

  it('leaves one core free and stops at four', () => {
    expect(threadCount(2, true)).toBe(2);
    expect(threadCount(3, true)).toBe(2);
    expect(threadCount(4, true)).toBe(3);
    expect(threadCount(8, true)).toBe(4);
    expect(threadCount(1, true)).toBe(1);
  });

  it('assumes four cores when the browser does not say', () => {
    expect(threadCount(undefined, true)).toBe(3);
  });
});

describe('chunkPlan', () => {
  it('uses plain sentences when generation is well ahead', () => {
    expect(chunkPlan(5, 1)).toEqual({});
    expect(chunkPlan(4, 2)).toEqual({});
  });

  it('ramps up with short chunks when generation is a little faster than playback', () => {
    expect(chunkPlan(1.5, 1)).toEqual({ ramp: true });
    expect(chunkPlan(2.5, 1.5)).toEqual({ ramp: true });
  });

  it('joins sentences when playback has to wait anyway', () => {
    expect(chunkPlan(1.2, 1)).toEqual({ merge: MERGE_CHARS });
    expect(chunkPlan(0.5, 1)).toEqual({ merge: MERGE_CHARS });
    expect(chunkPlan(2.5, 2)).toEqual({ merge: MERGE_CHARS });
  });
});

describe('shouldOfferFastVoice', () => {
  const slow = { offered: false, piper: false, device: 'wasm' as const, rtf: 0.8, seconds: 20, rate: 1 };

  it('offers once the natural voice is measured slower than playback', () => {
    expect(shouldOfferFastVoice(slow)).toBe(true);
  });

  it('waits for enough measured audio', () => {
    expect(shouldOfferFastVoice({ ...slow, seconds: OFFER_AFTER_SEC - 1 })).toBe(false);
  });

  it('does not offer on a device that keeps up', () => {
    expect(shouldOfferFastVoice({ ...slow, rtf: 1.3 })).toBe(false);
  });

  it('accounts for the reading speed', () => {
    expect(shouldOfferFastVoice({ ...slow, rtf: 1.3, rate: 1.5 })).toBe(true);
    // Below 1x the bar stays at 1x: generation is still measured at 1x.
    expect(shouldOfferFastVoice({ ...slow, rtf: 1.05, rate: 0.8 })).toBe(true);
  });

  it('offers only once, only for the natural voice and only on the CPU', () => {
    expect(shouldOfferFastVoice({ ...slow, offered: true })).toBe(false);
    expect(shouldOfferFastVoice({ ...slow, piper: true })).toBe(false);
    expect(shouldOfferFastVoice({ ...slow, device: 'webgpu' })).toBe(false);
    expect(shouldOfferFastVoice({ ...slow, device: undefined })).toBe(false);
  });
});

describe('estimateNaturalRtf', () => {
  it('gives the reference speed for the reference score with four threads', () => {
    expect(estimateNaturalRtf(REF_SCORE, 4)).toBeCloseTo(REF_RTF, 5);
  });

  it('drops a little faster than the score', () => {
    const half = estimateNaturalRtf(REF_SCORE / 2, 4);
    expect(half).toBeCloseTo(REF_RTF * 0.5 ** SCORE_EXP, 5);
    expect(half).toBeLessThan(REF_RTF / 2);
  });

  it('stays within about 25% of the speeds measured at the emulated levels', () => {
    // scripts/bench/device-check.mjs: benchmark score and measured natural voice speed, 4 threads.
    for (const [score, measured] of [[755, 2.515], [356, 1.242], [309, 0.696], [156, 0.341]]) {
      const est = estimateNaturalRtf(score, 4);
      expect(Math.abs(est - measured) / measured).toBeLessThan(0.25);
    }
  });

  it('is slower with fewer threads, and never uses more than four', () => {
    const one = estimateNaturalRtf(REF_SCORE, 1);
    const two = estimateNaturalRtf(REF_SCORE, 2);
    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(REF_RTF);
    expect(estimateNaturalRtf(REF_SCORE, 12)).toBeCloseTo(REF_RTF, 5);
  });
});

describe('recommendVoice', () => {
  /** A probe whose benchmark gives the natural voice `rtf` with four threads. */
  const at = (rtf: number, extra: Partial<DeviceProbe> = {}): DeviceProbe => ({
    cores: 8,
    memoryGB: 8,
    webgpu: false,
    crossOriginIsolated: true,
    benchScore: REF_SCORE * (rtf / REF_RTF) ** (1 / SCORE_EXP),
    ...extra,
  });

  it('suggests the natural voice on the reference computer', () => {
    const a = recommendVoice(at(REF_RTF));
    expect(a.pick).toBe('natural');
    expect(a.naturalRtf).toBeCloseTo(REF_RTF, 1);
  });

  it('suggests the fast voice at the emulated slower levels, whose measured speed was 1.24x or less', () => {
    for (const score of [356, 309, 156]) expect(recommendVoice(at(1, { benchScore: score })).pick).toBe('fast');
    expect(recommendVoice(at(1, { benchScore: 755 })).pick).toBe('natural');
  });

  it('keeps a margin without WebGPU and uses the reading bar with it', () => {
    expect(recommendVoice(at(NATURAL_RTF + 0.05)).pick).toBe('natural');
    expect(recommendVoice(at(NATURAL_RTF - 0.05)).pick).toBe('fast');
    expect(recommendVoice(at(NATURAL_RTF - 0.05, { webgpu: true })).pick).toBe('natural');
    expect(recommendVoice(at(OFFER_RTF - 0.05, { webgpu: true })).pick).toBe('fast');
  });

  it('accounts for the threads the device would get', () => {
    // Fast enough with four threads, not with one (no cross-origin isolation) or two cores.
    expect(recommendVoice(at(1.6)).pick).toBe('natural');
    expect(recommendVoice(at(1.6, { crossOriginIsolated: false })).pick).toBe('fast');
    expect(recommendVoice(at(1.6, { cores: 2 })).pick).toBe('fast');
  });

  it('estimates with the threads the worker will really use', () => {
    // The worker's own thread count wins over the core count (for example ?threads=2).
    expect(probeThreads(at(1, { threads: 2 }))).toBe(2);
    expect(probeThreads(at(1))).toBe(4);
    expect(probeThreads(at(1, { cores: 4 }))).toBe(3);
    const two = recommendVoice(at(REF_RTF, { threads: 2 }));
    expect(two.naturalRtf).toBeCloseTo(estimateNaturalRtf(REF_SCORE, 2), 1);
    expect(recommendVoice(at(1.6, { threads: 2 })).pick).toBe('fast');
  });

  it('uses one thread without cross-origin isolation, whatever the worker or the cores say', () => {
    const p = at(REF_RTF, { crossOriginIsolated: false, threads: 4, cores: 10 });
    expect(probeThreads(p)).toBe(1);
    const a = recommendVoice(p);
    expect(a.naturalRtf).toBeCloseTo(estimateNaturalRtf(REF_SCORE, 1), 1);
    // About 0.88x on the reference computer: too slow on one core, so the fast voice.
    expect(a.pick).toBe('fast');
  });

  it('says when the estimate is for one core because the browser cannot isolate the page', () => {
    expect(recommendVoice(at(REF_RTF, { crossOriginIsolated: false })).reason).toMatch(/one processor core/);
    expect(recommendVoice(at(8, { crossOriginIsolated: false })).reason).toMatch(/without pauses.*one processor core/);
    expect(recommendVoice(at(REF_RTF)).reason).not.toMatch(/one processor core/);
    // One thread chosen on an isolated page (a single-core device) is not the browser's doing.
    expect(recommendVoice(at(REF_RTF, { threads: 1 })).reason).not.toMatch(/one processor core/);
  });

  it('suggests the fast voice with little memory, whatever the speed', () => {
    const a = recommendVoice(at(5, { memoryGB: 2, webgpu: true }));
    expect(a.pick).toBe('fast');
    expect(a.reason).toContain('2 GB');
  });

  it('falls back on the core count when the benchmark could not run', () => {
    expect(recommendVoice(at(1, { benchScore: undefined, cores: 8 })).pick).toBe('natural');
    expect(recommendVoice(at(1, { benchScore: undefined, cores: 4 })).pick).toBe('fast');
    expect(recommendVoice(at(1, { benchScore: undefined, cores: 4, webgpu: true })).pick).toBe('natural');
    expect(recommendVoice(at(1, { benchScore: undefined })).naturalRtf).toBeNull();
  });

  it('explains the pick in one sentence', () => {
    expect(recommendVoice(at(REF_RTF)).reason).toMatch(/without pauses/);
    expect(recommendVoice(at(0.5)).reason).toMatch(/pause often.*0\.50x/);
  });
});

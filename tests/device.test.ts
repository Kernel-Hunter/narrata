import { describe, expect, it } from 'vitest';
import { MERGE_CHARS } from '../src/core/chunker';
import { OFFER_AFTER_SEC, chunkPlan, cpuVariant, shouldOfferFastVoice, threadCount } from '../src/core/device';

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

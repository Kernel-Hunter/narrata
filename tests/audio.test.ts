import { describe, expect, it } from 'vitest';
import { PAUSE_MS, checkAudio, encodeWav, shapeJoint, speechBounds, wavDuration } from '../src/core/audio';
import { AudioCache } from '../src/audio/cache';

const SR = 24000;

function tone(seconds: number, amp = 0.3, lead = 0, tail = 0): Float32Array {
  const n = Math.round((lead + seconds + tail) * SR);
  const a = new Float32Array(n);
  const s0 = Math.round(lead * SR);
  const s1 = s0 + Math.round(seconds * SR);
  for (let i = s0; i < s1; i++) a[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return a;
}

describe('checkAudio (chunk sanity check)', () => {
  it('accepts normal speech-like audio', () => {
    expect(checkAudio(tone(2), SR, 2).ok).toBe(true);
  });

  it('rejects NaN samples (WASM fp16 failure)', () => {
    const a = tone(1);
    a[100] = NaN;
    expect(checkAudio(a, SR)).toMatchObject({ ok: false, reason: 'nan', nan: 1 });
  });

  it('rejects clipping (WebGPU q8 failure, peak 6.8)', () => {
    const a = tone(1);
    a[50] = 6.8;
    expect(checkAudio(a, SR)).toMatchObject({ ok: false, reason: 'clipping' });
  });

  it('rejects audio that goes silent part way (WebGPU fp16 failure after 65,535 samples)', () => {
    const a = new Float32Array(SR * 5);
    a.set(tone(65535 / SR));
    expect(checkAudio(a, SR, 4.8)).toMatchObject({ ok: false, reason: 'silent-tail' });
  });

  it('rejects silence and empty output', () => {
    expect(checkAudio(new Float32Array(SR), SR).reason).toBe('silent');
    expect(checkAudio(new Float32Array(0), SR).reason).toBe('empty');
  });
});

describe('shapeJoint', () => {
  it('trims long leading silence and sets the pause after a sentence', () => {
    const a = tone(1, 0.3, 0.5, 0.05);
    const r = shapeJoint(a, SR, 'sentence');
    const [first] = speechBounds(r.audio, SR);
    expect(first / SR).toBeLessThan(0.04);
    expect(r.leadTrimmed).toBeGreaterThan(0.45);
    const trailing = r.audio.length / SR - 1 - first / SR;
    expect(trailing * 1000).toBeGreaterThan(PAUSE_MS.sentence - 40);
    expect(trailing * 1000).toBeLessThan(PAUSE_MS.sentence + 40);
  });

  it('keeps a mid-phrase joint short', () => {
    const r = shapeJoint(tone(1, 0.3, 0.2, 0.6), SR, 'none');
    expect(r.audio.length / SR).toBeLessThan(1.15);
  });
});

describe('encodeWav', () => {
  it('round-trips the duration', () => {
    const buf = encodeWav(tone(1.5), SR);
    expect(wavDuration(buf)).toBeCloseTo(1.5, 3);
    expect(new TextDecoder().decode(new Uint8Array(buf, 0, 4))).toBe('RIFF');
  });
});

describe('AudioCache', () => {
  it('evicts least recently used entries past the sample budget', () => {
    const c = new AudioCache(250);
    const e = (n: number) => ({ audio: new Float32Array(n), starts: [], ends: [] });
    c.set('a', e(100));
    c.set('b', e(100));
    c.get('a'); // a is now most recent
    c.set('c', e(100));
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
    expect(c.totalSamples).toBe(200);
  });
});

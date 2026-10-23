import { describe, expect, it } from 'vitest';
import { alignWords, phonemeWords, proportionalTimes, shiftTimings, wordTimings } from '../src/core/align';

// Build tokens like the worker does: pad, phoneme characters, pad. Each phoneme char lasts `unit`
// frames; spaces 1 frame.
function synth(phonemeText: string, unit = 4, pads: [number, number] = [6, 10]) {
  const phonemes = [...phonemeText];
  const durations = [pads[0], ...phonemes.map((c) => (c === ' ' ? 1 : unit)), pads[1]];
  const samples = durations.reduce((a, b) => a + b, 0) * 600;
  return { phonemes, durations, samples, sampleRate: 24000 };
}

describe('phonemeWords', () => {
  it('groups characters into words with start and duration in frames', () => {
    const s = synth('ab cd.');
    const pw = phonemeWords(s.phonemes, s.durations);
    expect(pw.map((p) => p.ph)).toEqual(['ab', 'cd.']);
    expect(pw[0].start).toBe(6);
    expect(pw[1].start).toBe(6 + 4 + 4 + 1);
  });
});

describe('alignWords', () => {
  it('maps one to one when counts match', () => {
    expect(alignWords(['the', 'keeper'], ['ðə', 'kˈiːpɚ'])).toEqual([[0, 0, 0], [1, 1, 0]]);
  });

  it('handles words merged by the phonemizer', () => {
    // "on the" becomes one phoneme word.
    const map = alignWords(['sat', 'on', 'the', 'stairs'], ['sˈæt', 'ɔnðə', 'stˈɛɹz']);
    expect(map).toEqual([[0, 0, 0], [1, 1, 0], [2, 1, 1], [3, 2, 0]]);
  });

  it('handles numbers expanded into several words', () => {
    const map = alignWords(['In', '1987,', 'the', 'lamp'], ['ɪn', 'nˈaɪntiːn', 'ˈeɪɾi', 'sˈɛvən', 'ðə', 'lˈæmp']);
    expect(map).toEqual([[0, 0, 0], [1, 1, 0], [2, 4, 0], [3, 5, 0]]);
  });
});

describe('wordTimings', () => {
  it('uses durations at 25 ms per frame (600 samples at 24 kHz)', () => {
    const s = synth('ðə kˈiːpɚ klˈaɪmd');
    const t = wordTimings({ ...s, words: ['The', 'keeper', 'climbed'] });
    expect(t.method).toBe('durations');
    expect(t.starts[0]).toBeCloseTo((6 * 600) / 24000, 6);
    // second word starts after "ðə" (2 chars * 4 frames) and a space (1 frame)
    expect(t.starts[1]).toBeCloseTo(((6 + 8 + 1) * 600) / 24000, 6);
    expect(t.ends[0]).toBeCloseTo(t.starts[1], 6);
    // speech ends before the trailing pad
    expect(t.speechEnd).toBeCloseTo((s.samples - 10 * 600) / 24000, 6);
  });

  it('falls back to proportional timing when durations are missing', () => {
    const t = wordTimings({ words: ['a', 'bb', 'ccc'], phonemes: [], durations: null, samples: 24000, sampleRate: 24000 });
    expect(t.method).toBe('proportional');
    expect(t.starts[0]).toBe(0);
    expect(t.starts[2]).toBeGreaterThan(t.starts[1]);
  });

  it('aligns when word counts differ', () => {
    const s = synth('sˈæt ɔnðə stˈɛɹz');
    const t = wordTimings({ ...s, words: ['sat', 'on', 'the', 'stairs'] });
    expect(t.method).toBe('durations+align');
    expect(t.starts).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(t.starts[i]).toBeGreaterThan(t.starts[i - 1]);
  });

  it('shifts timings after trimming leading silence', () => {
    const t = shiftTimings({ starts: [0.1, 0.5], ends: [0.5, 0.9], speechEnd: 0.9, method: 'durations' }, 0.2);
    expect(t.starts).toEqual([0, 0.3]);
    expect(t.ends[1]).toBeCloseTo(0.7);
  });

  it('proportionalTimes spreads by letters', () => {
    const p = proportionalTimes(['a', 'bbb'], 0, 1);
    expect(p[0]).toBe(0);
    expect(p[1]).toBeCloseTo(2 / 6);
  });
});

import { describe, expect, it } from 'vitest';
import { SpeedModel, canStart, simulate, startDelay, type TimelineChunk } from '../src/core/buffering';

/** A timeline of chunks generated back to back at `rtf` (seconds of audio per second). */
function timeline(durations: number[], rtf: number, overheadSec = 0): TimelineChunk[] {
  let t = 0;
  return durations.map((d) => {
    const compute = d / rtf + overheadSec;
    t += compute;
    return { readyMs: t * 1000, computeMs: compute * 1000, audioSec: d, chars: Math.round(d / 0.065) };
  });
}

describe('canStart', () => {
  it('starts at once when generation is faster than playback', () => {
    expect(canStart({ bufferedSec: 1.5, upcoming: [3, 6, 6, 6], rtf: 3, rate: 1 })).toBe(true);
  });

  it('waits when the next chunk would not be ready in time', () => {
    // 1.5 s of audio, then a 6 s chunk that takes 6 s to generate at real-time speed.
    expect(canStart({ bufferedSec: 1.5, upcoming: [6, 6], rtf: 1, rate: 1 })).toBe(false);
  });

  it('counts the time already spent on the chunk being generated', () => {
    const c = { bufferedSec: 4, upcoming: [6], rtf: 1, rate: 1, margin: 1 };
    expect(canStart(c)).toBe(false);
    expect(canStart({ ...c, inFlightSec: 3 })).toBe(true);
  });

  it('needs more audio at higher speeds', () => {
    const c = { bufferedSec: 10, upcoming: [5, 5, 5, 5], rtf: 1.2, rate: 1 };
    expect(canStart(c)).toBe(true);
    expect(canStart({ ...c, rate: 1.5 })).toBe(false);
  });

  it('only looks as far ahead as the horizon', () => {
    const c = { bufferedSec: 20, upcoming: Array(40).fill(5), rtf: 0.8, rate: 1 };
    expect(canStart({ ...c, horizonSec: 30 })).toBe(true);
    expect(canStart({ ...c, horizonSec: 600 })).toBe(false);
  });

  it('is true when nothing is left to generate', () => {
    expect(canStart({ bufferedSec: 0.5, upcoming: [], rtf: 0.1, rate: 3 })).toBe(true);
  });
});

describe('startDelay', () => {
  it('is zero when playback can start now', () => {
    expect(startDelay({ bufferedSec: 2, upcoming: [3, 3], rtf: 4, rate: 1 })).toBe(0);
  });

  it('estimates the wait until enough audio is buffered', () => {
    const c = { bufferedSec: 0, upcoming: Array(30).fill(4), rtf: 0.8, rate: 1, margin: 1, horizonSec: 60 };
    const wait = startDelay(c);
    expect(wait).toBeGreaterThan(5);
    // After waiting that long (whole chunks generated), playback can start.
    const chunks = Math.round((wait * 0.8) / 4);
    expect(canStart({ ...c, bufferedSec: chunks * 4, upcoming: c.upcoming.slice(chunks) })).toBe(true);
  });
});

describe('SpeedModel', () => {
  it('starts from the initial estimate and moves to the measured speed', () => {
    const m = new SpeedModel(2);
    expect(m.rtf).toBe(2);
    m.observe(100, 5, 10);
    expect(m.rtf).toBeGreaterThan(0.5);
    expect(m.rtf).toBeLessThan(2);
    m.observe(400, 20, 40);
    expect(m.rtf).toBeCloseTo(0.5, 5);
  });

  it('learns seconds per character from enough text', () => {
    const m = new SpeedModel(1, 0.065);
    expect(m.duration(100)).toBeCloseTo(6.5);
    m.observe(300, 24, 10);
    expect(m.duration(100)).toBeCloseTo(8);
  });

  it('ignores empty measurements', () => {
    const m = new SpeedModel(1.5);
    m.observe(10, 0, 1);
    m.observe(10, 1, 0);
    expect(m.rtf).toBe(1.5);
  });
});

describe('simulate', () => {
  const durations = [1.5, 2, 4, 3, 3, 6, 2.5, 8, 2, 4, 7, 3];

  it('plays without pauses when generation is fast', () => {
    const r = simulate(timeline(durations, 3), 1, { kind: 'immediate' }, 3);
    expect(r.stalls).toBe(0);
    expect(r.ttfa).toBeCloseTo(1.5 / 3 + 0.12, 5);
  });

  it('starting at once pauses often when generation is barely real time', () => {
    const r = simulate(timeline(durations, 1.05, 0.4), 1, { kind: 'immediate' }, 1.05);
    expect(r.stalls).toBeGreaterThan(2);
  });

  it('the buffered policy starts later and does not pause when the device keeps up on average', () => {
    const tl = timeline(durations, 1.05, 0.4);
    const now = simulate(tl, 1, { kind: 'immediate' }, 1.05);
    const buffered = simulate(tl, 1, { kind: 'buffered', maxStartWait: 60 }, 1.05);
    expect(buffered.stalls).toBe(0);
    expect(buffered.ttfa).toBeGreaterThan(now.ttfa);
    expect(buffered.ttfa).toBeLessThan(20);
  });

  it('caps the wait, and each pause on a too slow device collects a long stretch', () => {
    const many = Array(40).fill(4);
    const tl = timeline(many, 0.6);
    const now = simulate(tl, 1, { kind: 'immediate' }, 0.6);
    const buffered = simulate(tl, 1, { kind: 'buffered' }, 0.6);
    expect(buffered.ttfa).toBeLessThanOrEqual(10 + 0.12 + 1e-9);
    expect(buffered.stalls).toBeLessThan(now.stalls / 3);
    // Total listening time does not get worse: the audio cannot arrive any earlier.
    expect(buffered.totalSec).toBeGreaterThanOrEqual(now.totalSec - 1e-6);
  });

  it('handles an empty timeline', () => {
    expect(simulate([], 1, { kind: 'buffered' })).toEqual({ ttfa: 0, stalls: 0, stallSec: 0, totalSec: 0 });
  });
});

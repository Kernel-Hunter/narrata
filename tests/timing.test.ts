import { describe, expect, it } from 'vitest';
import { type Placed, Timeline, locate } from '../src/core/timeline';
import { estimateSeconds, formatRate, formatRemaining } from '../src/core/format';

// Two chunks placed back to back on the 1x input timeline.
const placed: Placed[] = [
  { index: 0, inputStart: 0, duration: 2, firstWord: 0, starts: [0.1, 0.6, 1.2], ends: [0.6, 1.2, 1.9] },
  { index: 1, inputStart: 2, duration: 3, firstWord: 3, starts: [0.05, 1.0, 2.0], ends: [1.0, 2.0, 2.8] },
];

function wordAtOutput(tl: Timeline, t: number) {
  return locate(placed, tl.inputAt(t))?.word;
}

describe('Timeline', () => {
  it('maps output time to input time at 1x', () => {
    const tl = new Timeline();
    tl.schedule({ output: 10, input: 0, rate: 1, active: true });
    expect(tl.inputAt(10)).toBe(0);
    expect(tl.inputAt(11.5)).toBeCloseTo(1.5);
    expect(tl.inputAt(9)).toBe(0); // before start
  });

  it.each([0.5, 1, 1.5, 2, 3])('keeps word timing exact at %sx', (rate) => {
    const tl = new Timeline();
    tl.schedule({ output: 5, input: 0, rate, active: true });
    // Every word should be highlighted exactly when its 1x start time is reached.
    const all = placed.flatMap((p) => p.starts.map((s, k) => ({ input: p.inputStart + s, word: p.firstWord + k })));
    for (const w of all) {
      const t = 5 + w.input / rate;
      expect(wordAtOutput(tl, t + 1e-6)).toBe(w.word);
      expect(tl.outputWhenInputReaches(w.input, 5)).toBeCloseTo(t, 9);
    }
  });

  it('changes speed mid-stream without a jump', () => {
    const tl = new Timeline();
    tl.schedule({ output: 0, input: 0, rate: 1, active: true });
    tl.schedule({ output: 1, rate: 2 }); // input 1.0 at t=1, then twice as fast
    expect(tl.inputAt(1)).toBeCloseTo(1);
    expect(tl.inputAt(1.5)).toBeCloseTo(2);
    expect(wordAtOutput(tl, 1.5 + 0.03)).toBe(3); // second chunk, first word (starts at 2.05)
  });

  it('holds position while paused and resumes from the same place', () => {
    const tl = new Timeline();
    tl.schedule({ output: 0, input: 0, rate: 1.5, active: true });
    const pausedAt = tl.inputAt(1);
    tl.schedule({ output: 1, active: false, input: pausedAt });
    expect(tl.inputAt(1)).toBeCloseTo(1.5);
    expect(tl.inputAt(30)).toBeCloseTo(1.5);
    tl.schedule({ output: 30, active: true, input: pausedAt });
    expect(tl.inputAt(31)).toBeCloseTo(3);
  });

  it('removes later changes when a change is scheduled earlier', () => {
    const tl = new Timeline();
    tl.schedule({ output: 0, input: 0, rate: 1, active: true });
    tl.schedule({ output: 5, input: 5, active: false }); // stop at end of buffered audio
    tl.schedule({ output: 3, input: 3, rate: 1, active: true }); // more audio arrived: continue
    tl.schedule({ output: 8, input: 8, active: false }); // new end
    expect(tl.inputAt(6)).toBeCloseTo(6);
    expect(tl.inputAt(10)).toBeCloseTo(8);
  });

  it('drops pending future changes like the stretch node does', () => {
    const tl = new Timeline();
    tl.schedule({ output: 0, input: 0, rate: 1, active: true });
    tl.schedule({ output: 9, input: 9, active: false }, 4); // stop pending at t=9, scheduled at t=4
    expect(tl.hasChangeAfter(5)).toBe(true);
    tl.schedule({ output: 5.2, rate: 2 }, 5); // speed change at t=5.2 replaces the pending stop
    expect(tl.hasChangeAfter(6)).toBe(false);
    expect(tl.inputAt(6.2)).toBeCloseTo(7.2);
  });

  it('reports when the end of buffered audio will be heard', () => {
    const tl = new Timeline();
    tl.schedule({ output: 2, input: 0, rate: 2, active: true });
    expect(tl.outputWhenInputReaches(5, 2)).toBeCloseTo(4.5);
    tl.schedule({ output: 3, active: false });
    expect(tl.outputWhenInputReaches(5, 3)).toBeNull();
  });

  it('seeks by restarting the timeline at input 0', () => {
    const tl = new Timeline();
    tl.schedule({ output: 0, input: 0, rate: 1, active: true });
    tl.reset(2);
    tl.schedule({ output: 100, input: 0, rate: 2, active: true });
    expect(tl.inputAt(101)).toBeCloseTo(2);
  });
});

describe('locate', () => {
  it('finds chunk and word, holding the first word during the lead-in', () => {
    expect(locate(placed, 0)).toEqual({ chunk: 0, word: 0 });
    expect(locate(placed, 0.7)).toEqual({ chunk: 0, word: 1 });
    expect(locate(placed, 2.01)).toEqual({ chunk: 1, word: 3 });
    expect(locate(placed, 4.5)).toEqual({ chunk: 1, word: 5 });
    expect(locate([], 1)).toBeNull();
  });
});

describe('format', () => {
  it('formats speed and remaining time', () => {
    expect(formatRate(1)).toBe('1.0×');
    expect(formatRate(1.25)).toBe('1.25×');
    expect(formatRemaining(30)).toBe('30 sec left');
    expect(formatRemaining(600)).toBe('10 min left');
    expect(formatRemaining(3900)).toBe('1 hr 5 min left');
    expect(estimateSeconds(165, 2)).toBeCloseTo(30);
  });
});

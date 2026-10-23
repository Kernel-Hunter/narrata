// Mirror of the time-stretch node's schedule, so the app always knows which input sample (1x
// audio) is heard at a given AudioContext time. The semantics match Signalsmith Stretch's
// `schedule()`: a change at output time T removes every later change, and when `input` is not
// given it continues from where the previous segment would be at T.

export interface Segment {
  /** AudioContext time at which this segment starts being heard. */
  output: number;
  /** Input position (seconds of 1x audio) at `output`. */
  input: number;
  rate: number;
  active: boolean;
}

export type Change = { output: number } & Partial<Omit<Segment, 'output'>>;

export class Timeline {
  segments: Segment[] = [{ output: 0, input: 0, rate: 1, active: false }];

  reset(rate = 1): void {
    this.segments = [{ output: 0, input: 0, rate, active: false }];
  }

  private segmentAt(t: number): Segment {
    const s = this.segments;
    for (let i = s.length - 1; i >= 0; i--) if (s[i].output <= t) return s[i];
    return s[0];
  }

  /** Input position heard at output time t. */
  inputAt(t: number): number {
    const seg = this.segmentAt(t);
    const rate = seg.active ? seg.rate : 0;
    return seg.input + Math.max(0, t - seg.output) * rate;
  }

  /**
   * Add a change at output time `change.output`. Every change at or after `popFrom` (default:
   * the change time) is removed first. Signalsmith Stretch removes all changes at or after its
   * current time, so the player passes the AudioContext time as `popFrom`. Missing fields
   * continue from the segment in effect at the change time.
   */
  schedule(change: Change, popFrom = change.output): Segment {
    const prev = this.segmentAt(change.output);
    const input = change.input ?? this.inputAt(change.output);
    const seg: Segment = {
      output: change.output,
      input,
      rate: change.rate ?? prev.rate,
      active: change.active ?? prev.active,
    };
    const from = Math.min(popFrom, change.output);
    while (this.segments.length && this.segments[this.segments.length - 1].output >= from) this.segments.pop();
    this.segments.push(seg);
    return seg;
  }

  /** Drop segments that ended before t (keeps the one active at t). */
  prune(t: number): void {
    while (this.segments.length > 1 && this.segments[1].output <= t) this.segments.shift();
  }

  /**
   * Output time at which the input position reaches `input`, assuming no further changes.
   * Returns null when playback is paused at that point or the input is already behind.
   */
  outputWhenInputReaches(input: number, now: number): number | null {
    const seg = this.segments[this.segments.length - 1];
    const from = Math.max(now, seg.output);
    const at = this.inputAt(from);
    if (!seg.active || seg.rate <= 0) return null;
    if (input < at) return null;
    return from + (input - at) / seg.rate;
  }

  /** True when a change is scheduled after time t. */
  hasChangeAfter(t: number): boolean {
    return this.segments[this.segments.length - 1].output > t;
  }

  get current(): Segment {
    return this.segments[this.segments.length - 1];
  }
}

/** A generated chunk placed on the input timeline. */
export interface Placed {
  /** Index into the playback plan. */
  index: number;
  /** Input time where the chunk audio starts. */
  inputStart: number;
  duration: number;
  /** Global word indices for this chunk's words. */
  firstWord: number;
  starts: number[];
  ends: number[];
}

/** Find the chunk and word heard at input time t. */
export function locate(placed: readonly Placed[], t: number): { chunk: number; word: number } | null {
  if (!placed.length) return null;
  let lo = 0;
  let hi = placed.length - 1;
  let ci = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (placed[mid].inputStart <= t) {
      ci = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const p = placed[ci];
  const local = t - p.inputStart;
  if (!p.starts.length) return { chunk: ci, word: -1 };
  let wi = -1;
  lo = 0;
  hi = p.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p.starts[mid] <= local) {
      wi = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Before the first word of a chunk, keep showing the first word (the pause before it is short).
  if (wi < 0) wi = 0;
  return { chunk: ci, word: p.firstWord + wi };
}

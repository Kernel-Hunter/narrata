// When to start (and resume) playback while the voice is still being generated.
//
// On a fast device the first chunk plays as soon as it is ready. When generation is only a little
// faster than playback, or slower, starting at once means pausing again a few seconds later, and
// again after that. Instead the player waits until the audio it has, plus what the device will
// generate while it plays, covers the next minute or so of reading. Playback then starts a little
// later but runs without pauses. If the device cannot keep up at all, the wait is capped, and each
// unavoidable pause collects a long stretch of audio rather than stuttering.

/** Running estimate of generation speed, from the chunks generated so far. */
export class SpeedModel {
  private audioSec = 0;
  private computeSec = 0;
  private chars = 0;
  private initialRtf: number;
  private initialSecPerChar: number;

  /**
   * @param rtf initial estimate (seconds of audio per second of compute), e.g. from the start-up test
   * @param secPerChar seconds of 1x speech per character of text
   */
  constructor(rtf = 1, secPerChar = 0.065) {
    this.initialRtf = rtf;
    this.initialSecPerChar = secPerChar;
  }

  observe(chars: number, audioSec: number, computeSec: number): void {
    if (!(computeSec > 0) || !(audioSec > 0)) return;
    this.audioSec += audioSec;
    this.computeSec += computeSec;
    this.chars += chars;
  }

  /** Seconds of audio generated per second (generation speed relative to real time). */
  get rtf(): number {
    // Blend the initial estimate in until about 20 s of audio have been measured.
    const w = Math.min(1, this.audioSec / 20);
    const measured = this.computeSec > 0 ? this.audioSec / this.computeSec : this.initialRtf;
    return w * measured + (1 - w) * this.initialRtf;
  }

  /** Speed measured so far and how many seconds of audio it is based on. */
  get measured(): { rtf: number; seconds: number } {
    return { rtf: this.computeSec > 0 ? this.audioSec / this.computeSec : 0, seconds: this.audioSec };
  }

  get secPerChar(): number {
    return this.chars > 200 ? this.audioSec / this.chars : this.initialSecPerChar;
  }

  /** Estimated 1x duration of a chunk of `chars` characters. */
  duration(chars: number): number {
    return chars * this.secPerChar;
  }

  setInitialRtf(rtf: number): void {
    if (rtf > 0) this.initialRtf = rtf;
  }
}

export interface StartCheck {
  /** Seconds of 1x audio ready and not yet played. */
  bufferedSec: number;
  /** Estimated 1x durations of the chunks still to generate, in generation order. */
  upcoming: number[];
  /** Seconds already spent on the chunk being generated now (upcoming[0]). */
  inFlightSec?: number;
  /** Generation speed: seconds of audio per second. */
  rtf: number;
  /** Playback speed. */
  rate: number;
  /** How far ahead (seconds of 1x audio) playback must be covered. */
  horizonSec?: number;
  /** Safety factor on the generation time estimates. */
  margin?: number;
}

export const HORIZON_SEC = 60;
export const MARGIN = 1.15;

/**
 * Whether playback can start now and run through the horizon without waiting for audio, assuming
 * the remaining chunks are generated one after another at the estimated speed.
 */
export function canStart(c: StartCheck): boolean {
  const horizon = c.horizonSec ?? HORIZON_SEC;
  const margin = c.margin ?? MARGIN;
  let covered = c.bufferedSec;
  // Wall-clock time at which playback reaches the end of what is covered so far.
  let playEnd = c.bufferedSec / c.rate;
  let genEnd = -(c.inFlightSec ?? 0);
  for (const d of c.upcoming) {
    if (covered >= horizon) return true;
    genEnd += (d / c.rtf) * margin;
    if (genEnd > playEnd) return false;
    playEnd += d / c.rate;
    covered += d;
  }
  return true;
}

/**
 * Estimated seconds until canStart() becomes true, assuming the upcoming chunks arrive at the
 * estimated speed (0 if it is true now). Used for the "starts in about N s" hint.
 */
export function startDelay(c: StartCheck): number {
  const margin = c.margin ?? MARGIN;
  let buffered = c.bufferedSec;
  let wait = 0;
  let inFlight = c.inFlightSec ?? 0;
  for (let k = 0; k <= c.upcoming.length; k++) {
    if (canStart({ ...c, bufferedSec: buffered, upcoming: c.upcoming.slice(k), inFlightSec: inFlight })) return wait;
    if (k === c.upcoming.length) break;
    const d = c.upcoming[k];
    wait += Math.max(0, (d / c.rtf) * margin - inFlight);
    inFlight = 0;
    buffered += d;
  }
  return wait;
}

/** Longest wait before playback starts anyway, and before it resumes after running out. */
export const MAX_START_WAIT = 10;
export const MAX_RESUME_WAIT = 15;

/** Policy used by the simulation: 'immediate' is the old behaviour (start on the first chunk). */
export type Policy = { kind: 'immediate' } | { kind: 'buffered'; horizonSec?: number; margin?: number; maxStartWait?: number; maxResumeWait?: number };

export interface TimelineChunk {
  /** When the chunk was ready, in ms from the moment play was pressed. */
  readyMs: number;
  computeMs: number;
  audioSec: number;
  chars: number;
}

export interface SimResult {
  /** Seconds from pressing play to hearing audio. */
  ttfa: number;
  /** Number of pauses after playback started, and their total length in seconds. */
  stalls: number;
  stallSec: number;
  /** Wall-clock seconds from pressing play to the end. */
  totalSec: number;
}

/** Extra delay before audio is heard: the stretch node's latency plus scheduling. */
export const OUTPUT_LEAD = 0.12;

/**
 * Simulate playback of a generation timeline at `rate` with a start/resume policy. Chunks are
 * assumed to be generated in order, back to back (true whenever generation is the bottleneck).
 */
export function simulate(chunks: TimelineChunk[], rate: number, policy: Policy, initialRtf = 1): SimResult {
  const n = chunks.length;
  if (!n) return { ttfa: 0, stalls: 0, stallSec: 0, totalSec: 0 };
  const ready = chunks.map((c) => c.readyMs / 1000);
  const speed = new SpeedModel(initialRtf);
  let observed = 0;
  const observeUntil = (t: number) => {
    while (observed < n && ready[observed] <= t + 1e-9) {
      const c = chunks[observed++];
      speed.observe(c.chars, c.audioSec, c.computeMs / 1000);
    }
  };
  /** Earliest time >= t at which playback may start/resume with chunk `next` up next. */
  const startTime = (t: number, next: number, played: number, maxWait: number): number => {
    let now = Math.max(t, ready[next]);
    if (policy.kind === 'immediate') return now;
    const deadline = Math.max(t + maxWait, ready[next]);
    for (;;) {
      observeUntil(now);
      const done = ready.filter((r) => r <= now + 1e-9).length;
      const bufferedSec = chunks.slice(next, done).reduce((s, c) => s + c.audioSec, 0) - played;
      const upcoming = chunks.slice(done).map((c) => speed.duration(c.chars));
      const inFlightSec = done < n ? now - (done > 0 ? ready[done - 1] : 0) : 0;
      if (canStart({ bufferedSec, upcoming, inFlightSec, rtf: speed.rtf, rate, horizonSec: policy.horizonSec, margin: policy.margin })) return now;
      if (now >= deadline) return now;
      // Re-check when the next chunk arrives (or at the deadline).
      now = Math.min(deadline, done < n ? ready[done] : deadline);
    }
  };
  const maxStart = policy.kind === 'buffered' ? (policy.maxStartWait ?? MAX_START_WAIT) : 0;
  const maxResume = policy.kind === 'buffered' ? (policy.maxResumeWait ?? MAX_RESUME_WAIT) : 0;
  let t = startTime(0, 0, 0, maxStart);
  const ttfa = t + OUTPUT_LEAD;
  let stalls = 0;
  let stallSec = 0;
  for (let i = 0; i < n; i++) {
    if (ready[i] > t + 1e-9) {
      const resume = startTime(t, i, 0, maxResume);
      stalls++;
      stallSec += resume - t;
      t = resume;
    }
    t += chunks[i].audioSec / rate;
  }
  return { ttfa, stalls, stallSec, totalSec: t + OUTPUT_LEAD };
}

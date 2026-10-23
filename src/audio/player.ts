// Playback engine.
//
// Chunks are generated at 1x and appended back to back into one Signalsmith Stretch node (MIT),
// which plays them at the chosen speed with the pitch preserved. Because the chunks sit end to
// end in a single input buffer, there is no scheduling gap between them. A mirror of the node's
// schedule (Timeline) maps the AudioContext clock to the 1x input position, so word timings stay
// exact at any speed and across pause and seek.

import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch';
import { type Chunk, type Sentence, chunksFrom } from '../core/chunker';
import { type DocText, type Word, lastAtOrBefore, wordIndexAt } from '../core/text';
import { type Placed, Timeline, locate } from '../core/timeline';
import type { TtsClient } from '../engine/client';
import { AudioCache, type ChunkAudio } from './cache';

export const SAMPLE_RATE = 24000;
const LOOKAHEAD = 3;
const FADE = 0.03;
const HIGHLIGHT_LEAD = 0.03;

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended';

export interface PlaybackDoc {
  doc: DocText;
  words: Word[];
  sentences: Sentence[];
  chunks: Chunk[];
}

export interface PlayerStats {
  ttfaMs: number | null;
  underruns: number;
  chunksPlayed: number;
  lastComputeMs: number;
  generatedSeconds: number;
  computeSeconds: number;
}

export interface PlayerCallbacks {
  onState(state: PlayerState): void;
  onWord(word: number): void;
  onError(message: string): void;
}

export class Player {
  ctx: AudioContext | null = null;
  private stretch: StretchNode | null = null;
  private fade: GainNode | null = null;
  private volumeNode: GainNode | null = null;
  private lead = 0.12;
  private timeline = new Timeline();
  private placed: Placed[] = [];
  private plan: Chunk[] = [];
  private bufferedEnd = 0;
  private nextAppend = 0;
  private requested = 0;
  private results = new Map<number, ChunkAudio>();
  private epoch = 0;
  private started = false;
  private pausedAt: number | null = null;
  private raf = 0;
  private timer = 0;
  private lastWord = -1;
  private clickAt = 0;
  private cache = new AudioCache(SAMPLE_RATE * 60 * 10);
  private previewSource: AudioBufferSourceNode | null = null;
  state: PlayerState = 'idle';
  rate = 1;
  volume = 1;
  voice = 'af_heart';
  pdoc: PlaybackDoc | null = null;
  stats: PlayerStats = { ttfaMs: null, underruns: 0, chunksPlayed: 0, lastComputeMs: 0, generatedSeconds: 0, computeSeconds: 0 };
  /** Debug hook: called whenever a chunk is placed on the timeline. */
  onPlaced?: (p: Placed, audio: Float32Array) => void;

  constructor(
    private readonly tts: TtsClient,
    private readonly cb: PlayerCallbacks,
  ) {}

  /** Create the audio graph. Must be called from a user gesture the first time. */
  async ensureAudio(): Promise<AudioContext> {
    if (this.ctx && this.stretch) {
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return this.ctx;
    }
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
    this.ctx = ctx;
    // One (unconnected) input: the processor reads inputList[0] even in buffer mode.
    const stretch = await SignalsmithStretch(ctx, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    stretch.onprocessorerror = () => this.cb.onError('The audio processor stopped. Reload the page to continue.');
    const fade = ctx.createGain();
    const vol = ctx.createGain();
    fade.gain.value = 0;
    vol.gain.value = this.volume;
    stretch.connect(fade).connect(vol).connect(ctx.destination);
    this.stretch = stretch;
    this.fade = fade;
    this.volumeNode = vol;
    // Changes must be scheduled after the node's own latency, or part of them is skipped.
    this.lead = (await stretch.latency()) + 0.03;
    if (ctx.state !== 'running') await ctx.resume();
    return ctx;
  }

  get outputNode(): AudioNode | null {
    return this.volumeNode;
  }

  /** Time (AudioContext clock) of the audio reaching the speakers now. */
  private heardTime(): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.contextTime > 0) return ts.contextTime;
    return Math.max(0, ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0));
  }

  load(pdoc: PlaybackDoc): void {
    this.stop();
    this.pdoc = pdoc;
    this.lastWord = -1;
  }

  // ---- schedule helpers ----------------------------------------------------

  /**
   * Apply a change to the node and to the mirror. The node keeps at most one pending future
   * change (each schedule() drops every change after its current time), so the end-of-buffer
   * stop is added from tick() only when nothing else is pending.
   */
  private apply(change: { output: number; input?: number; rate?: number; active?: boolean }) {
    const seg = this.timeline.schedule(change, this.ctx!.currentTime);
    this.stopScheduled = false;
    void this.stretch!.schedule({ output: seg.output, input: seg.input, rate: seg.rate, active: seg.active });
  }

  private stopScheduled = false;

  /** New audio was appended: cancel a pending stop (or resume after an underrun). */
  private reschedule(): void {
    if (!this.started || this.pausedAt !== null || !this.ctx) return;
    const tc = this.ctx.currentTime + this.lead;
    const input = this.timeline.inputAt(tc);
    if (input >= this.bufferedEnd) return;
    this.apply({ output: tc, input, rate: this.rate, active: true });
  }

  /** Stop exactly at the end of the buffered audio so an underrun never skips input. */
  private ensureStop(): void {
    if (!this.started || this.pausedAt !== null || !this.ctx || this.stopScheduled) return;
    const now = this.ctx.currentTime;
    if (this.timeline.hasChangeAfter(now)) return;
    const seg = this.timeline.current;
    if (!seg.active) return;
    const tEnd = this.timeline.outputWhenInputReaches(this.bufferedEnd, now);
    if (tEnd === null || tEnd - now > 1.5) return;
    const seg2 = this.timeline.schedule({ output: Math.max(tEnd, now + this.lead), input: this.bufferedEnd, rate: this.rate, active: false }, now);
    void this.stretch!.schedule({ output: seg2.output, input: seg2.input, rate: seg2.rate, active: false });
    this.stopScheduled = true;
  }

  private fadeTo(value: number, at: number) {
    const g = this.fade!.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    g.linearRampToValueAtTime(value, at + FADE);
  }

  // ---- generation ----------------------------------------------------------

  private playingIndex(): number {
    if (!this.placed.length || !this.ctx) return 0;
    const loc = locate(this.placed, this.timeline.inputAt(this.ctx.currentTime));
    return loc ? this.placed[loc.chunk].index : 0;
  }

  private fill(): void {
    if (!this.pdoc) return;
    const limit = this.playingIndex() + LOOKAHEAD;
    while (this.requested < this.plan.length && this.requested <= limit) this.request(this.requested++);
  }

  private request(index: number): void {
    const c = this.plan[index];
    const text = this.pdoc!.doc.text.slice(c.start, c.end);
    const key = AudioCache.key(this.voice, text, c.endsWith);
    const hit = this.cache.get(key);
    const epoch = this.epoch;
    if (hit) {
      this.results.set(index, hit);
      queueMicrotask(() => this.appendReady());
      return;
    }
    this.tts
      .generate(text, this.voice, c.endsWith, epoch)
      .then((r) => {
        const audio: ChunkAudio = { audio: r.audio, starts: r.starts, ends: r.ends };
        this.cache.set(key, audio);
        this.stats.lastComputeMs = r.computeMs;
        this.stats.generatedSeconds += r.audio.length / SAMPLE_RATE;
        this.stats.computeSeconds += r.computeMs / 1000;
        if (epoch !== this.epoch) return;
        this.results.set(index, audio);
        this.appendReady();
      })
      .catch((e: Error) => {
        if (epoch !== this.epoch) return;
        this.cb.onError(e.message);
        this.pause();
      });
  }

  private appendReady(): void {
    if (!this.stretch || !this.ctx || !this.pdoc) return;
    let appended = false;
    while (this.results.has(this.nextAppend)) {
      const r = this.results.get(this.nextAppend)!;
      this.results.delete(this.nextAppend);
      const c = this.plan[this.nextAppend];
      const words = this.pdoc.words;
      const first = Math.max(0, lastAtOrBefore(words, c.start - 1, (w) => w.start) + 1);
      let count = 0;
      while (first + count < words.length && words[first + count].start < c.end) count++;
      const n = Math.min(count, r.starts.length);
      const p: Placed = { index: this.nextAppend, inputStart: this.bufferedEnd, duration: r.audio.length / SAMPLE_RATE, firstWord: first, starts: r.starts.slice(0, n), ends: r.ends.slice(0, n) };
      this.placed.push(p);
      void this.stretch.addBuffers([r.audio.slice()]);
      this.bufferedEnd += p.duration;
      this.onPlaced?.(p, r.audio);
      this.nextAppend++;
      appended = true;
    }
    if (!appended) return;
    const wasUnderrun = this.started && this.state === 'buffering';
    if (!this.started) {
      if (this.pausedAt !== null) return;
      const t0 = this.ctx.currentTime + this.lead;
      this.timeline.reset(this.rate);
      this.apply({ output: t0, input: 0, rate: this.rate, active: true });
      this.fadeTo(1, t0);
      this.started = true;
      if (this.stats.ttfaMs === null || this.clickAt) {
        this.stats.ttfaMs = Math.round(performance.now() - this.clickAt + this.lead * 1000);
        this.clickAt = 0;
      }
      this.setState('playing');
      this.startTicking();
    } else {
      if (wasUnderrun) this.stats.underruns++;
      if (this.stopScheduled || !this.timeline.current.active) this.reschedule();
    }
    this.fill();
  }

  // ---- public controls -----------------------------------------------------

  /** Start playing from a character offset. */
  async playFrom(offset: number): Promise<void> {
    if (!this.pdoc) return;
    await this.ensureAudio();
    this.clickAt = performance.now();
    this.resetPlayback();
    this.plan = chunksFrom(this.pdoc.doc.text, this.pdoc.chunks, offset, { ramp: this.tts.info.device === 'wasm' });
    if (!this.plan.length) {
      this.setState('ended');
      return;
    }
    this.setState('loading');
    const w = wordIndexAt(this.pdoc.words, offset);
    this.emitWord(w);
    this.fill();
  }

  private resetPlayback(): void {
    this.epoch++;
    this.tts.cancel(this.epoch);
    if (this.ctx && this.stretch && this.fade) {
      const now = this.ctx.currentTime;
      this.fade.gain.cancelScheduledValues(now);
      this.fade.gain.setValueAtTime(0, now);
      void this.stretch.schedule({ output: now, active: false, input: 0, rate: this.rate });
      void this.stretch.dropBuffers();
    }
    this.timeline.reset(this.rate);
    this.placed = [];
    this.results.clear();
    this.bufferedEnd = 0;
    this.nextAppend = 0;
    this.requested = 0;
    this.started = false;
    this.pausedAt = null;
  }

  pause(): void {
    if (!this.ctx || !this.started || this.pausedAt !== null) {
      if (this.state === 'loading') {
        this.resetPlayback();
        this.setState('paused');
      }
      return;
    }
    const now = this.ctx.currentTime;
    const input = Math.min(this.timeline.inputAt(now), this.bufferedEnd);
    this.pausedAt = input;
    this.fadeTo(0, now);
    this.apply({ output: now + this.lead, input, rate: this.rate, active: false });
    this.setState('paused');
  }

  async resume(): Promise<void> {
    if (!this.pdoc) return;
    if (this.state === 'ended' || (!this.started && this.pausedAt === null)) {
      return this.playFrom(this.currentOffset());
    }
    await this.ensureAudio();
    if (this.pausedAt === null) return;
    const input = this.pausedAt;
    this.pausedAt = null;
    const t = this.ctx!.currentTime + this.lead;
    this.apply({ output: t, input, rate: this.rate, active: input < this.bufferedEnd });
    this.fadeTo(1, t);
    this.setState(input >= this.bufferedEnd - 0.01 && this.nextAppend < this.plan.length ? 'buffering' : 'playing');
    this.startTicking();
  }

  toggle(): void {
    if (this.state === 'playing' || this.state === 'buffering' || this.state === 'loading') this.pause();
    else void this.resume();
  }

  stop(): void {
    this.resetPlayback();
    this.stopTicking();
    this.setState('idle');
  }

  setRate(rate: number): void {
    this.rate = rate;
    if (!this.ctx || !this.started) return;
    if (this.pausedAt !== null) {
      // Keep the paused segment; the new rate applies on resume.
      return;
    }
    const tc = this.ctx.currentTime + this.lead;
    const input = this.timeline.inputAt(tc);
    this.apply({ output: tc, input, rate, active: input < this.bufferedEnd });
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.volumeNode && this.ctx) this.volumeNode.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  setVoice(voice: string): void {
    if (voice === this.voice) return;
    this.voice = voice;
    if (this.state === 'playing' || this.state === 'buffering' || this.state === 'loading') void this.playFrom(this.currentOffset());
    else if (this.started) this.resetPlayback();
  }

  /** Offset of the word being read (or last read). */
  currentOffset(): number {
    if (!this.pdoc) return 0;
    const w = this.pdoc.words[Math.max(0, this.lastWord)];
    return w ? w.start : 0;
  }

  currentWord(): number {
    return this.lastWord;
  }

  sentenceIndexAt(offset: number): number {
    if (!this.pdoc) return 0;
    return Math.max(0, lastAtOrBefore(this.pdoc.sentences, offset, (s) => s.start));
  }

  skipSentence(delta: number): void {
    if (!this.pdoc) return;
    const s = this.pdoc.sentences;
    const cur = this.sentenceIndexAt(this.currentOffset());
    let target = cur + delta;
    if (delta < 0) {
      // Like a music player: "back" restarts the sentence unless we are at its very start.
      const w = this.pdoc.words[this.lastWord];
      const firstWord = wordIndexAt(this.pdoc.words, s[cur].start);
      if (w && this.lastWord - firstWord > 2) target = cur;
    }
    target = Math.max(0, Math.min(s.length - 1, target));
    const wasActive = this.state !== 'paused' && this.state !== 'idle' && this.state !== 'ended';
    if (wasActive) void this.playFrom(s[target].start);
    else {
      this.resetPlayback();
      this.emitWord(wordIndexAt(this.pdoc.words, s[target].start));
      this.setState('paused');
    }
  }

  /** Move the reading position without playing (e.g. restoring a saved position). */
  setPosition(offset: number): void {
    if (!this.pdoc) return;
    this.resetPlayback();
    this.emitWord(wordIndexAt(this.pdoc.words, offset));
  }

  // ---- position tracking ---------------------------------------------------

  private startTicking(): void {
    if (!this.raf) {
      const loop = () => {
        this.tick();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    // rAF stops in background tabs; the timer keeps lookahead and media state going.
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), 250);
  }

  private stopTicking(): void {
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    this.raf = 0;
    this.timer = 0;
  }

  private tick(): void {
    if (!this.ctx || !this.started || !this.pdoc) return;
    // Light the word a touch early: model word starts land about 40 ms after the audible onset.
    const input = this.pausedAt ?? this.timeline.inputAt(this.heardTime() + HIGHLIGHT_LEAD);
    const loc = locate(this.placed, input);
    if (loc && loc.word >= 0) this.emitWord(loc.word);
    const atEnd = input >= this.bufferedEnd - 0.005;
    if (this.pausedAt === null) {
      if (atEnd && this.nextAppend >= this.plan.length) {
        this.started = false;
        this.fade!.gain.setValueAtTime(0, this.ctx.currentTime);
        this.setState('ended');
        this.stopTicking();
        return;
      }
      if (atEnd && this.state === 'playing') this.setState('buffering');
      else if (!atEnd && this.state === 'buffering') this.setState('playing');
      this.ensureStop();
    }
    this.fill();
  }

  /** Debug log of word changes: word index, input position and AudioContext time heard. */
  wordLog: { word: number; input: number; heard: number }[] | null = null;

  private emitWord(w: number): void {
    if (w === this.lastWord) return;
    this.lastWord = w;
    if (this.wordLog && this.ctx && this.started) {
      const heard = this.heardTime();
      this.wordLog.push({ word: w, input: this.timeline.inputAt(heard), heard });
    }
    this.cb.onWord(w);
  }

  private setState(s: PlayerState): void {
    if (s === this.state) return;
    this.state = s;
    this.cb.onState(s);
  }

  /** Input time (seconds of 1x audio) heard now and the placed chunks; for tests and debugging. */
  debugSnapshot() {
    return {
      input: this.ctx ? this.timeline.inputAt(this.heardTime()) : 0,
      bufferedEnd: this.bufferedEnd,
      placed: this.placed.map((p) => ({ index: p.index, inputStart: p.inputStart, duration: p.duration })),
      segments: this.timeline.segments.map((s) => ({ ...s })),
      lead: this.lead,
      plan: this.plan.length,
      nextAppend: this.nextAppend,
      cacheEntries: this.cache.size,
    };
  }

  // ---- voice preview -------------------------------------------------------

  async preview(voice: string, text: string, onStart?: () => void): Promise<void> {
    const ctx = await this.ensureAudio();
    if (this.state === 'playing' || this.state === 'buffering') this.pause();
    this.previewSource?.stop();
    const r = await this.tts.generate(text, voice, 'sentence', 0, 'preview');
    const buf = ctx.createBuffer(1, r.audio.length, SAMPLE_RATE);
    buf.copyToChannel(r.audio as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.volumeNode!);
    src.start();
    this.previewSource = src;
    onStart?.();
    await new Promise<void>((resolve) => (src.onended = () => resolve()));
    if (this.previewSource === src) this.previewSource = null;
  }

  stopPreview(): void {
    this.previewSource?.stop();
    this.previewSource = null;
  }
}

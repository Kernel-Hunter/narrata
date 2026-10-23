// Word timings from the model's phoneme durations.
//
// The timestamped Kokoro export returns one duration per input token (in 25 ms frames at 24 kHz,
// i.e. 600 samples per unit). Tokens are phoneme characters wrapped in a pad token on each side.
// The G2P reports which characters of the text each phoneme came from, so every text word gets
// the time of its own phonemes (tokenTimings). Without that mapping, phoneme words are matched
// to text words with a small monotonic DP alignment (wordTimings), since a phonemizer can merge
// words ("on the" -> one phoneme word) or expand them ("1987" -> three words).

import { isSpoken } from './text';

export interface PhonemeWord {
  /** Start, in duration units, from the start of the audio. */
  start: number;
  /** Length in duration units. */
  dur: number;
  ph: string;
}

export interface WordTiming {
  /** Seconds from the start of the chunk audio, one per text word. */
  starts: number[];
  ends: number[];
  /** End of speech (seconds), before the trailing pad. */
  speechEnd: number;
  method: 'durations+tokens' | 'durations' | 'durations+align' | 'proportional';
}

/** Letters in a word or phoneme word, ignoring stress and length marks. */
export function letterCount(w: string): number {
  return w.replace(/[ˈˌː]/g, '').replace(/[^\p{L}\p{N}]/gu, '').length;
}

/**
 * Group phoneme characters into words. `phonemes` are the characters that were actually
 * tokenized (same length as durations minus the two pads).
 */
export function phonemeWords(phonemes: string[], durations: number[]): PhonemeWord[] {
  const out: PhonemeWord[] = [];
  let cum = durations[0] ?? 0;
  let cur = '';
  let cs = 0;
  let cd = 0;
  for (let k = 0; k < phonemes.length; k++) {
    const ch = phonemes[k];
    const dk = durations[k + 1] ?? 0;
    if (ch === ' ') {
      if (cur) out.push({ start: cs, dur: cd, ph: cur });
      cur = '';
    } else {
      if (!cur) {
        cs = cum;
        cd = 0;
      }
      cur += ch;
      cd += dk;
    }
    cum += dk;
  }
  if (cur) out.push({ start: cs, dur: cd, ph: cur });
  return out.filter((p) => isSpoken(p.ph));
}

export type AlignStep = [textIndex: number, phonemeIndex: number, partOfMerge: 0 | 1];

/**
 * Monotonic alignment of text words to phoneme words.
 * Moves: 1:1, 2 text words -> 1 phoneme word (merge), 1 text word -> 2..6 phoneme words
 * (expansion, cheap for numbers). Cost is the log ratio of letter counts.
 */
export function alignWords(textWords: string[], phWords: string[]): AlignStep[] | null {
  const INF = 1e9;
  const n = textWords.length;
  const m = phWords.length;
  if (n === 0) return [];
  if (m === 0) return null;
  const C: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
  const B: Int8Array[] = Array.from({ length: n + 1 }, () => new Int8Array((m + 1) * 2));
  C[0][0] = 0;
  const tl = textWords.map(letterCount);
  const pl = phWords.map(letterCount);
  const isNum = textWords.map((w) => /\d/.test(w));
  const lr = (a: number, b: number) => Math.abs(Math.log((a + 1) / (b + 1)));
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = C[i][j];
      if (c >= INF) continue;
      const step = (di: number, dj: number, cost: number) => {
        const ni = i + di;
        const nj = j + dj;
        if (ni <= n && nj <= m && c + cost < C[ni][nj]) {
          C[ni][nj] = c + cost;
          B[ni][nj * 2] = di;
          B[ni][nj * 2 + 1] = dj;
        }
      };
      if (i < n && j < m) step(1, 1, lr(tl[i], pl[j]));
      if (i + 1 < n && j < m) step(2, 1, 0.6 + lr(tl[i] + tl[i + 1], pl[j]));
      if (i < n) {
        let sum = 0;
        for (let k = 1; k <= 6 && j + k <= m; k++) {
          sum += pl[j + k - 1];
          if (k < 2) continue;
          step(1, k, (isNum[i] ? 0 : 0.8 * (k - 1)) + lr(tl[i] * (isNum[i] ? 4 : 1), sum));
        }
      }
    }
  }
  if (C[n][m] >= INF) return null;
  const map: AlignStep[] = [];
  let i = n;
  let j = m;
  while (i > 0) {
    const di = B[i][j * 2];
    const dj = B[i][j * 2 + 1];
    i -= di;
    j -= dj;
    if (di === 2) map.unshift([i, j, 0], [i + 1, j, 1]);
    else map.unshift([i, j, 0]);
  }
  return map;
}

export interface TimingInput {
  /** Spoken words of the chunk text, in order. */
  words: string[];
  /** Phoneme characters that were tokenized, in order (pads excluded). */
  phonemes: string[];
  /** One duration per token, including both pads. */
  durations: number[] | null;
  samples: number;
  sampleRate: number;
}

/** Proportional fallback: spread words over the speech span by letter count. */
export function proportionalTimes(words: string[], speechStart: number, speechEnd: number): number[] {
  const lens = words.map((w) => letterCount(w) + 1);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return lens.map((l) => {
    const s = speechStart + (acc / total) * (speechEnd - speechStart);
    acc += l;
    return s;
  });
}

export function wordTimings(input: TimingInput): WordTiming {
  const { words, phonemes, samples, sampleRate } = input;
  const total = samples / sampleRate;
  const fallback = (speechStart: number, speechEnd: number): WordTiming => {
    const starts = proportionalTimes(words, speechStart, speechEnd);
    return { starts, ends: endsFrom(starts, speechEnd), speechEnd, method: 'proportional' };
  };
  // The graph rounds each duration and clamps it to at least one frame.
  const d = input.durations?.map((x) => Math.max(1, Math.round(x)));
  if (!d || d.length !== phonemes.length + 2 || words.length === 0) return fallback(0, total);
  const sumUnits = d.reduce((a, b) => a + b, 0);
  if (sumUnits <= 0) return fallback(0, total);
  const secPerUnit = total / sumUnits;
  const speechEnd = (sumUnits - d[d.length - 1]) * secPerUnit;
  const pw = phonemeWords(phonemes, d);
  if (pw.length === 0) return fallback(d[0] * secPerUnit, speechEnd);
  const toSec = (u: number) => u * secPerUnit;
  let starts: number[];
  let method: WordTiming['method'];
  if (pw.length === words.length) {
    starts = pw.map((p) => toSec(p.start));
    method = 'durations';
  } else {
    const map = alignWords(words, pw.map((p) => p.ph));
    if (!map) return fallback(d[0] * secPerUnit, speechEnd);
    starts = new Array(words.length).fill(0);
    for (const [ti, pj, part] of map) {
      const p = pw[pj];
      if (!part) starts[ti] = toSec(p.start);
      else {
        const a = letterCount(words[ti - 1]);
        const b = letterCount(words[ti]);
        starts[ti] = toSec(p.start + (p.dur * a) / (a + b || 1));
      }
    }
    method = 'durations+align';
  }
  return { starts, ends: endsFrom(starts, speechEnd), speechEnd, method };
}

export interface TokenTimingInput {
  /** Spoken words of the chunk text, as offsets into it. */
  words: { start: number; end: number }[];
  /** G2P tokens, as offsets into the chunk text. */
  tokens: { start: number; end: number }[];
  /** Phoneme characters that were tokenized, in order (pads excluded). */
  phonemes: string[];
  /** Index into `tokens` for each phoneme character, -1 for a space between tokens. */
  owner: number[];
  /** One duration per model token, including both pads. */
  durations: number[] | null;
  samples: number;
  sampleRate: number;
}

const SPOKEN_PHONEME = /[^\s;:,.!?¡¿—…"«»“”()]/u;

/**
 * Word timings from the phonemes of each G2P token. A text word starts with the first spoken
 * phoneme of the tokens it overlaps; a token shared by several words ("and/or") is split between
 * them by letter count. Returns null when a word has no phonemes (the caller falls back to the
 * DP alignment).
 */
export function tokenTimings(input: TokenTimingInput): WordTiming | null {
  const { words, tokens, phonemes, owner, samples, sampleRate } = input;
  const d = input.durations?.map((x) => Math.max(1, Math.round(x)));
  if (!d || d.length !== phonemes.length + 2 || owner.length !== phonemes.length || !words.length) return null;
  const sumUnits = d.reduce((a, b) => a + b, 0);
  if (sumUnits <= 0) return null;
  const secPerUnit = samples / sampleRate / sumUnits;
  const speechEnd = (sumUnits - d[d.length - 1]) * secPerUnit;
  // Spoken span of each token, in frames.
  const span: ({ start: number; end: number } | null)[] = tokens.map(() => null);
  let cum = d[0];
  phonemes.forEach((ch, k) => {
    const t = owner[k];
    const dk = d[k + 1];
    if (t >= 0 && SPOKEN_PHONEME.test(ch)) {
      const s = span[t];
      if (!s) span[t] = { start: cum, end: cum + dk };
      else s.end = cum + dk;
    }
    cum += dk;
  });
  const starts: number[] = [];
  for (const w of words) {
    let start: number | null = null;
    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      const s = span[t];
      if (!s || tok.end <= w.start || tok.start >= w.end) continue;
      // Words sharing this token, in order: give each its share of the token's duration.
      const sharing = words.filter((x) => x.end > tok.start && x.start < tok.end);
      let at = s.start;
      if (sharing.length > 1) {
        const len = (x: { start: number; end: number }) => Math.max(1, Math.min(x.end, tok.end) - Math.max(x.start, tok.start));
        const total = sharing.reduce((a, x) => a + len(x), 0);
        let before = 0;
        for (const x of sharing) {
          if (x === w) break;
          before += len(x);
        }
        at = s.start + ((s.end - s.start) * before) / total;
      }
      start = start === null ? at : Math.min(start, at);
    }
    if (start === null) return null;
    starts.push(start * secPerUnit);
  }
  for (let i = 1; i < starts.length; i++) if (starts[i] < starts[i - 1]) return null;
  return { starts, ends: endsFrom(starts, speechEnd), speechEnd, method: 'durations+tokens' };
}

function endsFrom(starts: number[], speechEnd: number): number[] {
  return starts.map((_, i) => (i + 1 < starts.length ? starts[i + 1] : Math.max(speechEnd, starts[i])));
}

/** Shift timings after trimming `seconds` of leading audio. */
export function shiftTimings(t: WordTiming, seconds: number): WordTiming {
  const f = (x: number) => Math.max(0, x - seconds);
  return { ...t, starts: t.starts.map(f), ends: t.ends.map(f), speechEnd: f(t.speechEnd) };
}

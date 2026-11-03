// The pronunciation list: words the reader wants said differently, each with a spelling of how it
// sounds ("nginx" as "engine x"). Before the G2P runs, every listed word in the text is replaced
// by its spelling; the G2P tokens are then mapped back to the original text, so the word timings
// and the highlight still point at the word on the page.

import type { G2P, G2PResult, VoiceLang } from './types';

export interface Pronunciation {
  /** The word or phrase as written. Matched whole, ignoring case. */
  word: string;
  /** How to say it, spelled as it sounds. */
  sayAs: string;
}

export const MAX_PRONUNCIATIONS = 500;
export const MAX_WORD_LENGTH = 60;
export const MAX_SAY_AS_LENGTH = 120;

const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/**
 * Trims both fields, drops entries with an empty field or a word without a letter or digit, and
 * keeps only the last entry for a word (ignoring case), at its first position.
 */
export function normalizePronunciations(list: unknown): Pronunciation[] {
  if (!Array.isArray(list)) return [];
  const byWord = new Map<string, Pronunciation>();
  for (const item of list) {
    const p = item as Partial<Pronunciation> | null;
    const word = clean(p?.word, MAX_WORD_LENGTH);
    const sayAs = clean(p?.sayAs, MAX_SAY_AS_LENGTH);
    if (!word || !sayAs || !/[\p{L}\p{N}]/u.test(word)) continue;
    byWord.set(word.toLocaleLowerCase(), { word, sayAs });
  }
  return [...byWord.values()].slice(0, MAX_PRONUNCIATIONS);
}

export interface Rewrite {
  /** The text with every listed word replaced by its spelling. */
  text: string;
  /** Whether anything was replaced. */
  changed: boolean;
  /** Offset in the original text where a token starting at `i` of the new text starts. */
  start(i: number): number;
  /** Offset in the original text where a token ending at `i` of the new text ends. */
  end(i: number): number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A compiled pronunciation list. */
export class Pronouncer {
  private readonly re: RegExp | null;
  private readonly sayAs = new Map<string, string>();

  constructor(list: Pronunciation[]) {
    const rules = normalizePronunciations(list);
    for (const r of rules) this.sayAs.set(r.word.toLocaleLowerCase(), r.sayAs);
    // Longer words first, so "New York City" wins over "New York". A word only matches whole:
    // not inside a longer word, but "nginx's" and "nginx," still match.
    const words = rules.map((r) => r.word).sort((a, b) => b.length - a.length);
    this.re = words.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((w) => escape(w).replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  }

  get size(): number {
    return this.sayAs.size;
  }

  rewrite(text: string): Rewrite {
    const n = text.length;
    if (!this.re) return { text, changed: false, start: (i) => Math.min(i, n), end: (i) => Math.min(i, n) };
    let out = '';
    const starts: number[] = [];
    const ends: number[] = [0];
    let last = 0;
    let matched = false;
    const copy = (from: number, to: number) => {
      for (let o = from; o < to; o++) {
        starts.push(o);
        ends.push(o + 1);
      }
      out += text.slice(from, to);
    };
    for (const m of text.matchAll(this.re)) {
      const key = m[0].replace(/\s+/g, ' ').toLocaleLowerCase();
      const say = this.sayAs.get(key);
      if (say === undefined) continue;
      const s = m.index!;
      const e = s + m[0].length;
      copy(last, s);
      for (let k = 0; k < say.length; k++) {
        starts.push(s);
        ends.push(e);
      }
      out += say;
      last = e;
      matched = true;
    }
    if (!matched) return { text, changed: false, start: (i) => Math.min(i, n), end: (i) => Math.min(i, n) };
    copy(last, n);
    starts.push(n);
    const clamp = (i: number) => Math.max(0, Math.min(i, out.length));
    return { text: out, changed: true, start: (i) => starts[clamp(i)], end: (i) => ends[clamp(i)] };
  }
}

/**
 * Phonemes for `text` with the pronunciation list applied. Token offsets point into `text`: a
 * token that came from a spelling covers the whole listed word it replaced.
 */
export async function phonemizeWith(g2p: G2P, pronouncer: Pronouncer, text: string, lang: VoiceLang): Promise<G2PResult> {
  const r = pronouncer.rewrite(text);
  if (!r.changed) return g2p.phonemize(text, lang);
  const g = await g2p.phonemize(r.text, lang);
  return { phonemes: g.phonemes, tokens: g.tokens.map((t) => ({ ...t, start: r.start(t.start), end: Math.max(r.start(t.start), r.end(t.end)) })) };
}

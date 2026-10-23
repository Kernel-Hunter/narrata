// Port of the G2P class from misaki/en.py (misaki 0.9.4, Apache-2.0, Copyright hexgrad).
// https://github.com/hexgrad/misaki/blob/main/misaki/en.py
// Tokenize (spaCy rules), tag, split tokens into subtokens, look every word up right to left (the
// next word decides "the" vs "thee", "to" vs "tu"), fall back for unknown words, and join.
// Unlike misaki, every output token keeps its character offsets in the input text.

import { CONSONANTS, CURRENCIES, Lexicon, PRIMARY_STRESS, VOWELS, applyStress, isDigit, type Lookup, type TokenContext } from './lexicon';
import { normalizeTokens } from './normalize';
import type { Tagger } from './tagger';
import { tokenize } from './tokenizer';

export interface MToken {
  text: string;
  tag: string;
  whitespace: string;
  phonemes: string | null;
  /** Offsets in the input text. */
  start: number;
  end: number;
  isHead: boolean;
  alias: string | null;
  stress: number | null;
  currency: string | null;
  numFlags: string;
  prespace: boolean;
  rating: number | null;
}

/** Phonemes for one output token. */
export interface G2PToken {
  text: string;
  start: number;
  end: number;
  tag: string;
  phonemes: string;
  whitespace: string;
}

export type Fallback = (token: MToken) => Lookup;

const SUBTOKEN = /^['‘’]+|\p{Lu}(?=\p{Lu}\p{Ll})|(?:^-)?(?:\p{Nd}?[,.]?\p{Nd})+|[-_]+|['‘’]{2,}|\p{L}*?(?:['‘’]\p{L})*?\p{Ll}(?=\p{Lu})|\p{L}+(?:['‘’]\p{L})*|[^-_\p{L}'‘’\p{Nd}]|['‘’]+$/gu;
const SUBTOKEN_JUNKS = new Set("',-._‘’/");
const PUNCTS = new Set(';:,.!?—…"“”');
const NON_QUOTE_PUNCTS = new Set([...PUNCTS].filter((p) => !'"“”'.includes(p)));
const PUNCT_TAGS = new Set(['.', ',', '-LRB-', '-RRB-', '``', '""', "''", ':', '$', '#', 'NFP']);
const PUNCT_TAG_PHONEMES: Record<string, string> = { '-LRB-': '(', '-RRB-': ')', '``': '“', '""': '”', "''": '”' };
const DIPHTHONGS = new Set('AIOQWYʤʧ');

const isAsciiLetters = (s: string) => [...s].every((c) => /[a-z]/.test(c.toLowerCase()) && c.toLowerCase().length === 1);
const allJunk = (s: string) => [...s].every((c) => SUBTOKEN_JUNKS.has(c));

function stressWeight(ps: string | null): number {
  if (!ps) return 0;
  let w = 0;
  for (const c of ps) w += DIPHTHONGS.has(c) ? 2 : 1;
  return w;
}

/** subtokenize: split a spaCy token into the pieces misaki looks up ("3rd-place" -> 3rd, -, place). */
export function subtokenize(word: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  for (const m of word.matchAll(SUBTOKEN)) out.push({ text: m[0], offset: m.index! });
  return out;
}

/** merge_tokens */
function mergeTokens(tokens: MToken[], unk: string | null = null): MToken {
  const stress = new Set(tokens.map((t) => t.stress).filter((s) => s !== null));
  const currency = tokens.map((t) => t.currency).filter((c): c is string => c !== null);
  const ratings = tokens.map((t) => t.rating);
  let phonemes: string | null = null;
  if (unk !== null) {
    phonemes = '';
    for (const t of tokens) {
      if (t.prespace && phonemes && !/\s$/.test(phonemes) && t.phonemes) phonemes += ' ';
      phonemes += t.phonemes === null ? unk : t.phonemes;
    }
  }
  // The tag of the token with the most (upper case counts double) characters; first one wins ties.
  let best = tokens[0];
  let bestScore = -1;
  for (const t of tokens) {
    let score = 0;
    for (const c of t.text) score += c === c.toLowerCase() ? 1 : 2;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  const flags = [...new Set(tokens.flatMap((t) => [...t.numFlags]))].sort().join('');
  return {
    text: tokens.slice(0, -1).map((t) => t.text + t.whitespace).join('') + tokens[tokens.length - 1].text,
    tag: best.tag,
    whitespace: tokens[tokens.length - 1].whitespace,
    phonemes,
    start: tokens[0].start,
    end: tokens[tokens.length - 1].end,
    isHead: tokens[0].isHead,
    alias: null,
    stress: stress.size === 1 ? [...stress][0] : null,
    currency: currency.length ? currency.reduce((a, b) => (b > a ? b : a)) : null,
    numFlags: flags,
    prespace: tokens[0].prespace,
    rating: ratings.includes(null) ? null : Math.min(...(ratings as number[])),
  };
}

function token(text: string, tag: string, whitespace: string, start: number): MToken {
  return { text, tag, whitespace, phonemes: null, start, end: start + text.length, isHead: true, alias: null, stress: null, currency: null, numFlags: '', prespace: false, rating: null };
}

type Word = MToken | MToken[];

/** G2P.retokenize */
function retokenize(tokens: MToken[]): Word[] {
  const words: Word[] = [];
  let currency: string | null = null;
  tokens.forEach((tok, i) => {
    let tks: MToken[];
    if (tok.alias === null && tok.phonemes === null) {
      tks = subtokenize(tok.text).map((s) => ({ ...token(s.text, tok.tag, '', tok.start + s.offset), numFlags: tok.numFlags, stress: tok.stress }));
      if (!tks.length) tks = [{ ...tok }];
    } else tks = [tok];
    tks[tks.length - 1].whitespace = tok.whitespace;
    tks.forEach((tk, j) => {
      if (tk.alias !== null || tk.phonemes !== null) {
        // already resolved
      } else if (tk.tag === '$' && Object.hasOwn(CURRENCIES, tk.text)) {
        currency = tk.text;
        tk.phonemes = '';
        tk.rating = 4;
      } else if (tk.tag === ':' && (tk.text === '-' || tk.text === '–')) {
        tk.phonemes = '—';
        tk.rating = 3;
      } else if (PUNCT_TAGS.has(tk.tag) && !isAsciiLetters(tk.text)) {
        tk.phonemes = PUNCT_TAG_PHONEMES[tk.tag] ?? [...tk.text].filter((c) => PUNCTS.has(c)).join('');
        tk.rating = 4;
      } else if (currency !== null) {
        if (tk.tag !== 'CD') currency = null;
        else if (j + 1 === tks.length && (i + 1 === tokens.length || tokens[i + 1].tag !== 'CD')) tk.currency = currency;
      } else if (j > 0 && j < tks.length - 1 && tk.text === '2' && /^\p{L}+$/u.test(tks[j - 1].text.slice(-1) + tks[j + 1].text[0])) {
        tk.alias = 'to';
      }
      const last = words[words.length - 1];
      if (tk.alias !== null || tk.phonemes !== null) words.push(tk);
      else if (Array.isArray(last) && !last[last.length - 1].whitespace) {
        tk.isHead = false;
        last.push(tk);
      } else words.push(tk.whitespace ? tk : [tk]);
    });
  });
  return words.map((w) => (Array.isArray(w) && w.length === 1 ? w[0] : w));
}

/** G2P.token_context */
function tokenContext(ctx: TokenContext, ps: string | null, tk: MToken): TokenContext {
  let vowel = ctx.futureVowel;
  if (ps) {
    for (const c of ps) {
      if (VOWELS.has(c) || CONSONANTS.has(c) || NON_QUOTE_PUNCTS.has(c)) {
        vowel = NON_QUOTE_PUNCTS.has(c) ? null : VOWELS.has(c);
        break;
      }
    }
  }
  const futureTo = tk.text === 'to' || tk.text === 'To' || (tk.text === 'TO' && (tk.tag === 'TO' || tk.tag === 'IN'));
  return { futureVowel: vowel, futureTo };
}

/** G2P.resolve_tokens: subtokens of one word that were looked up separately. */
function resolveTokens(tokens: MToken[]): void {
  const text = tokens.slice(0, -1).map((t) => t.text + t.whitespace).join('') + tokens[tokens.length - 1].text;
  const kinds = new Set([...text].filter((c) => !SUBTOKEN_JUNKS.has(c)).map((c) => (/^\p{L}$/u.test(c) ? 0 : isDigit(c) ? 1 : 2)));
  const prespace = text.includes(' ') || text.includes('/') || kinds.size > 1;
  tokens.forEach((tk, i) => {
    if (tk.phonemes === null) {
      if (i === tokens.length - 1 && NON_QUOTE_PUNCTS.has(tk.text)) {
        tk.phonemes = tk.text;
        tk.rating = 3;
      } else if (allJunk(tk.text)) {
        tk.phonemes = '';
        tk.rating = 3;
      }
    } else if (i > 0) tk.prespace = prespace;
  });
  if (prespace) return;
  let indices: [number, number, number][] = [];
  tokens.forEach((tk, i) => {
    if (tk.phonemes) indices.push([tk.phonemes.includes(PRIMARY_STRESS) ? 1 : 0, stressWeight(tk.phonemes), i]);
  });
  if (indices.length === 2 && tokens[indices[0][2]].text.length === 1) {
    const i = indices[1][2];
    tokens[i].phonemes = applyStress(tokens[i].phonemes, -0.5);
    return;
  }
  if (indices.length < 2 || indices.reduce((s, [b]) => s + b, 0) <= Math.floor((indices.length + 1) / 2)) return;
  indices = indices.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).slice(0, Math.floor(indices.length / 2));
  for (const [, , i] of indices) tokens[i].phonemes = applyStress(tokens[i].phonemes, -0.5);
}

const SCALE_WORDS = new Set(['hundred', 'thousand', 'million', 'billion', 'trillion']);
const NUMERIC = /^\.?\d[\d,.]*$/;
const QUOTES = /^(?:["'`]|''|``)$/;

/**
 * Tags that spaCy assigns consistently but that are rare in the tagger's training text: currency
 * symbols, number words and digits, and opening versus closing quotes.
 */
function fixTags(text: string, words: string[], starts: number[], tags: string[]): string[] {
  return tags.map((tag, i) => {
    const w = words[i];
    if (w.length === 1 && Object.hasOwn(CURRENCIES, w)) return '$';
    if (SCALE_WORDS.has(w.toLowerCase()) || NUMERIC.test(w)) return 'CD';
    // "45k", "5G": a number with a letter suffix is a noun to spaCy (ordinals and plurals aside).
    if (/^\d+[A-Za-z]+$/.test(w) && !/\d(?:st|nd|rd|th|s)$/i.test(w)) return 'NN';
    if (w === '(' || w === '[' || w === '{') return '-LRB-';
    if (w === ')' || w === ']' || w === '}') return '-RRB-';
    if (w === '“' || w === '‘') return '``';
    if (w === '”') return "''";
    if (QUOTES.test(w)) {
      const before = starts[i] === 0 || /[\s([{]/.test(text[starts[i] - 1]);
      const after = text[starts[i] + w.length];
      const opens = before && after !== undefined && !/\s/.test(after) && (w !== "'" || (words[i + 1]?.length ?? 0) > 1);
      if (opens) return '``';
      // A lone apostrophe after a word is usually a possessive ("the dogs' bowls").
      return w === "'" ? tag : "''";
    }
    return tag;
  });
}

export interface MisakiOptions {
  lexicon: Lexicon;
  tagger: Tagger;
  fallback?: Fallback | null;
  /** Kokoro v1.0 takes 'T' for the American flap and 't' for the glottal stop (misaki version != 2.0). */
  version?: string | null;
  /** Narrata's additions for clock times, abbreviations and units (normalize.ts). Default true. */
  normalize?: boolean;
}

export class MisakiG2P {
  private readonly lexicon: Lexicon;
  private readonly tagger: Tagger;
  private readonly fallback: Fallback | null;
  private readonly version: string | null;
  private readonly normalize: boolean;

  constructor(opts: MisakiOptions) {
    this.lexicon = opts.lexicon;
    this.tagger = opts.tagger;
    this.fallback = opts.fallback ?? null;
    this.version = opts.version ?? null;
    this.normalize = opts.normalize ?? true;
  }

  /** spaCy tokens with tags. Whitespace tokens are tagged _SP, like spaCy. */
  tokenize(text: string): MToken[] {
    const toks = tokenize(text);
    const words = toks.filter((t) => t.text.trim());
    const tags = fixTags(
      text,
      words.map((t) => t.text),
      words.map((t) => t.start),
      this.tagger.tag(words.map((t) => t.text)),
    );
    const tagOf = new Map(words.map((t, i) => [t, tags[i]]));
    return toks.map((t) => token(t.text, tagOf.get(t) ?? '_SP', t.space ? ' ' : '', t.start));
  }

  private lookup(tk: MToken, ctx: TokenContext): Lookup {
    try {
      return this.lexicon.call(tk.alias ?? tk.text, { tag: tk.tag, isHead: tk.isHead, currency: tk.currency, numFlags: tk.numFlags, stress: tk.stress }, ctx);
    } catch {
      return [null, null];
    }
  }

  /** One word on its own, as a noun: lexicon, then the fallback. */
  private readWord(word: string): string | null {
    const tk = token(word, 'NN', '', 0);
    let [ps] = this.lookup(tk, { futureVowel: null, futureTo: false });
    if (ps === null && this.fallback) [ps] = this.fallback(tk);
    return ps;
  }

  /** G2P.__call__, returning tokens with offsets. */
  tokens(input: string): G2PToken[] {
    const lead = input.length - input.trimStart().length;
    const text = input.slice(lead);
    const base = this.tokenize(text);
    if (this.normalize) normalizeTokens(base, this.lexicon, (w) => this.readWord(w));
    const words = retokenize(base);
    let ctx: TokenContext = { futureVowel: null, futureTo: false };
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (!Array.isArray(w)) {
        if (w.phonemes === null) [w.phonemes, w.rating] = this.lookup(w, ctx);
        if (w.phonemes === null && this.fallback) [w.phonemes, w.rating] = this.fallback(w);
        ctx = tokenContext(ctx, w.phonemes, w);
        continue;
      }
      let left = 0;
      let right = w.length;
      let shouldFallback = false;
      while (left < right) {
        const span = w.slice(left, right);
        const tk = span.some((t) => t.alias !== null || t.phonemes !== null) ? null : mergeTokens(span);
        const [ps, rating] = tk === null ? [null, null] : this.lookup(tk, ctx);
        if (ps !== null) {
          w[left].phonemes = ps;
          w[left].rating = rating;
          for (const x of w.slice(left + 1, right)) x.phonemes = '';
          ctx = tokenContext(ctx, ps, tk!);
          right = left;
          left = 0;
        } else if (left + 1 < right) left++;
        else {
          right--;
          const t = w[right];
          if (t.phonemes === null) {
            if (allJunk(t.text)) {
              t.phonemes = '';
              t.rating = 3;
            } else if (this.fallback) {
              shouldFallback = true;
              break;
            }
          }
          left = 0;
        }
      }
      if (shouldFallback) {
        const tk = mergeTokens(w);
        [w[0].phonemes, w[0].rating] = this.fallback!(tk);
        for (let j = 1; j < w.length; j++) {
          w[j].phonemes = '';
          w[j].rating = w[0].rating;
        }
      } else resolveTokens(w);
    }
    const merged = words.map((w) => (Array.isArray(w) ? mergeTokens(w, '') : w));
    return merged.map((t) => {
      let ps = t.phonemes ?? '';
      if (this.version !== '2.0') ps = ps.replaceAll('ɾ', 'T').replaceAll('ʔ', 't');
      return { text: t.text, start: t.start + lead, end: t.end + lead, tag: t.tag, phonemes: ps, whitespace: t.whitespace };
    });
  }

  /** The phoneme string, as misaki returns it. */
  phonemize(text: string): string {
    return this.tokens(text)
      .map((t) => t.phonemes + t.whitespace)
      .join('');
  }
}

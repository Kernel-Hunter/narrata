// Splits a document into sentences (for navigation and highlighting) and into generation chunks
// (for the TTS model). Chunks never cross a block boundary and stay well under the model's
// 510 phoneme-token limit. Playback starts with a short "head" chunk (3 to 8 words) so the
// first audio arrives quickly.

import { type DocText, tokenizeWords } from './text';

export type ChunkEnd = 'sentence' | 'clause' | 'none' | 'block' | 'heading';

export interface Span {
  start: number;
  end: number;
}

export interface Sentence extends Span {
  block: number;
}

export interface Chunk extends Span {
  block: number;
  /** What follows the chunk; decides the pause length at the joint. */
  endsWith: ChunkEnd;
}

/** Roughly one phoneme token per character; 300 leaves room for number expansion. */
export const MAX_CHUNK_CHARS = 300;

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'vs', 'etc', 'inc', 'ltd', 'co', 'corp',
  'dept', 'fig', 'figs', 'no', 'nos', 'vol', 'vols', 'pp', 'p', 'ed', 'eds', 'gen', 'gov', 'sen',
  'rep', 'rev', 'sgt', 'col', 'capt', 'lt', 'maj', 'cmdr', 'approx', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'e.g', 'i.e', 'cf', 'al', 'ca', 'ch',
]);

const TERMINAL = '.!?…';
const CLOSERS = '"\'”’)]}»';

function isUpperStart(ch: string | undefined): boolean {
  return !!ch && /[\p{Lu}\p{N}"'“‘(\[«]/u.test(ch);
}

/** Sentence spans inside text[from, to). */
export function splitSentences(text: string, from = 0, to = text.length): Span[] {
  const spans: Span[] = [];
  let start = from;
  // Skip leading whitespace.
  while (start < to && /\s/.test(text[start])) start++;
  let i = start;
  while (i < to) {
    const ch = text[i];
    if (!TERMINAL.includes(ch)) {
      i++;
      continue;
    }
    // Run of terminal punctuation and closing quotes.
    let j = i;
    while (j + 1 < to && TERMINAL.includes(text[j + 1])) j++;
    while (j + 1 < to && CLOSERS.includes(text[j + 1])) j++;
    const after = j + 1;
    if (after < to && !/\s/.test(text[after])) {
      i = after;
      continue;
    }
    let next = after;
    while (next < to && /\s/.test(text[next])) next++;
    if (next >= to) break; // end of range: the final span is added below
    if (ch === '.') {
      // Token before the period.
      let k = i - 1;
      while (k >= from && !/\s/.test(text[k])) k--;
      const token = text.slice(k + 1, i).replace(/^["'“‘(\[]+/, '');
      const lower = token.toLowerCase();
      const nextCh = text[next];
      if (ABBREVIATIONS.has(lower) && (lower !== 'etc' || !isUpperStart(nextCh))) {
        i = after;
        continue;
      }
      if (/^\p{L}$/u.test(token) || /^(\p{L}\.)+\p{L}$/u.test(token)) {
        // Initials ("J. K. Rowling", "U.S.") are not sentence ends.
        i = after;
        continue;
      }
      if (!isUpperStart(nextCh)) {
        i = after;
        continue;
      }
    } else if (!isUpperStart(text[next]) && ch !== '…') {
      // "?" or "!" followed by lowercase, e.g. "Really?" she asked.
      i = after;
      continue;
    }
    spans.push({ start, end: after });
    start = next;
    i = next;
  }
  let end = to;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end > start) spans.push({ start, end });
  return spans;
}

/** Sentences of the whole document, block by block. */
export function documentSentences(doc: DocText): Sentence[] {
  const out: Sentence[] = [];
  doc.blocks.forEach((b, block) => {
    for (const s of splitSentences(doc.text, b.start, b.end)) out.push({ ...s, block });
  });
  return out;
}

const CLAUSE_PUNCT = /[,;:—–)]["'”’]?$/;

function endKind(text: string, span: Span, blockEnd: number, heading: boolean): ChunkEnd {
  if (span.end >= blockEnd) return heading ? 'heading' : 'block';
  const tail = text.slice(Math.max(span.start, span.end - 3), span.end);
  if (/[.!?…]["'”’)\]]*$/.test(tail)) return 'sentence';
  if (CLAUSE_PUNCT.test(tail)) return 'clause';
  return 'none';
}

/** Split a span that is too long, preferring clause punctuation near the middle. */
export function splitLong(text: string, span: Span, max = MAX_CHUNK_CHARS): Span[] {
  if (span.end - span.start <= max) return [span];
  const s = text.slice(span.start, span.end);
  const mid = s.length / 2;
  let best = -1;
  let bestScore = Infinity;
  for (const m of s.matchAll(/[,;:—–]["'”’]?\s+/g)) {
    const cut = m.index! + m[0].length;
    if (cut < 20 || s.length - cut < 20) continue;
    if (cut > max || s.length - cut > max * 2) continue;
    const score = Math.abs(cut - mid);
    if (score < bestScore) {
      bestScore = score;
      best = cut;
    }
  }
  if (best < 0) {
    // No usable punctuation: split at the space closest to the middle.
    for (const m of s.matchAll(/\s+/g)) {
      const cut = m.index! + m[0].length;
      const score = Math.abs(cut - mid);
      if (score < bestScore) {
        bestScore = score;
        best = cut;
      }
    }
  }
  if (best < 0) best = Math.floor(mid);
  let leftEnd = span.start + best;
  while (leftEnd > span.start && /\s/.test(text[leftEnd - 1])) leftEnd--;
  return [
    ...splitLong(text, { start: span.start, end: leftEnd }, max),
    ...splitLong(text, { start: span.start + best, end: span.end }, max),
  ];
}

/** Generation chunks for the whole document: one per sentence, long sentences split. */
export function planChunks(doc: DocText, sentences: Sentence[] = documentSentences(doc), max = MAX_CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  for (const s of sentences) {
    const b = doc.blocks[s.block];
    const heading = b.kind.startsWith('h');
    for (const part of splitLong(doc.text, s, max)) {
      chunks.push({ ...part, block: s.block, endsWith: endKind(doc.text, part, b.end, heading) });
    }
  }
  return chunks;
}

const FUNCTION_WORDS = new Set([
  'and', 'but', 'or', 'nor', 'so', 'yet', 'because', 'although', 'though', 'while', 'when', 'where',
  'which', 'who', 'whom', 'whose', 'that', 'if', 'unless', 'until', 'after', 'before', 'since', 'as',
  'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'into', 'onto', 'over', 'under', 'about',
  'between', 'through', 'during', 'without', 'within', 'against', 'among', 'by',
  'the', 'a', 'an', 'his', 'her', 'their', 'its', 'my', 'our', 'your', 'this', 'these', 'those',
]);

/**
 * Split off a short head (3 to 8 words) from a chunk so playback can start fast.
 * Returns null when the chunk is already short.
 */
export function splitHead(text: string, chunk: Chunk): [Chunk, Chunk] | null {
  const words = tokenizeWords(text, chunk.start, chunk.end);
  if (words.length <= 10) return null;
  const tokenEnd = (i: number) => {
    // End of the whole token (including trailing punctuation) of word i.
    let e = words[i].end;
    while (e < chunk.end && !/[\s\p{L}\p{N}]/u.test(text[e])) e++;
    return e;
  };
  let cut = -1; // number of words in the head
  for (let n = 3; n <= 8; n++) {
    const tail = text.slice(words[n - 1].start, tokenEnd(n - 1));
    if (/[,;:—–.!?]["'”’)]?$/.test(tail)) {
      cut = n;
      break;
    }
  }
  if (cut < 0) {
    let best = Infinity;
    for (let n = 4; n <= 8; n++) {
      const next = text.slice(words[n].start, words[n].end).toLowerCase();
      if (FUNCTION_WORDS.has(next) && Math.abs(n - 6) < best) {
        best = Math.abs(n - 6);
        cut = n;
      }
    }
  }
  if (cut < 0) cut = 6;
  if (words.length - cut < 3) return null;
  const headEnd = tokenEnd(cut - 1);
  const tailStart = Math.max(headEnd, words[cut].start - leadPunct(text, words[cut].start));
  const headText = text.slice(chunk.start, headEnd);
  const head: Chunk = {
    start: chunk.start,
    end: headEnd,
    block: chunk.block,
    endsWith: /[.!?…]["'”’)]*$/.test(headText) ? 'sentence' : /[,;:—–]["'”’]?$/.test(headText) ? 'clause' : 'none',
  };
  return [head, { start: tailStart, end: chunk.end, block: chunk.block, endsWith: chunk.endsWith }];
}

function leadPunct(text: string, wordStart: number): number {
  let n = 0;
  while (wordStart - n - 1 >= 0 && !/[\s\p{L}\p{N}]/u.test(text[wordStart - n - 1])) n++;
  return n;
}

/**
 * Chunks to play starting at `offset`: the chunk containing the offset is trimmed to start at
 * the word at the offset, and its first words are split off as a fast-start head.
 */
export function chunksFrom(text: string, chunks: Chunk[], offset: number): Chunk[] {
  let i = chunks.findIndex((c) => c.end > offset);
  if (i < 0) return [];
  const first = { ...chunks[i] };
  if (offset > first.start) {
    const words = tokenizeWords(text, first.start, first.end);
    const w = words.find((x) => x.end > offset);
    if (w) first.start = w.start - leadPunct(text, w.start);
  }
  const head = splitHead(text, first);
  const rest = chunks.slice(i + 1);
  return head ? [head[0], head[1], ...rest] : [first, ...rest];
}

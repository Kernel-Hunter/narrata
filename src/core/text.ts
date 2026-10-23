// Document text model shared by every input format.
//
// A document is a list of blocks (headings, paragraphs, list items...). Blocks are joined with
// a blank line into one plain string; every position in the app (reading position, highlight,
// chunk ranges) is a character offset into that string.

export type BlockKind = 'h1' | 'h2' | 'h3' | 'p' | 'li' | 'quote' | 'pre';

export interface Block {
  kind: BlockKind;
  text: string;
  /** Index into `chapters`, when the source has chapters (EPUB). */
  chapter?: number;
}

export interface Chapter {
  title: string;
  /** First block of the chapter. */
  block: number;
}

export interface BlockRange {
  kind: BlockKind;
  start: number;
  end: number;
  chapter?: number;
}

export interface DocText {
  text: string;
  blocks: BlockRange[];
  chapters: Chapter[];
}

export interface Word {
  /** Start of the spoken part of the token (leading punctuation removed). */
  start: number;
  /** End of the spoken part of the token (trailing punctuation removed). */
  end: number;
}

export const BLOCK_SEPARATOR = '\n\n';

/** Collapse runs of whitespace and trim. Keeps the text on one line. */
export function cleanInline(s: string): string {
  return s.replace(/[\s ​]+/g, ' ').trim();
}

export function buildDocText(blocks: Block[], chapters: Chapter[] = []): DocText {
  const out: BlockRange[] = [];
  const parts: string[] = [];
  const blockMap = new Map<number, number>();
  let pos = 0;
  blocks.forEach((b, i) => {
    const text = b.kind === 'pre' ? b.text.replace(/\s+$/g, '') : cleanInline(b.text);
    if (!text) return;
    if (parts.length) pos += BLOCK_SEPARATOR.length;
    blockMap.set(i, out.length);
    out.push({ kind: b.kind, start: pos, end: pos + text.length, ...(b.chapter !== undefined ? { chapter: b.chapter } : {}) });
    parts.push(text);
    pos += text.length;
  });
  // Re-point chapters at the surviving block indices (empty blocks were dropped).
  const fixed: Chapter[] = [];
  for (const c of chapters) {
    let target: number | undefined;
    for (let i = c.block; i < blocks.length && target === undefined; i++) target = blockMap.get(i);
    if (target !== undefined) fixed.push({ title: c.title, block: target });
  }
  return { text: parts.join(BLOCK_SEPARATOR), blocks: out, chapters: fixed };
}

const SPOKEN = /[\p{L}\p{N}]/u;
// Characters that separate words even without spaces ("word—word", "and/or", "wait…what").
const TOKEN = /[^\s—–…/]+/gu;
const EDGE_PUNCT_START = /^[^\p{L}\p{N}]+/u;
const EDGE_PUNCT_END = /[^\p{L}\p{N}]+$/u;

export function isSpoken(s: string): boolean {
  return SPOKEN.test(s);
}

/** Words (tokens that contain a letter or digit) in text[from, to). Offsets are absolute. */
export function tokenizeWords(text: string, from = 0, to = text.length): Word[] {
  const slice = text.slice(from, to);
  const words: Word[] = [];
  for (const m of slice.matchAll(TOKEN)) {
    const tok = m[0];
    if (!SPOKEN.test(tok)) continue;
    const lead = tok.match(EDGE_PUNCT_START)?.[0].length ?? 0;
    const trail = tok.match(EDGE_PUNCT_END)?.[0].length ?? 0;
    const s = from + m.index! + lead;
    words.push({ start: s, end: from + m.index! + tok.length - trail });
  }
  return words;
}

/** Index of the block containing `offset` (or the next block when offset sits in a separator). */
export function blockAt(doc: DocText, offset: number): number {
  const b = doc.blocks;
  let lo = 0;
  let hi = b.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (b[mid].end <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Binary search: index of the last item whose `key(item) <= value`, or -1. */
export function lastAtOrBefore<T>(items: readonly T[], value: number, key: (t: T) => number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) <= value) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Index of the word containing or following `offset`. */
export function wordIndexAt(words: readonly Word[], offset: number): number {
  const i = lastAtOrBefore(words, offset, (w) => w.start);
  if (i < 0) return 0;
  if (offset < words[i].end || i === words.length - 1) return i;
  return Math.min(i + 1, words.length - 1);
}

export function titleFromText(text: string, max = 60): string {
  const first = cleanInline(text.split(/\n/).find((l) => isSpoken(l)) ?? '');
  if (!first) return 'Untitled';
  if (first.length <= max) return first.replace(/[.:;,]+$/, '');
  const cut = first.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[.:;,]+$/, '') + '…';
}

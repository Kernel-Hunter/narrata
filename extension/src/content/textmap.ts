// Maps the text Narrata reads back to text nodes on the original page.
//
// The reading text comes from a cleaned copy of the page (Readability, a selection, or one large
// block), so its offsets mean nothing in the live DOM. Instead, the visible text nodes of the page
// are indexed into one flat string, both texts are split into words, and the two word lists are
// aligned (patience diff with small LCS passes in between). A word to highlight then becomes a DOM
// Range over the original text nodes, which the CSS Custom Highlight API can paint without
// touching the page's DOM.

import { BLOCK_TAGS } from '../../../src/docs/html';
import { type BlockKind, type Word, tokenizeWords } from '../../../src/core/text';

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'select', 'option', 'iframe', 'object', 'embed', 'canvas', 'video', 'audio', 'svg', 'math', 'head', 'title', 'rt', 'rp', 'input', 'button']);
const EXTRA_BLOCK_TAGS = new Set(['nav', 'menu', 'legend', 'hgroup', 'search', 'dialog', 'li', 'br']);

/** One run of flat text copied from one text node. */
export interface IndexEntry {
  node: Text;
  /** Offset in the flat text where this run starts. */
  flatStart: number;
  /** Offset in the node's data where this run starts (non-zero when clipped by a range). */
  nodeStart: number;
  length: number;
}

export interface IndexBlock {
  kind: BlockKind;
  start: number;
  end: number;
}

export interface TextIndex {
  /** Text of every indexed node, with a "\n" between blocks. */
  text: string;
  entries: IndexEntry[];
  /** Words of `text` (offsets into `text`). */
  words: Word[];
  /** Block structure found while walking (headings, paragraphs, list items...). */
  blocks: IndexBlock[];
}

export interface IndexOptions {
  /** Only index the part of the tree inside this range (used for selections). */
  clip?: Range;
  /** Return false for elements that are not rendered. Defaults to `checkVisibility` when available. */
  isVisible?: (el: Element) => boolean;
  /** Elements to leave out completely (e.g. the player's host element). */
  exclude?: (el: Element) => boolean;
}

function blockKind(tag: string): BlockKind {
  switch (tag) {
    case 'h1':
      return 'h1';
    case 'h2':
      return 'h2';
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'h3';
    case 'li':
    case 'dt':
    case 'dd':
      return 'li';
    case 'blockquote':
      return 'quote';
    case 'pre':
      return 'pre';
    default:
      return 'p';
  }
}

function defaultVisible(el: Element): boolean {
  if (el.hasAttribute('hidden')) return false;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(el, { visibilityProperty: true });
  return true;
}

/** Walk `root` and index its visible text nodes. */
export function buildTextIndex(root: Node, opts: IndexOptions = {}): TextIndex {
  const isVisible = opts.isVisible ?? defaultVisible;
  const clip = opts.clip;
  const entries: IndexEntry[] = [];
  const blocks: IndexBlock[] = [];
  const parts: string[] = [];
  let len = 0;
  let lastChar = '\n';
  let blockStart = 0;
  const kinds: BlockKind[] = ['p'];

  const closeBlock = () => {
    if (len > blockStart) blocks.push({ kind: kinds[kinds.length - 1], start: blockStart, end: len });
    if (lastChar !== '\n') {
      parts.push('\n');
      len++;
      lastChar = '\n';
    }
    blockStart = len;
  };

  const addText = (node: Text) => {
    const data = node.data;
    let from = 0;
    let to = data.length;
    if (clip) {
      if (!clip.intersectsNode(node)) return;
      if (clip.startContainer === node) from = clip.startOffset;
      if (clip.endContainer === node) to = clip.endOffset;
    }
    if (to <= from) return;
    entries.push({ node, flatStart: len, nodeStart: from, length: to - from });
    const s = data.slice(from, to);
    parts.push(s);
    len += s.length;
    lastChar = s[s.length - 1];
  };

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      addText(node as Text);
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return;
    if (node.nodeType === 1) {
      const el = node as Element;
      const tag = el.localName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (opts.exclude?.(el)) return;
      if (clip && !clip.intersectsNode(el)) return;
      if (!isVisible(el)) return;
      const isBlock = BLOCK_TAGS.has(tag) || EXTRA_BLOCK_TAGS.has(tag);
      if (tag === 'br') {
        closeBlock();
        return;
      }
      if (isBlock) {
        closeBlock();
        kinds.push(blockKind(tag) === 'p' ? kinds[kinds.length - 1] : blockKind(tag));
        for (let c = el.firstChild; c; c = c.nextSibling) walk(c);
        closeBlock();
        kinds.pop();
        return;
      }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  };

  walk(root);
  closeBlock();
  const text = parts.join('');
  // Drop blocks that are only whitespace.
  const kept = blocks.filter((b) => /\S/.test(text.slice(b.start, b.end)));
  return { text, entries, words: tokenizeWords(text), blocks: kept };
}

/** Binary search: last entry whose flatStart <= pos. */
function entryAt(entries: readonly IndexEntry[], pos: number): number {
  let lo = 0;
  let hi = entries.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].flatStart <= pos) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * DOM position of a flat offset. Offsets that fall on a block separator resolve to the end of
 * the previous run (`bias: 'end'`) or the start of the next one (`bias: 'start'`).
 */
export function flatToDom(index: TextIndex, pos: number, bias: 'start' | 'end'): { node: Text; offset: number } | null {
  const e = index.entries;
  if (!e.length) return null;
  let i = entryAt(e, pos);
  if (i < 0) return { node: e[0].node, offset: e[0].nodeStart };
  let en = e[i];
  if (pos > en.flatStart + en.length || (bias === 'start' && pos === en.flatStart + en.length && i + 1 < e.length && e[i + 1].flatStart === pos)) {
    // In a gap after this entry.
    if (bias === 'start' && i + 1 < e.length) {
      en = e[++i];
      return { node: en.node, offset: en.nodeStart };
    }
    return { node: en.node, offset: en.nodeStart + en.length };
  }
  return { node: en.node, offset: en.nodeStart + (pos - en.flatStart) };
}

/** Flat offset of a DOM position, or -1 when the position is outside the index. */
export function domToFlat(index: TextIndex, node: Node, offset: number): number {
  let target: Node | null = node;
  let off = offset;
  if (node.nodeType !== 3) {
    // Caret between children: use the first text node at or after it.
    const child = node.childNodes[offset] ?? null;
    target = child ? firstText(child) : null;
    off = 0;
    if (!target) return -1;
  }
  const e = index.entries;
  for (let i = 0; i < e.length; i++) {
    if (e[i].node !== target) continue;
    // A node can appear once; clamp into the indexed part.
    const local = Math.max(0, Math.min(e[i].length, off - e[i].nodeStart));
    return e[i].flatStart + local;
  }
  return -1;
}

function firstText(n: Node): Text | null {
  if (n.nodeType === 3) return n as Text;
  for (let c = n.firstChild; c; c = c.nextSibling) {
    const t = firstText(c);
    if (t) return t;
  }
  return null;
}

/** Comparable form of a word: case, Unicode forms, quotes and invisible characters ignored. */
export function normalizeWord(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[­​-‏⁠﻿]/g, '')
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"');
}

const DP_CELLS = 2_000_000;

/**
 * Align two word lists. Returns, for every word of `a`, the index of the matching word in `b`,
 * or -1. Matches are strictly increasing in both lists.
 */
export function alignWords(a: readonly string[], b: readonly string[]): Int32Array {
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, (id = ids.size));
    return id;
  };
  const A = Int32Array.from(a, intern);
  const B = Int32Array.from(b, intern);
  const map = new Int32Array(A.length).fill(-1);
  // Each range remembers whether a match sits right before it (pinned start) or right after it
  // (pinned end). Only then can its edge words be matched by position: the first word of an
  // article ("The") must not snap to the first word of the page ("The Daily ...").
  const stack: [number, number, number, number, boolean, boolean][] = [[0, A.length, 0, B.length, false, false]];
  while (stack.length) {
    let [a0, a1, b0, b1, pinnedStart, pinnedEnd] = stack.pop()!;
    if (pinnedStart) while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) map[a0++] = b0++;
    if (pinnedEnd) while (a0 < a1 && b0 < b1 && A[a1 - 1] === B[b1 - 1]) map[--a1] = --b1;
    if (a0 >= a1 || b0 >= b1) continue;
    const anchors = uniqueAnchors(A, B, a0, a1, b0, b1);
    if (anchors.length) {
      let pa = a0;
      let pb = b0;
      let pinned = pinnedStart;
      for (const [i, j] of anchors) {
        map[i] = j;
        if (i > pa && j > pb) stack.push([pa, i, pb, j, pinned, true]);
        pa = i + 1;
        pb = j + 1;
        pinned = true;
      }
      if (a1 > pa && b1 > pb) stack.push([pa, a1, pb, b1, true, pinnedEnd]);
      continue;
    }
    // No word is unique in both ranges. Keep the search near the neighbouring match: words before
    // the first match sit just before it on the page, words after the last match just after it.
    const n = a1 - a0;
    let lo = b0;
    let hi = b1;
    const band = n * 3 + 16;
    if (hi - lo > band) {
      if (pinnedEnd && !pinnedStart) lo = hi - band;
      else if (pinnedStart && !pinnedEnd) hi = lo + band;
    }
    if (n * (hi - lo) <= DP_CELLS) lcs(A, B, map, a0, a1, lo, hi, pinnedEnd && !pinnedStart);
    else greedy(A, B, map, a0, a1, lo, hi);
  }
  return map;
}

/** Words that occur exactly once in both ranges, filtered to a longest increasing run. */
function uniqueAnchors(A: Int32Array, B: Int32Array, a0: number, a1: number, b0: number, b1: number): [number, number][] {
  const ca = new Map<number, number>();
  for (let i = a0; i < a1; i++) {
    const v = ca.get(A[i]);
    ca.set(A[i], v === undefined ? i : -1);
  }
  const cb = new Map<number, number>();
  for (let j = b0; j < b1; j++) {
    if (!ca.has(B[j])) continue;
    const v = cb.get(B[j]);
    cb.set(B[j], v === undefined ? j : -1);
  }
  const pairs: [number, number][] = [];
  for (let i = a0; i < a1; i++) {
    if (ca.get(A[i]) !== i) continue;
    const j = cb.get(A[i]);
    if (j !== undefined && j >= 0) pairs.push([i, j]);
  }
  return longestIncreasing(pairs);
}

/** Longest subsequence of pairs (already sorted by i) with increasing j (patience sorting). */
function longestIncreasing(pairs: [number, number][]): [number, number][] {
  if (pairs.length <= 1) return pairs;
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const out: [number, number][] = [];
  for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) out.push(pairs[k]);
  return out.reverse();
}

/**
 * Longest common subsequence over a small window, written into `map`. With `late`, ties are
 * broken towards the end of the window (used before the first match, where the words belong
 * right before it).
 */
function lcs(A: Int32Array, B: Int32Array, map: Int32Array, a0: number, a1: number, b0: number, b1: number, late = false) {
  const n = a1 - a0;
  const m = b1 - b0;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  if (late) {
    // t[i][j] = LCS of the first i and j words; trace back from the end.
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        t[i * w + j] = A[a0 + i - 1] === B[b0 + j - 1] ? t[(i - 1) * w + j - 1] + 1 : Math.max(t[(i - 1) * w + j], t[i * w + j - 1]);
      }
    }
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      if (A[a0 + i - 1] === B[b0 + j - 1]) {
        map[a0 + i - 1] = b0 + j - 1;
        i--;
        j--;
      } else if (t[(i - 1) * w + j] >= t[i * w + j - 1]) i--;
      else j--;
    }
    return;
  }
  // t[i][j] = LCS of the words from i and j on; trace forward from the start.
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = A[a0 + i] === B[b0 + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[a0 + i] === B[b0 + j]) {
      map[a0 + i] = b0 + j;
      i++;
      j++;
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
}

/**
 * Forward matching on runs of four words, for ranges too large for the LCS table and without
 * unique words. Each run of `a` jumps to the next place where the same four words appear in `b`.
 */
function greedy(A: Int32Array, B: Int32Array, map: Int32Array, a0: number, a1: number, b0: number, b1: number) {
  const K = 4;
  const key = (X: Int32Array, i: number) => `${X[i]},${X[i + 1]},${X[i + 2]},${X[i + 3]}`;
  const where = new Map<string, number[]>();
  for (let j = b0; j + K <= b1; j++) {
    const k = key(B, j);
    const list = where.get(k);
    if (list) list.push(j);
    else where.set(k, [j]);
  }
  let j0 = b0;
  let i = a0;
  while (i + K <= a1) {
    const list = where.get(key(A, i));
    let j = -1;
    if (list) {
      let lo = 0;
      let hi = list.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid] >= j0) {
          j = list[mid];
          hi = mid - 1;
        } else lo = mid + 1;
      }
    }
    if (j < 0) {
      i++;
      continue;
    }
    while (i < a1 && j < b1 && A[i] === B[j]) map[i++] = j++;
    j0 = j;
  }
}

/** Reading-text words mapped to page words, with helpers to build DOM ranges. */
export class DocMapping {
  /** Indices of reading words that found a page word, in order (for reverse lookups). */
  private mapped: Int32Array;

  constructor(
    readonly index: TextIndex,
    /** Reading word -> page word (-1 when not found). */
    readonly toPage: Int32Array,
  ) {
    const list: number[] = [];
    toPage.forEach((j, i) => {
      if (j >= 0) list.push(i);
    });
    this.mapped = Int32Array.from(list);
  }

  /** Share of reading words that were found on the page. */
  get coverage(): number {
    return this.toPage.length ? this.mapped.length / this.toPage.length : 0;
  }

  /** True while every indexed node is still attached to the document. */
  isLive(): boolean {
    const e = this.index.entries;
    return e.length > 0 && e[0].node.isConnected && e[e.length - 1].node.isConnected;
  }

  /** Range covering reading words first..last (inclusive), using the mapped words inside. */
  rangeForWords(first: number, last: number): Range | null {
    const lo = this.firstMappedAtOrAfter(first);
    const hi = this.lastMappedAtOrBefore(last);
    if (lo < 0 || hi < 0 || lo > hi) return null;
    const wa = this.index.words[this.toPage[lo]];
    const wb = this.index.words[this.toPage[hi]];
    const s = flatToDom(this.index, wa.start, 'start');
    const e = flatToDom(this.index, wb.end, 'end');
    if (!s || !e || !s.node.isConnected || !e.node.isConnected) return null;
    const r = s.node.ownerDocument.createRange();
    try {
      r.setStart(s.node, s.offset);
      r.setEnd(e.node, e.offset);
    } catch {
      return null;
    }
    return r;
  }

  /** Range of the word, or of the closest word that was found on the page (for scrolling). */
  nearestRange(i: number): Range | null {
    const j = this.lastMappedAtOrBefore(i);
    const k = j >= 0 ? j : this.firstMappedAtOrAfter(i);
    return k >= 0 ? this.rangeForWords(k, k) : null;
  }

  rangeForWord(i: number): Range | null {
    if (i < 0 || i >= this.toPage.length || this.toPage[i] < 0) return null;
    return this.rangeForWords(i, i);
  }

  /** Reading word at or after a page word (for clicks and "start from here"), or -1. */
  readingWordForPageWord(j: number): number {
    const m = this.mapped;
    let lo = 0;
    let hi = m.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.toPage[m[mid]] >= j) {
        ans = m[mid];
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }

  /** Page word index at a flat offset (the word containing it, or the next one), or -1. */
  pageWordAt(flat: number): number {
    const w = this.index.words;
    let lo = 0;
    let hi = w.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (w[mid].end > flat) {
        ans = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }

  /** First and last page words that belong to the reading text. */
  get pageSpan(): [number, number] | null {
    const m = this.mapped;
    if (!m.length) return null;
    return [this.toPage[m[0]], this.toPage[m[m.length - 1]]];
  }

  private firstMappedAtOrAfter(i: number): number {
    const m = this.mapped;
    let lo = 0;
    let hi = m.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (m[mid] >= i) {
        ans = m[mid];
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return ans;
  }

  private lastMappedAtOrBefore(i: number): number {
    const m = this.mapped;
    let lo = 0;
    let hi = m.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (m[mid] <= i) {
        ans = m[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }
}

/** Align the words of the reading text with the words of the page index. */
export function mapText(readingText: string, readingWords: readonly Word[], index: TextIndex): DocMapping {
  const a = readingWords.map((w) => normalizeWord(readingText.slice(w.start, w.end)));
  const b = index.words.map((w) => normalizeWord(index.text.slice(w.start, w.end)));
  return new DocMapping(index, alignWords(a, b));
}

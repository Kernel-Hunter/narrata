// Builds reading text from pdf.js text items: groups items into lines, lines into paragraphs,
// joins hyphenated line breaks, drops page numbers, and records where every character came
// from so the current word can be highlighted on the rendered page.

import type { BlockKind, BlockRange, DocText } from '../core/text';
import { BLOCK_SEPARATOR } from '../core/text';
import type { PdfTextMap } from './types';

export interface PdfItem {
  str: string;
  /** Baseline x, y in PDF units (y grows upwards). */
  x: number;
  y: number;
  width: number;
  /** Font height. */
  height: number;
  hasEOL: boolean;
}

export interface PdfPageItems {
  items: PdfItem[];
}

interface Piece {
  page: number;
  item: number;
  /** Offset in item.str of each character in `text`, or -1 for synthetic characters. */
  src: number[];
  text: string;
}

interface Line {
  page: number;
  y: number;
  x: number;
  right: number;
  height: number;
  pieces: Piece[];
  text: string;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pageLines(page: number, items: PdfItem[]): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  items.forEach((it, idx) => {
    const tol = Math.max(1, (it.height || 10) * 0.5);
    if (cur && (Math.abs(it.y - cur.y) > tol || it.x < cur.right - (it.height || 10) * 2)) {
      lines.push(cur);
      cur = null;
    }
    if (it.str.length) {
      if (!cur) cur = { page, y: it.y, x: it.x, right: it.x, height: it.height, pieces: [], text: '' };
      // Collapse whitespace while remembering where each kept character came from.
      const src: number[] = [];
      let text = '';
      for (let k = 0; k < it.str.length; k++) {
        const ch = it.str[k];
        if (/\s/.test(ch)) {
          const prevSpace = text.length ? text.endsWith(' ') : cur.text.endsWith(' ') || cur.text.length === 0;
          if (prevSpace) continue;
          text += ' ';
        } else text += ch;
        src.push(k);
      }
      // Items without a space between them but with a visible gap are separate words.
      if (cur.text && !cur.text.endsWith(' ') && text && !text.startsWith(' ') && it.x - cur.right > (it.height || 10) * 0.15) {
        cur.pieces.push({ page, item: -1, src: [-1], text: ' ' });
        cur.text += ' ';
      }
      if (text) {
        cur.pieces.push({ page, item: idx, src, text });
        cur.text += text;
      }
      cur.right = Math.max(cur.right, it.x + it.width);
      cur.height = Math.max(cur.height, it.height);
    }
    if (it.hasEOL && cur) {
      lines.push(cur);
      cur = null;
    }
  });
  if (cur) lines.push(cur);
  return lines.filter((l) => l.text.trim().length > 0);
}

const PAGE_NUMBER = /^\s*(page\s+)?\d{1,4}(\s+of\s+\d{1,4})?\s*$/i;

export function buildPdfDoc(pages: PdfPageItems[]): { doc: DocText; map: PdfTextMap } {
  const allLines = pages.map((p, i) => pageLines(i, p.items));
  const bodyHeight = median(allLines.flat().map((l) => l.height)) || 10;

  // Paragraphs as lists of lines.
  const paras: { kind: BlockKind; lines: Line[] }[] = [];
  let cur: { kind: BlockKind; lines: Line[] } | null = null;
  for (const lines of allLines) {
    // Drop page numbers on the first or last line of a page.
    const kept = lines.filter((l, i) => !((i === 0 || i === lines.length - 1) && PAGE_NUMBER.test(l.text)));
    const gaps: number[] = [];
    for (let i = 1; i < kept.length; i++) {
      const g = kept[i - 1].y - kept[i].y;
      if (g > 0) gaps.push(g);
    }
    const lineGap = median(gaps) || bodyHeight * 1.2;
    const maxRight = Math.max(...kept.map((l) => l.right), 0);
    const minX = Math.min(...kept.map((l) => l.x), Infinity);
    kept.forEach((line, i) => {
      const heading = line.height > bodyHeight * 1.25 && line.text.length < 120;
      const kind: BlockKind = heading ? (line.height > bodyHeight * 1.7 ? 'h1' : 'h2') : 'p';
      let breakBefore = !cur;
      if (cur) {
        const prev = cur.lines[cur.lines.length - 1];
        if (i === 0) {
          // New page: continue the paragraph unless the previous one ended a sentence.
          breakBefore = /[.!?:"”]\s*$/.test(prev.text) || kind !== cur.kind;
        } else {
          const gap = prev.y - line.y;
          const prevShort = prev.right < maxRight - bodyHeight * 4 && /[.!?:"”]\s*$/.test(prev.text);
          const indented = line.x > minX + bodyHeight * 1.2 && prev.x <= minX + bodyHeight * 0.5;
          breakBefore = gap > lineGap * 1.45 || gap < 0 || kind !== cur.kind || prevShort || (indented && /[.!?:"”]\s*$/.test(prev.text));
        }
      }
      if (breakBefore) {
        cur = { kind, lines: [] };
        paras.push(cur);
      }
      cur!.lines.push(line);
    });
  }

  // Emit text and the character map.
  const map: PdfTextMap = { docStart: [], page: [], item: [], itemStart: [], length: [] };
  const blocks: BlockRange[] = [];
  let text = '';
  const emit = (piece: Piece, from = 0, to = piece.text.length) => {
    // Split into runs of consecutive source offsets.
    let k = from;
    while (k < to) {
      if (piece.item < 0 || piece.src[k] < 0) {
        text += piece.text[k];
        k++;
        continue;
      }
      const runStart = k;
      while (k + 1 < to && piece.src[k + 1] === piece.src[k] + 1) k++;
      k++;
      const last = map.docStart.length - 1;
      const docStart = text.length;
      // Extend the previous run when it continues the same item.
      if (last >= 0 && map.page[last] === piece.page && map.item[last] === piece.item && map.docStart[last] + map.length[last] === docStart && map.itemStart[last] + map.length[last] === piece.src[runStart]) {
        map.length[last] += k - runStart;
      } else {
        map.docStart.push(docStart);
        map.page.push(piece.page);
        map.item.push(piece.item);
        map.itemStart.push(piece.src[runStart]);
        map.length.push(k - runStart);
      }
      text += piece.text.slice(runStart, k);
    }
  };
  for (const p of paras) {
    if (blocks.length) text += BLOCK_SEPARATOR;
    const start = text.length;
    p.lines.forEach((line, li) => {
      // Keep line.text[a, b): no leading space at a block start, no trailing space, and no
      // hyphen when the word continues on the next line.
      let b = line.text.replace(/\s+$/, '').length;
      const next = p.lines[li + 1];
      const hyphenated = !!next && /\p{L}-$/u.test(line.text.slice(0, b)) && /^\s*\p{Ll}/u.test(next.text);
      if (hyphenated) b -= 1;
      let a = 0;
      if (text.length === start || text.endsWith(' ')) while (a < b && line.text[a] === ' ') a++;
      let off = 0;
      for (const piece of line.pieces) {
        const ps = off;
        off += piece.text.length;
        const from = Math.max(a, ps) - ps;
        const to = Math.min(b, off) - ps;
        if (to > from) emit(piece, from, to);
      }
      if (next && !hyphenated && !text.endsWith(' ')) text += ' ';
    });
    text = text.replace(/ +$/, '');
    if (text.length > start) blocks.push({ kind: p.kind, start, end: text.length });
    else if (blocks.length) text = text.slice(0, -BLOCK_SEPARATOR.length);
  }
  return { doc: { text, blocks, chapters: [] }, map };
}

/** Runs covering doc text [start, end): page, item and the item-local range. */
export function pdfRunsFor(map: PdfTextMap, start: number, end: number): { page: number; item: number; from: number; to: number }[] {
  const out: { page: number; item: number; from: number; to: number }[] = [];
  // Binary search for the first run that ends after `start`.
  let lo = 0;
  let hi = map.docStart.length - 1;
  let first = map.docStart.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map.docStart[mid] + map.length[mid] > start) {
      first = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  for (let r = first; r < map.docStart.length && map.docStart[r] < end; r++) {
    const s = Math.max(start, map.docStart[r]);
    const e = Math.min(end, map.docStart[r] + map.length[r]);
    if (e > s) out.push({ page: map.page[r], item: map.item[r], from: map.itemStart[r] + (s - map.docStart[r]), to: map.itemStart[r] + (e - map.docStart[r]) });
  }
  return out;
}

/** Document offset of a character in a text item, or -1 when it was not kept. */
export function pdfOffsetOf(map: PdfTextMap, page: number, item: number, offset: number): number {
  let best = -1;
  for (let r = 0; r < map.docStart.length; r++) {
    if (map.page[r] !== page || map.item[r] !== item) continue;
    const s = map.itemStart[r];
    if (offset >= s && offset < s + map.length[r]) return map.docStart[r] + (offset - s);
    if (offset >= s + map.length[r]) best = map.docStart[r] + map.length[r] - 1;
  }
  return best;
}

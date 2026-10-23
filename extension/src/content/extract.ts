// Finds what to read on a page and maps it to the page's own text nodes.
//
// "Read this page" runs Readability on a clone of the document (the live page is never touched)
// and aligns the article text with the text nodes of the original body. When Readability finds
// nothing useful, the largest block of running text is read instead. Selections and "start from
// here" read straight from the DOM, so their alignment is close to exact.

import { Readability } from '@mozilla/readability';
import { type Block, type DocText, type Word, buildDocText, cleanInline, tokenizeWords } from '../../../src/core/text';
import { htmlToBlocks } from '../../../src/docs/html';
import { type DocMapping, type IndexOptions, type TextIndex, buildTextIndex, mapText, normalizeWord } from './textmap';

export type ExtractMethod = 'readability' | 'largest-block' | 'selection' | 'from-here' | 'text';

export interface Extracted {
  title: string;
  method: ExtractMethod;
  doc: DocText;
  words: Word[];
  /** Null when the text cannot be shown on the page (e.g. a selection inside a frame). */
  mapping: DocMapping | null;
}

/** Minimum article length (characters) before Readability's result is trusted. */
const MIN_ARTICLE = 250;

function finish(title: string, method: ExtractMethod, blocks: Block[], index: TextIndex | null): Extracted | null {
  const doc = buildDocText(blocks);
  if (!doc.text.trim()) return null;
  const words = tokenizeWords(doc.text);
  if (!words.length) return null;
  return { title, method, doc, words, mapping: index ? mapText(doc.text, words, index) : null };
}

function blocksFromIndex(index: TextIndex): Block[] {
  return index.blocks.map((b) => ({ kind: b.kind, text: index.text.slice(b.start, b.end) })).filter((b) => cleanInline(b.text));
}

function pageTitle(doc: Document): string {
  return cleanInline(doc.title) || doc.location?.hostname || 'This page';
}

/** Readability on a clone of the document; null when it finds no real article. */
export function readabilityBlocks(doc: Document, exclude?: (el: Element) => boolean): { title: string; blocks: Block[] } | null {
  const clone = doc.cloneNode(true) as Document;
  if (exclude) for (const el of Array.from(clone.querySelectorAll('[data-narrata-host]'))) el.remove();
  try {
    const article = new Readability<Element>(clone, { charThreshold: MIN_ARTICLE, serializer: (el: Node) => el as Element }).parse();
    if (!article?.content || (article.textContent ?? '').trim().length < MIN_ARTICLE) return null;
    const blocks = htmlToBlocks(article.content);
    if (!blocks.length) return null;
    return { title: cleanInline(article.title ?? ''), blocks };
  } catch {
    return null;
  }
}

/** Element holding the most running text (paragraph-like text nodes), for pages Readability skips. */
export function largestTextBlock(root: Element, opts: IndexOptions = {}): Element | null {
  const scores = new Map<Element, number>();
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n as Text).data.trim();
    if (t.length < 25) continue;
    const parent = n.parentElement;
    if (!parent || opts.exclude?.(parent) || /^(script|style|noscript|template|textarea)$/i.test(parent.localName)) continue;
    // Credit the paragraph's container, so a column of many paragraphs beats one long paragraph.
    let host: Element | null = parent;
    while (host && /^(a|b|i|em|strong|span|code|small|sup|sub|mark|abbr|cite|q|u|s|time|font)$/i.test(host.localName)) host = host.parentElement;
    const container = host && /^(p|li|h[1-6]|blockquote|pre|dd|dt|figcaption)$/i.test(host.localName) ? (host.parentElement ?? host) : host;
    if (!container) continue;
    scores.set(container, (scores.get(container) ?? 0) + t.length);
  }
  let best: Element | null = null;
  let bestScore = 0;
  for (const [el, s] of scores) {
    if (s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  return bestScore >= 80 ? best : null;
}

/** Heading element on the page whose text is the article title (so it can be read and highlighted). */
function titleOnPage(doc: Document, title: string): boolean {
  if (!title) return false;
  const want = normalizeWord(cleanInline(title));
  for (const h of Array.from(doc.querySelectorAll('h1, h2, header [class*="title" i]'))) {
    if (normalizeWord(cleanInline(h.textContent ?? '')) === want) return true;
  }
  return false;
}

/** "Read this page". */
export function extractPage(doc: Document, opts: IndexOptions = {}): Extracted | null {
  const body = doc.body;
  if (!body) return null;
  const article = readabilityBlocks(doc, opts.exclude);
  if (article) {
    const index = buildTextIndex(body, opts);
    const blocks = article.blocks;
    const title = article.title || pageTitle(doc);
    const first = blocks[0] ? normalizeWord(cleanInline(blocks[0].text)) : '';
    if (first !== normalizeWord(title) && titleOnPage(doc, title)) blocks.unshift({ kind: 'h1', text: title });
    const result = finish(title, 'readability', blocks, index);
    // A result whose words are mostly not on the page would read text the user cannot follow.
    if (result && result.mapping && result.mapping.coverage >= 0.5) return result;
  }
  const block = largestTextBlock(body, opts);
  if (!block) return null;
  const index = buildTextIndex(block, opts);
  return finish(pageTitle(doc), 'largest-block', blocksFromIndex(index), index);
}

/** "Read selection": the first range of the selection, read straight from the DOM. */
export function extractSelection(doc: Document, opts: IndexOptions = {}): Extracted | null {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const root = range.commonAncestorContainer;
  const index = buildTextIndex(root.nodeType === 3 ? (root.parentNode ?? root) : root, { ...opts, clip: range });
  return finish(pageTitle(doc), 'selection', blocksFromIndex(index), index);
}

/** Plain text with no place on the page (e.g. a selection inside a frame). */
export function extractText(doc: Document, text: string): Extracted | null {
  const blocks: Block[] = text
    .split(/\n\s*\n|\r?\n/)
    .map((t) => ({ kind: 'p' as const, text: t }))
    .filter((b) => cleanInline(b.text));
  return finish(pageTitle(doc), 'text', blocks, null);
}

/**
 * "Start reading from here": the block at the given point and everything after it inside the
 * same section of the page.
 */
export function extractFrom(doc: Document, node: Node, offset: number, opts: IndexOptions = {}): Extracted | null {
  const start = node.nodeType === 3 ? node : (node.childNodes[offset] ?? node);
  const el = start.nodeType === 1 ? (start as Element) : start.parentElement;
  if (!el) return null;
  // Climb to a container that holds more than this one block of text.
  let container: Element = el;
  while (container.parentElement && container !== doc.body && (container.textContent ?? '').trim().length < 600) container = container.parentElement;
  const range = doc.createRange();
  range.setStart(node, node.nodeType === 3 ? Math.min(offset, (node as Text).length) : offset);
  range.setEnd(container, container.childNodes.length);
  const index = buildTextIndex(container, { ...opts, clip: range });
  return finish(pageTitle(doc), 'from-here', blocksFromIndex(index), index);
}

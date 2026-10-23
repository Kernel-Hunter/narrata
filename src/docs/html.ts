import { Readability } from '@mozilla/readability';
import { type Block, type BlockKind, cleanInline } from '../core/text';
import type { ParsedDoc } from './types';

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'nav', 'button', 'select', 'textarea', 'iframe', 'object', 'canvas', 'video', 'audio', 'img', 'rt', 'rp', 'head', 'title']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'li', 'ul', 'ol', 'dl', 'dd', 'dt', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'hr', 'address', 'details', 'summary', 'body', 'center', 'form', 'fieldset']);

function kindOf(tag: string): BlockKind | null {
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
      return null;
  }
}

function isFootnoteRef(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'sup' && el.querySelector('a')) return true;
  const type = el.getAttribute('epub:type') ?? el.getAttribute('role') ?? '';
  return /noteref|doc-noteref/.test(type);
}

function isFootnoteBody(el: Element): boolean {
  const type = el.getAttribute('epub:type') ?? el.getAttribute('role') ?? '';
  return /\b(footnote|endnote|rearnote|doc-footnote|doc-endnote)\b/.test(type) || el.getAttribute('hidden') !== null;
}

/** Turn an HTML/XHTML subtree into reading blocks. */
export function htmlToBlocks(root: Element): Block[] {
  const blocks: Block[] = [];
  let buf = '';
  let kind: BlockKind = 'p';
  const flush = () => {
    const text = kind === 'pre' ? buf.replace(/^\n+|\s+$/g, '') : cleanInline(buf);
    if (text) blocks.push({ kind, text });
    buf = '';
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      buf += node.nodeValue ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (SKIP.has(tag) || isFootnoteRef(el) || isFootnoteBody(el)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (tag === 'br') {
      buf += kind === 'pre' ? '\n' : ' ';
      return;
    }
    if (!BLOCK.has(tag)) {
      for (const c of Array.from(el.childNodes)) walk(c);
      return;
    }
    flush();
    const outer = kind;
    const k = kindOf(tag);
    if (k) kind = k;
    else if (tag === 'p' && outer === 'quote') kind = 'quote';
    for (const c of Array.from(el.childNodes)) walk(c);
    flush();
    kind = outer;
  };
  walk(root);
  flush();
  return blocks;
}

/** Pick the charset declared in an HTML file's first bytes (defaults to UTF-8). */
export function decodeHtml(bytes: Uint8Array): string {
  const head = new TextDecoder('ascii').decode(bytes.subarray(0, 2048));
  const cs = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]?.toLowerCase();
  try {
    return new TextDecoder(cs && cs !== 'utf8' ? cs : 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** A web page: Readability finds the article; falls back to the whole body. */
export function parseHtml(html: string, filename?: string, parser: DOMParser = new DOMParser()): ParsedDoc {
  const doc = parser.parseFromString(html, 'text/html');
  const fallbackTitle = cleanInline(doc.title) || (filename ? filename.replace(/\.[^.]+$/, '') : 'Web page');
  let blocks: Block[] = [];
  let title = fallbackTitle;
  let author: string | undefined;
  try {
    const article = new Readability(doc.cloneNode(true) as Document, { charThreshold: 200 }).parse();
    if (article?.content) {
      const content = parser.parseFromString(`<!doctype html><body>${article.content}</body>`, 'text/html');
      blocks = htmlToBlocks(content.body);
      title = cleanInline(article.title ?? '') || fallbackTitle;
      author = article.byline ? cleanInline(article.byline) : undefined;
    }
  } catch {
    // fall through to the plain body
  }
  if (blocks.length === 0) blocks = htmlToBlocks(doc.body);
  // Do not read the title twice when the article starts with it.
  if (blocks[0] && blocks[0].text === title && blocks[0].kind.startsWith('h')) blocks[0].kind = 'h1';
  else if (title) blocks.unshift({ kind: 'h1', text: title });
  return { title, author, kind: 'html', blocks, chapters: [] };
}

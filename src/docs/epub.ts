// EPUB 2/3 reader: unzip, follow container.xml to the package document, read the spine in order
// and turn each XHTML file into blocks. Chapter titles come from the EPUB 3 nav document or the
// EPUB 2 NCX, falling back to the first heading.

import { unzipSync, strFromU8 } from 'fflate';
import { type Block, type Chapter, cleanInline } from '../core/text';
import { htmlToBlocks } from './html';
import type { ParsedDoc } from './types';

function resolvePath(base: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]);
  if (clean.startsWith('/')) return clean.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function byLocalName(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName('*')).filter((e) => e.localName === name);
}

function parseXml(parser: DOMParser, text: string, type: DOMParserSupportedType = 'application/xml'): Document {
  return parser.parseFromString(text, type);
}

function parseXhtml(parser: DOMParser, text: string): Document {
  const doc = parser.parseFromString(text, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length === 0 && doc.documentElement.localName === 'html') return doc;
  return parser.parseFromString(text, 'text/html');
}

export function parseEpub(bytes: Uint8Array, filename?: string, parser: DOMParser = new DOMParser()): ParsedDoc {
  const files = unzipSync(bytes);
  const read = (path: string): string | null => {
    const f = files[path] ?? files[Object.keys(files).find((k) => k.toLowerCase() === path.toLowerCase()) ?? ''];
    return f ? strFromU8(f) : null;
  };
  const container = read('META-INF/container.xml');
  if (!container) throw new Error('This EPUB has no META-INF/container.xml.');
  const rootPath = byLocalName(parseXml(parser, container), 'rootfile')[0]?.getAttribute('full-path');
  if (!rootPath) throw new Error('This EPUB does not name its package document.');
  const opfText = read(rootPath);
  if (!opfText) throw new Error(`Missing package document ${rootPath}.`);
  const opf = parseXml(parser, opfText);

  const title = cleanInline(byLocalName(opf, 'title')[0]?.textContent ?? '') || (filename ? filename.replace(/\.[^.]+$/, '') : 'Book');
  const author = cleanInline(byLocalName(opf, 'creator')[0]?.textContent ?? '') || undefined;

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const it of byLocalName(opf, 'item')) {
    const id = it.getAttribute('id');
    const href = it.getAttribute('href');
    if (id && href) manifest.set(id, { href: resolvePath(rootPath, href), type: it.getAttribute('media-type') ?? '', props: it.getAttribute('properties') ?? '' });
  }

  // Table of contents: path -> title.
  const tocTitles = new Map<string, string>();
  const navItem = [...manifest.values()].find((m) => m.props.split(/\s+/).includes('nav'));
  if (navItem) {
    const navText = read(navItem.href);
    if (navText) {
      const nav = parseXhtml(parser, navText);
      const tocNav = byLocalName(nav, 'nav').find((n) => /toc/.test(n.getAttribute('epub:type') ?? n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '')) ?? byLocalName(nav, 'nav')[0];
      for (const a of tocNav ? byLocalName(tocNav, 'a') : []) {
        const href = a.getAttribute('href');
        const label = cleanInline(a.textContent ?? '');
        if (href && label) {
          const p = resolvePath(navItem.href, href);
          if (!tocTitles.has(p)) tocTitles.set(p, label);
        }
      }
    }
  }
  if (tocTitles.size === 0) {
    const ncxId = byLocalName(opf, 'spine')[0]?.getAttribute('toc');
    const ncxItem = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml');
    const ncxText = ncxItem ? read(ncxItem.href) : null;
    if (ncxItem && ncxText) {
      for (const np of byLocalName(parseXml(parser, ncxText), 'navPoint')) {
        const label = cleanInline(byLocalName(np, 'text')[0]?.textContent ?? '');
        const src = byLocalName(np, 'content')[0]?.getAttribute('src');
        if (label && src) {
          const p = resolvePath(ncxItem.href, src);
          if (!tocTitles.has(p)) tocTitles.set(p, label);
        }
      }
    }
  }

  const blocks: Block[] = [];
  const chapters: Chapter[] = [];
  for (const ref of byLocalName(opf, 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (!item || !/html|xml/.test(item.type)) continue;
    const xhtml = read(item.href);
    if (!xhtml) continue;
    const doc = parseXhtml(parser, xhtml);
    const body = doc.body ?? byLocalName(doc, 'body')[0];
    if (!body) continue;
    const chapterBlocks = htmlToBlocks(body);
    if (!chapterBlocks.some((b) => /[\p{L}\p{N}]/u.test(b.text))) continue;
    const heading = chapterBlocks.find((b) => b.kind.startsWith('h'))?.text;
    const chapterTitle = tocTitles.get(item.href) ?? heading ?? `Section ${chapters.length + 1}`;
    const index = chapters.length;
    chapters.push({ title: chapterTitle, block: blocks.length });
    for (const b of chapterBlocks) blocks.push({ ...b, chapter: index });
  }
  if (blocks.length === 0) throw new Error('No readable text found in this EPUB.');
  return { title, author, kind: 'epub', blocks, chapters };
}

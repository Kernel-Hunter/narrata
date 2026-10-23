import { buildDocText } from '../core/text';
import { parseEpub } from './epub';
import { decodeHtml, parseHtml } from './html';
import { parseMarkdown } from './markdown';
import { extractPdf, loadPdfJs } from './pdf';
import { parseTxt } from './txt';
import type { DocKind, LoadedDoc, ParsedDoc } from './types';

export const ACCEPT = '.txt,.text,.md,.markdown,.pdf,.epub,.html,.htm,.xhtml,text/plain,text/markdown,text/html,application/pdf,application/epub+zip';

export function detectKind(name: string, type = ''): DocKind | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (ext === 'epub' || type === 'application/epub+zip') return 'epub';
  if (['md', 'markdown', 'mdown', 'mkd'].includes(ext) || type === 'text/markdown') return 'markdown';
  if (['html', 'htm', 'xhtml'].includes(ext) || type === 'text/html') return 'html';
  if (['txt', 'text'].includes(ext) || type.startsWith('text/')) return 'text';
  return null;
}

export function fromParsed(p: ParsedDoc): LoadedDoc {
  return { title: p.title, author: p.author, kind: p.kind, doc: buildDocText(p.blocks, p.chapters) };
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export async function loadFile(file: File, onProgress?: (done: number, total: number) => void): Promise<LoadedDoc> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let kind = detectKind(file.name, file.type);
  if (!kind) {
    // Unknown extension: accept it if it looks like text.
    const head = bytes.subarray(0, 4096);
    if (head.includes(0)) throw new Error(`Narrata can't read "${file.name}". Try a PDF, EPUB, web page, Markdown or text file.`);
    kind = 'text';
  }
  switch (kind) {
    case 'pdf':
      return extractPdf(await loadPdfJs(), bytes.buffer as ArrayBuffer, file.name, onProgress);
    case 'epub':
      return fromParsed(parseEpub(bytes, file.name));
    case 'html':
      return fromParsed(parseHtml(decodeHtml(bytes), file.name));
    case 'markdown':
      return fromParsed(parseMarkdown(decodeText(bytes), file.name));
    default:
      return fromParsed(parseTxt(decodeText(bytes), file.name));
  }
}

export function loadPastedText(text: string, title?: string): LoadedDoc {
  const looksMarkdown = /^#{1,6}\s|\n#{1,6}\s|\*\*\w|\]\(https?:/.test(text);
  const parsed = looksMarkdown ? parseMarkdown(text) : parseTxt(text);
  if (title) parsed.title = title;
  else if (!looksMarkdown || parsed.title === 'Untitled') {
    const first = parsed.blocks[0]?.text ?? '';
    parsed.title = first.length <= 70 ? first.replace(/[.:;,]+$/, '') : first.slice(0, 60).replace(/\s+\S*$/, '') + '…';
  }
  return fromParsed(parsed);
}

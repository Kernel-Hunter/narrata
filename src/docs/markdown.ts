import { type Block, type BlockKind, cleanInline } from '../core/text';
import type { ParsedDoc } from './types';

/** Remove inline Markdown syntax, keeping the words a reader would say. */
export function stripInline(s: string): string {
  // Protect escaped characters from the emphasis rules, restore them at the end.
  const escaped: string[] = [];
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_, c: string) => `\u0000${escaped.push(c) - 1}\u0000`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images -> alt text
    .replace(/\[\^[^\]]+\]/g, '') // footnote references
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // inline links
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1') // reference links
    .replace(/<(https?:[^>\s]+)>/g, '$1') // autolinks
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // inline HTML
    .replace(/`+([^`]+?)`+/g, '$1') // code spans
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2') // *em*
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1$2') // _em_
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1') // strikethrough
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => escaped[Number(i)]);
}

export function parseMarkdown(raw: string, filename?: string): ParsedDoc {
  let src = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  // YAML front matter.
  let fmTitle: string | undefined;
  const fm = src.match(/^---\n([\s\S]*?)\n(---|\.\.\.)\n/);
  if (fm) {
    fmTitle = fm[1].match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
    src = src.slice(fm[0].length);
  }
  const lines = src.split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let paraKind: BlockKind = 'p';
  const flush = () => {
    const text = cleanInline(stripInline(para.join(' ')));
    if (text) blocks.push({ kind: paraKind, text });
    para = [];
    paraKind = 'p';
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      // Code blocks are not read aloud.
      flush();
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) i++;
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const atx = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (atx) {
      flush();
      const level = atx[1].length;
      blocks.push({ kind: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3', text: cleanInline(stripInline(atx[2])) });
      continue;
    }
    const next = lines[i + 1] ?? '';
    if (para.length === 0 && line.trim() && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*([-*+]|\d+[.)])\s/.test(line)) {
      blocks.push({ kind: next.trim().startsWith('=') ? 'h1' : 'h2', text: cleanInline(stripInline(line)) });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      continue;
    }
    if (/^\s{0,3}\[[^\]]+\]:\s*\S+/.test(line)) continue; // link reference definitions
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue; // table separator
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      if (paraKind !== 'quote') flush();
      paraKind = 'quote';
      if (quote[1].trim()) para.push(quote[1]);
      else flush();
      continue;
    }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/);
    if (item) {
      flush();
      paraKind = 'li';
      para.push(item[1]);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      // Table row: read cells separated by commas.
      flush();
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean);
      blocks.push({ kind: 'p', text: cleanInline(stripInline(cells.join(', '))) });
      continue;
    }
    if (paraKind === 'quote') flush();
    para.push(line.replace(/^\s{4,}/, ''));
  }
  flush();
  const h1 = blocks.find((b) => b.kind === 'h1')?.text;
  const title = fmTitle ?? h1 ?? (filename ? filename.replace(/\.[^.]+$/, '') : 'Untitled');
  return { title, kind: 'markdown', blocks, chapters: [] };
}

import { type Block, cleanInline, titleFromText } from '../core/text';
import type { ParsedDoc } from './types';

const HEADING_LINE = /^(chapter|part|book|section|prologue|epilogue|preface|introduction|appendix)\b[\s\w.:'-]{0,50}$/i;

function looksLikeHeading(p: string): boolean {
  if (p.length > 70 || /[.,;!?]$/.test(p)) return false;
  if (HEADING_LINE.test(p)) return true;
  const letters = p.replace(/[^\p{L}]/gu, '');
  return letters.length >= 3 && letters === letters.toUpperCase() && /\p{Lu}/u.test(letters);
}

/** Plain text: paragraphs separated by blank lines; hard-wrapped lines are joined. */
export function parseTxt(raw: string, filename?: string): ParsedDoc {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const hasBlankLines = /\n[ \t]*\n/.test(text.trim());
  const paragraphs = hasBlankLines ? text.split(/\n[ \t]*\n+/) : text.split('\n');
  const blocks: Block[] = [];
  for (const p of paragraphs) {
    const clean = cleanInline(p);
    if (!clean) continue;
    blocks.push({ kind: looksLikeHeading(clean) ? 'h2' : 'p', text: clean });
  }
  const title = filename ? filename.replace(/\.[^.]+$/, '') : titleFromText(text);
  return { title: title || 'Untitled', kind: 'text', blocks, chapters: [] };
}

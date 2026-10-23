import type { Block, Chapter, DocText } from '../core/text';

export type DocKind = 'text' | 'markdown' | 'html' | 'pdf' | 'epub';

export interface ParsedDoc {
  title: string;
  author?: string;
  kind: DocKind;
  blocks: Block[];
  chapters: Chapter[];
}

/**
 * Maps document text back to pdf.js text items, so a word can be highlighted on the rendered
 * page. Each run is a stretch of document text copied from one text item.
 * Arrays are parallel (struct of arrays keeps IndexedDB records small).
 */
export interface PdfTextMap {
  docStart: number[];
  page: number[];
  item: number[];
  itemStart: number[];
  length: number[];
}

export interface PdfPageSize {
  width: number;
  height: number;
}

export interface LoadedDoc {
  title: string;
  author?: string;
  kind: DocKind;
  doc: DocText;
  /** Original file bytes for formats rendered from the source (PDF). */
  source?: ArrayBuffer;
  pdfMap?: PdfTextMap;
  pdfPages?: PdfPageSize[];
}

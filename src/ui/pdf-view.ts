// PDF page view: pages render lazily (canvas + pdf.js text layer); highlights are drawn from DOM
// Ranges over the text layer, so they sit exactly on the words of the rendered page.

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Span } from '../core/chunker';
import { type DocText, type Word, tokenizeWords, wordIndexAt } from '../core/text';
import { pdfOffsetOf, pdfRunsFor } from '../docs/pdf-text';
import { loadPdfJs } from '../docs/pdf';
import type { PdfPageSize, PdfTextMap } from '../docs/types';
import { h } from './dom';
import { BoxLayer, caretAt, rangeBoxes, type Box } from './highlight';
import type { DocView, SeekHandler } from './views';

interface PageState {
  el: HTMLElement;
  canvas: HTMLCanvasElement;
  textLayer: HTMLElement;
  hl: HTMLElement;
  sentence: BoxLayer;
  word: HTMLElement;
  textDivs: HTMLElement[] | null;
  rendering: Promise<void> | null;
  renderedScale: number;
}

const MAX_RENDERED = 12;

export class PdfView implements DocView {
  readonly el: HTMLElement;
  private pages: PageState[] = [];
  private pdf: PDFDocumentProxy | null = null;
  private task: { destroy(): Promise<void> } | null = null;
  private io: IntersectionObserver;
  private ro: ResizeObserver;
  private word: Word | null = null;
  private sentence: Span | null = null;
  private words: Word[];
  private renderedOrder: number[] = [];
  private width = 0;
  private ready: Promise<void>;

  constructor(
    doc: DocText,
    private readonly map: PdfTextMap,
    private readonly sizes: PdfPageSize[],
    private readonly source: ArrayBuffer,
    private readonly onSeek: SeekHandler,
  ) {
    this.words = tokenizeWords(doc.text);
    this.el = h('div', { class: 'pdf-view', role: 'document', 'aria-label': 'PDF pages' });
    sizes.forEach((size, i) => {
      const canvas = h('canvas', { class: 'pdf-canvas', 'aria-hidden': 'true' });
      const textLayer = h('div', { class: 'textLayer' });
      const hl = h('div', { class: 'pdf-hl', 'aria-hidden': 'true' });
      const word = h('div', { class: 'hl-word pdf-word' });
      hl.append(word);
      const el = h('div', { class: 'pdf-page', 'data-page': i, 'aria-label': `Page ${i + 1}` }, canvas, hl, textLayer);
      el.style.aspectRatio = `${size.width} / ${size.height}`;
      textLayer.addEventListener('click', (e) => this.onClick(e, i));
      this.el.append(el);
      this.pages.push({ el, canvas, textLayer, hl, sentence: new BoxLayer(hl, 'hl-sentence'), word, textDivs: null, rendering: null, renderedScale: 0 });
    });
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) void this.renderPage(Number((e.target as HTMLElement).dataset.page));
    }, { rootMargin: '1200px 0px' });
    this.pages.forEach((p) => this.io.observe(p.el));
    this.ro = new ResizeObserver(() => {
      const w = this.el.clientWidth;
      if (Math.abs(w - this.width) > 2) {
        this.width = w;
        this.rescale();
      }
    });
    this.ro.observe(this.el);
    this.ready = (async () => {
      const pdfjs = await loadPdfJs();
      const task = pdfjs.getDocument({ data: new Uint8Array(this.source.slice(0)) });
      this.task = task;
      this.pdf = await task.promise;
    })();
  }

  private computeScale(i: number): number {
    const w = this.el.clientWidth || 800;
    return w / this.sizes[i].width;
  }

  private rescale() {
    // Re-render visible pages at the new width; others re-render when they scroll into view.
    for (const p of this.pages) {
      if (p.textDivs) {
        p.renderedScale = 0;
        const i = this.pages.indexOf(p);
        void this.renderPage(i, true);
      }
    }
  }

  private async renderPage(i: number, force = false): Promise<void> {
    const p = this.pages[i];
    if (!p) return;
    if (p.rendering && !force) return p.rendering;
    const run = async () => {
      await this.ready;
      const scale = this.computeScale(i);
      if (!force && p.textDivs && Math.abs(p.renderedScale - scale) < 0.01) return;
      const pdfjs = await loadPdfJs();
      const page: PDFPageProxy = await this.pdf!.getPage(i + 1);
      const vp = page.getViewport({ scale });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      p.canvas.width = Math.floor(vp.width * dpr);
      p.canvas.height = Math.floor(vp.height * dpr);
      p.el.style.setProperty('--scale-factor', String(scale));
      p.el.style.setProperty('--total-scale-factor', String(scale));
      await page.render({ canvas: p.canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      const tc = await page.getTextContent();
      p.textLayer.replaceChildren();
      const layer = new pdfjs.TextLayer({ textContentSource: tc, container: p.textLayer, viewport: vp });
      await layer.render();
      p.textDivs = layer.textDivs;
      p.renderedScale = scale;
      this.track(i);
      this.drawPage(i);
    };
    p.rendering = run().finally(() => (p.rendering = null));
    return p.rendering;
  }

  /** Keep a bounded number of rendered pages (canvases use a lot of memory). */
  private track(i: number) {
    this.renderedOrder = this.renderedOrder.filter((x) => x !== i);
    this.renderedOrder.push(i);
    const current = this.word ? pdfRunsFor(this.map, this.word.start, this.word.end)[0]?.page : -1;
    while (this.renderedOrder.length > MAX_RENDERED) {
      const idx = this.renderedOrder.findIndex((x) => Math.abs(x - (current ?? i)) > 2);
      const victim = this.renderedOrder.splice(idx < 0 ? 0 : idx, 1)[0];
      const p = this.pages[victim];
      p.canvas.width = 0;
      p.canvas.height = 0;
      p.textLayer.replaceChildren();
      p.textDivs = null;
      p.renderedScale = 0;
    }
  }

  private onClick(e: MouseEvent, page: number) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const c = caretAt(e.clientX, e.clientY);
    const p = this.pages[page];
    if (!c || !p.textDivs) return;
    const span = (c.node instanceof Text ? c.node.parentElement : (c.node as HTMLElement))?.closest('span');
    const item = span ? p.textDivs.indexOf(span as HTMLElement) : -1;
    if (item < 0) return;
    const off = pdfOffsetOf(this.map, page, item, c.node instanceof Text ? c.offset : 0);
    if (off < 0) return;
    const w = this.words[wordIndexAt(this.words, off)];
    if (w) this.onSeek(w.start);
  }

  /** Ranges over the text layer for doc text [start, end), grouped by page. */
  private rangesFor(start: number, end: number): Map<number, Range[]> {
    const out = new Map<number, Range[]>();
    for (const run of pdfRunsFor(this.map, start, end)) {
      const p = this.pages[run.page];
      const div = p?.textDivs?.[run.item];
      const node = div?.firstChild;
      if (!(node instanceof Text)) continue;
      const r = document.createRange();
      r.setStart(node, Math.min(run.from, node.length));
      r.setEnd(node, Math.min(run.to, node.length));
      const list = out.get(run.page) ?? [];
      list.push(r);
      out.set(run.page, list);
    }
    return out;
  }

  private boxesOn(page: number, ranges: Range[]): Box[] {
    const origin = this.pages[page].el.getBoundingClientRect();
    return ranges.flatMap((r) => rangeBoxes(r, origin));
  }

  private drawPage(i: number) {
    const p = this.pages[i];
    const s = this.sentence ? this.rangesFor(this.sentence.start, this.sentence.end).get(i) : undefined;
    p.sentence.draw(s ? this.boxesOn(i, s) : [], { x: 2, y: 1 });
    const w = this.word ? this.rangesFor(this.word.start, this.word.end).get(i) : undefined;
    const boxes = w ? this.boxesOn(i, w) : [];
    if (!boxes.length) {
      p.word.style.opacity = '0';
      return;
    }
    const x1 = Math.min(...boxes.map((b) => b.x));
    const y1 = Math.min(...boxes.map((b) => b.y));
    const x2 = Math.max(...boxes.map((b) => b.x + b.w));
    const y2 = Math.max(...boxes.map((b) => b.y + b.h));
    p.word.style.opacity = '1';
    p.word.style.transform = `translate(${x1 - 2}px, ${y1 - 1}px)`;
    p.word.style.width = `${x2 - x1 + 4}px`;
    p.word.style.height = `${y2 - y1 + 2}px`;
  }

  private pagesOf(span: Span | null): Set<number> {
    return new Set(span ? pdfRunsFor(this.map, span.start, span.end).map((r) => r.page) : []);
  }

  highlight(word: Word | null, sentence: Span | null): void {
    const before = new Set([...this.pagesOf(this.word), ...this.pagesOf(this.sentence)]);
    this.word = word;
    this.sentence = sentence;
    const after = new Set([...this.pagesOf(word), ...this.pagesOf(sentence)]);
    for (const i of new Set([...before, ...after])) {
      if (this.pages[i]?.textDivs) this.drawPage(i);
    }
  }

  rectFor(offset: number): DOMRect | null {
    const w = this.words[wordIndexAt(this.words, offset)];
    if (!w) return null;
    for (const [, ranges] of this.rangesFor(w.start, w.end)) {
      const rect = ranges[0]?.getClientRects()[0];
      if (rect) return rect;
    }
    // Page not rendered yet: use the page box so scrolling still lands nearby.
    const page = pdfRunsFor(this.map, w.start, w.end)[0]?.page;
    return page !== undefined ? this.pages[page].el.getBoundingClientRect() : null;
  }

  async ensureVisible(offset: number): Promise<void> {
    const w = this.words[wordIndexAt(this.words, offset)];
    const page = w ? pdfRunsFor(this.map, w.start, w.end)[0]?.page : undefined;
    if (page !== undefined) await this.renderPage(page);
  }

  relayout(): void {
    for (let i = 0; i < this.pages.length; i++) if (this.pages[i].textDivs) this.drawPage(i);
  }

  destroy(): void {
    this.io.disconnect();
    this.ro.disconnect();
    void this.task?.destroy();
    this.el.remove();
  }
}

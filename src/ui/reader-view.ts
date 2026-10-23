// Reflowed reading view: one element per block, each holding exactly the block's text, so a
// document offset maps to (text node, offset) without wrapping words in elements.

import type { Span } from '../core/chunker';
import { type BlockKind, type DocText, type Word, blockAt, tokenizeWords, wordIndexAt } from '../core/text';
import { BoxLayer, caretAt, rangeBoxes } from './highlight';
import { h } from './dom';
import type { DocView, SeekHandler } from './views';

const TAG: Record<BlockKind, keyof HTMLElementTagNameMap> = {
  h1: 'h2',
  h2: 'h3',
  h3: 'h4',
  p: 'p',
  li: 'p',
  quote: 'blockquote',
  pre: 'pre',
};

export class ReaderView implements DocView {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private blockEls: HTMLElement[] = [];
  private sentenceLayer: BoxLayer;
  private wordEl: HTMLElement;
  private hoverEl: HTMLElement;
  private word: Word | null = null;
  private sentence: Span | null = null;
  private lastWordY = -1;
  private words: Word[];
  private hoverRaf = 0;
  private ro: ResizeObserver;

  constructor(
    private readonly doc: DocText,
    meta: { title: string; author?: string; subtitle?: string },
    private readonly onSeek: SeekHandler,
  ) {
    this.words = tokenizeWords(doc.text);
    const layer = h('div', { class: 'hl-layer', 'aria-hidden': 'true' });
    this.sentenceLayer = new BoxLayer(layer, 'hl-sentence');
    this.hoverEl = h('div', { class: 'hl-hover' });
    this.wordEl = h('div', { class: 'hl-word' });
    layer.append(this.hoverEl, this.wordEl);
    const blocks = h('div', { class: 'blocks' });
    let chapter = -1;
    doc.blocks.forEach((b, i) => {
      if (b.chapter !== undefined && b.chapter !== chapter) {
        chapter = b.chapter;
        if (i > 0) blocks.append(h('hr', { class: 'chapter-break', 'aria-hidden': 'true' }));
      }
      const el = h(TAG[b.kind], { class: `b b-${b.kind}`, 'data-b': i });
      el.textContent = doc.text.slice(b.start, b.end);
      if (b.chapter !== undefined && doc.chapters[b.chapter]?.block === i) el.id = `chapter-${b.chapter}`;
      blocks.append(el);
      this.blockEls.push(el);
    });
    const firstText = doc.blocks[0] ? doc.text.slice(doc.blocks[0].start, doc.blocks[0].end) : '';
    const showTitle = firstText.trim() !== meta.title.trim();
    this.body = h('div', { class: 'reader-body' }, layer, blocks);
    this.el = h(
      'article',
      { class: 'reader', lang: 'en', 'aria-label': meta.title },
      h(
        'header',
        { class: 'doc-head' },
        meta.subtitle ? h('p', { class: 'doc-kicker' }, meta.subtitle) : null,
        showTitle ? h('h1', { class: 'doc-title' }, meta.title) : null,
        meta.author ? h('p', { class: 'doc-author' }, meta.author) : null,
      ),
      this.body,
    );
    blocks.addEventListener('click', (e) => this.onClick(e));
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      blocks.addEventListener('mousemove', (e) => this.onHover(e));
      blocks.addEventListener('mouseleave', () => (this.hoverEl.style.opacity = '0'));
    }
    this.ro = new ResizeObserver(() => this.relayout());
    this.ro.observe(this.body);
  }

  private textPos(offset: number): { node: Text; local: number } | null {
    const bi = blockAt(this.doc, offset);
    const b = this.doc.blocks[bi];
    const node = this.blockEls[bi]?.firstChild;
    if (!b || !(node instanceof Text)) return null;
    return { node, local: Math.max(0, Math.min(node.length, offset - b.start)) };
  }

  private range(start: number, end: number): Range | null {
    const a = this.textPos(start);
    const b = this.textPos(Math.max(start, end));
    if (!a || !b) return null;
    const r = document.createRange();
    r.setStart(a.node, a.local);
    r.setEnd(b.node, b.local);
    return r;
  }

  private offsetFromPoint(x: number, y: number): number | null {
    const c = caretAt(x, y);
    if (!c || !(c.node instanceof Text)) return null;
    const blockEl = c.node.parentElement?.closest('[data-b]') as HTMLElement | null;
    if (!blockEl || !this.body.contains(blockEl)) return null;
    const b = this.doc.blocks[Number(blockEl.dataset.b)];
    return b.start + c.offset;
  }

  private onClick(e: MouseEvent) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const off = this.offsetFromPoint(e.clientX, e.clientY);
    if (off === null) return;
    const w = this.words[wordIndexAt(this.words, off)];
    if (w) this.onSeek(w.start);
  }

  private onHover(e: MouseEvent) {
    cancelAnimationFrame(this.hoverRaf);
    this.hoverRaf = requestAnimationFrame(() => {
      const off = this.offsetFromPoint(e.clientX, e.clientY);
      const w = off === null ? null : this.words[wordIndexAt(this.words, off)];
      const r = w && off !== null && off >= w.start - 1 && off <= w.end + 1 ? this.range(w.start, w.end) : null;
      const box = r ? rangeBoxes(r, this.body.getBoundingClientRect())[0] : null;
      if (!box) {
        this.hoverEl.style.opacity = '0';
        return;
      }
      this.hoverEl.style.opacity = '1';
      this.hoverEl.style.transform = `translate(${box.x - 3}px, ${box.y + box.h - 2}px)`;
      this.hoverEl.style.width = `${box.w + 6}px`;
    });
  }

  highlight(word: Word | null, sentence: Span | null): void {
    const sentenceChanged = sentence?.start !== this.sentence?.start || sentence?.end !== this.sentence?.end;
    this.word = word;
    this.sentence = sentence;
    if (sentenceChanged) this.drawSentence();
    this.drawWord();
  }

  private drawSentence() {
    const s = this.sentence;
    const r = s ? this.range(s.start, s.end) : null;
    if (!r) return this.sentenceLayer.clear();
    this.sentenceLayer.draw(rangeBoxes(r, this.body.getBoundingClientRect()), { x: 4, y: 2 });
  }

  private drawWord() {
    const w = this.word;
    const r = w ? this.range(w.start, w.end) : null;
    const box = r ? rangeBoxes(r, this.body.getBoundingClientRect())[0] : null;
    if (!box) {
      this.wordEl.style.opacity = '0';
      this.lastWordY = -1;
      return;
    }
    // Glide along a line; jump when the word moves to another line.
    const jump = Math.abs(box.y - this.lastWordY) > 2;
    this.wordEl.classList.toggle('no-anim', jump);
    if (jump) void this.wordEl.offsetWidth;
    this.wordEl.style.opacity = '1';
    this.wordEl.style.transform = `translate(${box.x - 3}px, ${box.y - 1}px)`;
    this.wordEl.style.width = `${box.w + 6}px`;
    this.wordEl.style.height = `${box.h + 2}px`;
    this.lastWordY = box.y;
  }

  rectFor(offset: number): DOMRect | null {
    const w = this.words[wordIndexAt(this.words, offset)];
    const r = w ? this.range(w.start, w.end) : this.range(offset, offset);
    const rects = r?.getClientRects();
    return rects && rects.length ? rects[0] : null;
  }

  async ensureVisible(): Promise<void> {
    // Text is always laid out.
  }

  relayout(): void {
    this.drawSentence();
    this.lastWordY = -1;
    this.drawWord();
  }

  destroy(): void {
    this.ro.disconnect();
    this.el.remove();
  }
}

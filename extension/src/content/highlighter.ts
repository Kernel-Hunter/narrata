// Paints the current word and sentence on the page.
//
// The CSS Custom Highlight API (Chrome 105+, Safari 17.2+, Firefox 140+) paints Ranges without
// changing the DOM, so the page's own scripts and styles never see Narrata. Where it is missing,
// boxes are drawn in a fixed layer inside the player's shadow root instead.

import { BoxLayer, rangeBoxes } from '../../../src/ui/highlight';

type HighlightCtor = new (...ranges: Range[]) => { clear(): void; add(r: Range): void };

export class PageHighlighter {
  private readonly native: boolean;
  private word: InstanceType<HighlightCtor> | null = null;
  private sentence: InstanceType<HighlightCtor> | null = null;
  private boxes: { word: BoxLayer; sentence: BoxLayer } | null = null;
  private current: { word: Range | null; sentence: Range | null } = { word: null, sentence: null };
  private raf = 0;

  constructor(fallbackLayer: HTMLElement) {
    const H = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
    const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    this.native = !!H && !!registry;
    if (this.native) {
      this.word = new H!();
      this.sentence = new H!();
      registry!.set('narrata-sentence', this.sentence);
      registry!.set('narrata-word', this.word);
    } else {
      this.boxes = { sentence: new BoxLayer(fallbackLayer, 'hl-sentence'), word: new BoxLayer(fallbackLayer, 'hl-word') };
      addEventListener('scroll', this.onScroll, { passive: true, capture: true });
      addEventListener('resize', this.onScroll, { passive: true });
    }
  }

  get usesHighlightApi(): boolean {
    return this.native;
  }

  show(word: Range | null, sentence: Range | null): void {
    this.current = { word, sentence };
    if (this.native) {
      this.word!.clear();
      this.sentence!.clear();
      if (word) this.word!.add(word);
      if (sentence) this.sentence!.add(sentence);
      return;
    }
    this.draw();
  }

  clear(): void {
    this.show(null, null);
  }

  dispose(): void {
    this.clear();
    if (this.native) {
      const registry = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
      if (registry.get('narrata-word') === this.word) registry.delete('narrata-word');
      if (registry.get('narrata-sentence') === this.sentence) registry.delete('narrata-sentence');
    } else {
      removeEventListener('scroll', this.onScroll, { capture: true });
      removeEventListener('resize', this.onScroll);
    }
  }

  private onScroll = () => {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  };

  private draw(): void {
    if (!this.boxes) return;
    const origin = new DOMRect(0, 0, 0, 0);
    this.boxes.sentence.draw(this.current.sentence ? rangeBoxes(this.current.sentence, origin) : [], { x: 2, y: 1 });
    this.boxes.word.draw(this.current.word ? rangeBoxes(this.current.word, origin) : [], { x: 2, y: 1 });
  }
}

// Highlight overlays drawn behind the text. Using rectangles from DOM Ranges means the text
// never has to be split into one element per word, which keeps long books fast.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Client rects of a range, relative to `origin`, merged into one box per line. */
export function rangeBoxes(range: Range, origin: DOMRect): Box[] {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
  const lines: Box[] = [];
  for (const r of rects) {
    const box = { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
    const same = lines.find((l) => Math.abs(l.y + l.h / 2 - (box.y + box.h / 2)) < Math.min(l.h, box.h) * 0.5);
    if (same) {
      const x1 = Math.min(same.x, box.x);
      const x2 = Math.max(same.x + same.w, box.x + box.w);
      const y1 = Math.min(same.y, box.y);
      const y2 = Math.max(same.y + same.h, box.y + box.h);
      Object.assign(same, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });
    } else lines.push(box);
  }
  return lines;
}

/** A pool of absolutely positioned boxes inside a layer element. */
export class BoxLayer {
  private els: HTMLElement[] = [];

  constructor(
    private readonly layer: HTMLElement,
    private readonly className: string,
  ) {}

  draw(boxes: Box[], pad = { x: 0, y: 0 }): void {
    while (this.els.length < boxes.length) {
      const el = document.createElement('div');
      el.className = this.className;
      this.layer.append(el);
      this.els.push(el);
    }
    this.els.forEach((el, i) => {
      const b = boxes[i];
      if (!b) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.transform = `translate(${b.x - pad.x}px, ${b.y - pad.y}px)`;
      el.style.width = `${b.w + pad.x * 2}px`;
      el.style.height = `${b.h + pad.y * 2}px`;
    });
  }

  clear(): void {
    this.draw([]);
  }
}

/** Caret position (text node + offset) under a point, across browsers. */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

// Keeps the word being read in view without fighting the reader.
//
// The page scrolls only when the word leaves a comfortable band (it then glides so the word sits
// about a third of the way down). As soon as the user scrolls by hand (wheel, touch, keyboard or
// scrollbar), following stops until they press "Back to current".

const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ']);

function scrollParent(el: Element | null): Element | null {
  for (let e = el?.parentElement ?? null; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (/(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 4) return e;
  }
  return null;
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName ?? ''));
}

export class Follower {
  following = true;
  private dragging = false;
  private listeners: [EventTarget, string, EventListener, AddEventListenerOptions][] = [];

  constructor(
    private readonly isOwnElement: (t: EventTarget | null) => boolean,
    private readonly onChange: (following: boolean) => void,
    /** Height kept clear at the bottom of the viewport (the player). */
    private readonly bottomInset: () => number,
  ) {
    const stop = (e: Event) => {
      if (this.isOwnElement(e.target)) return;
      this.set(false);
    };
    this.on(window, 'wheel', stop, { passive: true, capture: true });
    this.on(window, 'touchmove', stop, { passive: true, capture: true });
    this.on(window, 'keydown', ((e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key) || isEditable(e.target) || this.isOwnElement(e.target)) return;
      this.set(false);
    }) as EventListener, { capture: true });
    // Dragging a scrollbar fires no input event on the page, only mousedown then scroll.
    this.on(window, 'mousedown', ((e: MouseEvent) => {
      if (!this.isOwnElement(e.target)) this.dragging = true;
    }) as EventListener, { capture: true });
    this.on(window, 'mouseup', () => (this.dragging = false), { capture: true });
    this.on(window, 'scroll', () => {
      if (this.dragging) this.set(false);
    }, { passive: true, capture: true });
  }

  private on(t: EventTarget, type: string, fn: EventListener, opts: AddEventListenerOptions) {
    t.addEventListener(type, fn, opts);
    this.listeners.push([t, type, fn, opts]);
  }

  set(following: boolean): void {
    if (following === this.following) return;
    this.following = following;
    this.onChange(following);
  }

  /** Scroll gently if the range is outside the comfortable band. */
  follow(range: Range, force = false): void {
    if (!this.following && !force) return;
    const rect = range.getBoundingClientRect();
    if (!rect.height && !rect.width) return;
    const el = range.startContainer.parentElement;
    const scroller = scrollParent(el);
    const smooth = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    let top = 0;
    let height = innerHeight - this.bottomInset();
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      top = Math.max(0, r.top);
      height = Math.min(r.bottom, height) - top;
    }
    const y = rect.top - top;
    if (!force && y > height * 0.12 && rect.bottom - top < height * 0.78) return;
    const delta = y - height * 0.32;
    if (Math.abs(delta) < 4) return;
    if (scroller) scroller.scrollBy({ top: delta, behavior: smooth });
    else window.scrollBy({ top: delta, behavior: smooth });
  }

  dispose(): void {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
  }
}

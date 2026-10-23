// Popovers (light-dismiss menus anchored to a button), modal sheets and toasts.

import { h } from './dom';
import { icons } from './icons';

export class Popover {
  readonly el: HTMLElement;
  private anchor: HTMLElement | null = null;
  private focusOnClose: HTMLElement | null = null;

  constructor(label: string, private readonly build: (pop: Popover) => Node[]) {
    this.el = h('div', { class: 'pop', popover: 'auto', role: 'dialog', 'aria-label': label });
    document.body.append(this.el);
    this.el.addEventListener('toggle', (e) => {
      const open = (e as ToggleEvent).newState === 'open';
      this.anchor?.setAttribute('aria-expanded', String(open));
      if (open) return;
      (this.focusOnClose ?? this.anchor)?.focus({ preventScroll: true });
      this.focusOnClose = null;
    });
  }

  get open(): boolean {
    return this.el.matches(':popover-open');
  }

  toggle(anchor: HTMLElement): void {
    if (this.open) {
      this.el.hidePopover();
      return;
    }
    this.anchor = anchor;
    this.render();
    this.el.showPopover();
    this.position();
    const first = this.el.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"], button, input');
    first?.focus({ preventScroll: true });
  }

  render(): void {
    const scroll = this.el.scrollTop;
    // Keep keyboard focus on the same control across re-renders.
    const focusables = () => [...this.el.querySelectorAll<HTMLElement>('button, input')];
    const focused = focusables().indexOf(document.activeElement as HTMLElement);
    this.el.replaceChildren(...this.build(this));
    this.el.scrollTop = scroll;
    if (focused >= 0) focusables()[focused]?.focus({ preventScroll: true });
  }

  /** Close the menu; focus returns to its button unless another target is given. */
  hide(focusTo: HTMLElement | null = null): void {
    this.focusOnClose = focusTo;
    if (this.open) this.el.hidePopover();
  }

  private position(): void {
    if (!this.anchor) return;
    const a = this.anchor.getBoundingClientRect();
    const p = this.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = a.top < vh / 2;
    let left = a.left + a.width / 2 - p.width / 2;
    left = Math.max(12, Math.min(vw - p.width - 12, left));
    const top = below ? a.bottom + 8 : Math.max(12, a.top - p.height - 10);
    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.min(top, vh - p.height - 12)}px`;
  }
}

/** A modal sheet built on <dialog> (focus trap and Escape come for free). */
export function sheet(title: string, body: Node[], opts: { onClose?: () => void; closable?: boolean } = {}): { dialog: HTMLDialogElement; close: () => void } {
  const dialog = h('dialog', { class: 'sheet', 'aria-label': title });
  const close = () => dialog.close();
  dialog.append(
    h('div', { class: 'sheet-body' }, h('h2', { class: 'sheet-title' }, title), ...body),
    opts.closable === false ? '' : h('button', { class: 'icon-btn sheet-close', 'aria-label': 'Close', html: icons.close, onclick: close }),
  );
  if (opts.closable === false) dialog.addEventListener('cancel', (e) => e.preventDefault());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && opts.closable !== false) close();
  });
  dialog.addEventListener('close', () => {
    opts.onClose?.();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

let region: HTMLElement | null = null;

export function toast(message: string, opts: { action?: string; onAction?: () => void; error?: boolean; ms?: number } = {}): void {
  region ??= document.body.appendChild(h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' }));
  const el = h('div', { class: `toast${opts.error ? ' error' : ''}` }, h('span', { class: 'grow' }, message));
  const remove = () => el.remove();
  if (opts.action) {
    el.append(
      h('button', {
        onclick: () => {
          opts.onAction?.();
          remove();
        },
      }, opts.action),
    );
  }
  region.append(el);
  setTimeout(remove, opts.ms ?? (opts.action ? 6000 : 3500));
}

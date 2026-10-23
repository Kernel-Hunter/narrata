import type { Span } from '../core/chunker';
import type { Word } from '../core/text';

/** What the app needs from a document view (reflowed text or rendered PDF pages). */
export interface DocView {
  readonly el: HTMLElement;
  /** Highlight the word being read and tint its sentence. */
  highlight(word: Word | null, sentence: Span | null): void;
  /** Viewport rectangle of the text at an offset (null when not rendered). */
  rectFor(offset: number): DOMRect | null;
  /** Make sure the text at `offset` is rendered/laid out (PDF pages render lazily). */
  ensureVisible(offset: number): Promise<void>;
  /** Redraw highlights after layout changes. */
  relayout(): void;
  destroy(): void;
}

export type SeekHandler = (offset: number) => void;

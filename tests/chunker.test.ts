import { describe, expect, it } from 'vitest';
import { MAX_CHUNK_CHARS, RAMP_CHARS, chunksFrom, mergeChunks, splitAtClauses, documentSentences, planChunks, splitHead, splitLong, splitSentences } from '../src/core/chunker';
import { buildDocText, tokenizeWords } from '../src/core/text';

const texts = (t: string, spans: { start: number; end: number }[]) => spans.map((s) => t.slice(s.start, s.end));

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    const t = 'The keeper climbed. He cleaned the lens! Did he sleep? Yes.';
    expect(texts(t, splitSentences(t))).toEqual(['The keeper climbed.', 'He cleaned the lens!', 'Did he sleep?', 'Yes.']);
  });

  it('keeps abbreviations, initials and decimals inside a sentence', () => {
    const t = 'Mr. Smith met Dr. Jones at 3.5 p.m. on Main St. today. J. K. Rowling wrote it. The U.S. economy grew.';
    expect(texts(t, splitSentences(t))).toEqual(['Mr. Smith met Dr. Jones at 3.5 p.m. on Main St. today.', 'J. K. Rowling wrote it.', 'The U.S. economy grew.']);
  });

  it('keeps closing quotes with the sentence', () => {
    const t = '"He was never lonely." She smiled. "Really?" she asked.';
    expect(texts(t, splitSentences(t))).toEqual(['"He was never lonely."', 'She smiled.', '"Really?" she asked.']);
  });

  it('handles text without final punctuation and extra spaces', () => {
    const t = '  First one.   Second without end  ';
    expect(texts(t, splitSentences(t))).toEqual(['First one.', 'Second without end']);
  });
});

describe('planChunks', () => {
  const doc = buildDocText([
    { kind: 'h1', text: 'A title' },
    { kind: 'p', text: 'One sentence here. Another one, with a clause.' },
    { kind: 'p', text: 'Last paragraph.' },
  ]);

  it('never crosses blocks and labels the pause after each chunk', () => {
    const chunks = planChunks(doc);
    expect(texts(doc.text, chunks)).toEqual(['A title', 'One sentence here.', 'Another one, with a clause.', 'Last paragraph.']);
    expect(chunks.map((c) => c.endsWith)).toEqual(['heading', 'sentence', 'block', 'block']);
  });

  it('splits long sentences at clause punctuation under the limit', () => {
    const long = Array.from({ length: 12 }, (_, i) => `this is clause number ${i} of a very long sentence`).join(', ') + '.';
    const d = buildDocText([{ kind: 'p', text: long }]);
    const chunks = planChunks(d);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(chunks.map((c) => d.text.slice(c.start, c.end)).join(' ')).toBe(long);
    expect(chunks.slice(0, -1).every((c) => c.endsWith === 'clause')).toBe(true);
  });

  it('splits at spaces when there is no punctuation', () => {
    const t = 'word '.repeat(150).trim();
    const parts = splitLong(t, { start: 0, end: t.length }, 200);
    expect(parts.length).toBe(4);
    for (const p of parts) expect(p.end - p.start).toBeLessThanOrEqual(200);
  });
});

describe('fast start', () => {
  const text = 'The lighthouse keeper climbed the spiral stairs every evening, counting each step as the wind pressed against the old stone walls.';
  const d = buildDocText([{ kind: 'p', text }]);

  it('splits off a 3 to 8 word head, preferring a phrase boundary', () => {
    const [head, tail] = splitHead(d.text, planChunks(d)[0])!;
    const headWords = tokenizeWords(d.text, head.start, head.end).length;
    expect(headWords).toBeGreaterThanOrEqual(3);
    expect(headWords).toBeLessThanOrEqual(8);
    // The clause ends after 9 words (too long for a fast start), so it cuts before "the".
    expect(d.text.slice(head.start, head.end)).toBe('The lighthouse keeper climbed');
    expect(head.endsWith).toBe('none');
    expect(d.text.slice(tail.start, tail.end)).toBe('the spiral stairs every evening, counting each step as the wind pressed against the old stone walls.');
  });

  it('prefers a clause boundary within 8 words', () => {
    const t = buildDocText([{ kind: 'p', text: 'At the top of the tower, he cleaned the great lens and trimmed the wick before dark.' }]);
    const [head] = splitHead(t.text, planChunks(t)[0])!;
    expect(t.text.slice(head.start, head.end)).toBe('At the top of the tower,');
    expect(head.endsWith).toBe('clause');
  });

  it('cuts before a function word when no punctuation is close', () => {
    const t = buildDocText([{ kind: 'p', text: 'Nobody had asked him to keep a journal but he wrote in it anyway every single night.' }]);
    const [head] = splitHead(t.text, planChunks(t)[0])!;
    expect(t.text.slice(head.start, head.end)).toBe('Nobody had asked him to keep');
    expect(head.endsWith).toBe('none');
  });

  it('does not split short sentences', () => {
    const t = buildDocText([{ kind: 'p', text: 'He found that oddly comforting.' }]);
    expect(splitHead(t.text, planChunks(t)[0])).toBeNull();
  });

  it('starts at the word under an offset and continues with the next sentences', () => {
    const doc = buildDocText([{ kind: 'p', text: 'First sentence is short. Second sentence starts here and keeps going for quite a few more words. Third.' }]);
    const offset = doc.text.indexOf('starts');
    const plan = chunksFrom(doc.text, planChunks(doc), offset);
    expect(doc.text.slice(plan[0].start, plan[0].end).startsWith('starts here')).toBe(true);
    expect(doc.text.slice(plan.at(-1)!.start, plan.at(-1)!.end)).toBe('Third.');
  });
});

describe('ramp for slow devices', () => {
  const doc = buildDocText([
    {
      kind: 'p',
      text: 'The lighthouse keeper climbed the spiral stairs every evening, counting each step as the wind pressed against the old stone walls. At the top, he cleaned the great lens, trimmed the wick, and watched the first ships appear on the horizon.',
    },
  ]);

  it('splits the chunks after the head at clauses only', () => {
    const plain = chunksFrom(doc.text, planChunks(doc), 0);
    const ramped = chunksFrom(doc.text, planChunks(doc), 0, { ramp: true });
    expect(ramped.length).toBeGreaterThan(plain.length);
    expect(ramped[0]).toEqual(plain[0]);
    // Same text overall, nothing lost or repeated.
    expect(ramped.map((c) => doc.text.slice(c.start, c.end)).join(' ')).toBe(plain.map((c) => doc.text.slice(c.start, c.end)).join(' '));
    for (const c of ramped.slice(1, -1)) {
      const t = doc.text.slice(c.start, c.end);
      if (c.endsWith === 'clause') expect(t).toMatch(/[,;:]$/);
    }
    expect(doc.text.slice(ramped[1].start, ramped[1].end)).toBe('the spiral stairs every evening,');
  });

  it('keeps a long clause whole when there is no punctuation to cut at', () => {
    const d = buildDocText([{ kind: 'p', text: 'word '.repeat(40).trim() + '.' }]);
    const c = planChunks(d)[0];
    expect(splitAtClauses(d.text, c, RAMP_CHARS)).toEqual([c]);
  });
});

describe('documentSentences', () => {
  it('assigns block indices', () => {
    const doc = buildDocText([{ kind: 'p', text: 'A one. A two.' }, { kind: 'p', text: 'B one.' }]);
    expect(documentSentences(doc).map((s) => s.block)).toEqual([0, 0, 1]);
  });
});

describe('merge for slow devices', () => {
  const doc = buildDocText([
    { kind: 'p', text: 'One short sentence. Another short one follows it. A third keeps the paragraph going a little. And a fourth.' },
    { kind: 'p', text: 'A new paragraph starts here. It has two sentences.' },
  ]);
  const chunks = planChunks(doc);

  it('joins sentences of a block up to the limit and never across blocks', () => {
    const merged = mergeChunks(chunks, 80);
    expect(merged.length).toBeLessThan(chunks.length);
    for (const c of merged) {
      expect(c.end - c.start).toBeLessThanOrEqual(80);
      expect(chunks.filter((x) => x.start >= c.start && x.end <= c.end).every((x) => x.block === c.block)).toBe(true);
    }
    // Same text overall, nothing lost or repeated.
    expect(merged.map((c) => doc.text.slice(c.start, c.end)).join(' ')).toBe(chunks.map((c) => doc.text.slice(c.start, c.end)).join(' '));
    expect(merged.at(-1)!.endsWith).toBe(chunks.at(-1)!.endsWith);
  });

  it('keeps chunks as they are when the limit is too small', () => {
    expect(mergeChunks(chunks, 5)).toEqual(chunks);
  });

  it('leaves the head of the plan short and joins the rest', () => {
    const plain = chunksFrom(doc.text, chunks, 0);
    const merged = chunksFrom(doc.text, chunks, 0, { merge: 220 });
    expect(merged[0]).toEqual(plain[0]);
    expect(merged.length).toBeLessThan(plain.length);
  });
});

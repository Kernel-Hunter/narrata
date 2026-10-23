// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenizeWords } from '../src/core/text';
import { extractFrom, extractPage, extractSelection, extractText, largestTextBlock } from '../extension/src/content/extract';
import { alignWords, buildTextIndex, domToFlat, flatToDom, mapText, normalizeWord } from '../extension/src/content/textmap';

const page = (name: string) => readFileSync(join(__dirname, 'pages', name), 'utf8');

function load(html: string): Document {
  document.open();
  document.write(html);
  document.close();
  return document;
}

/** Every mapped reading word must cover the same word on the page. */
function checkAllWords(x: NonNullable<ReturnType<typeof extractPage>>) {
  const m = x.mapping!;
  let checked = 0;
  x.words.forEach((w, i) => {
    const r = m.rangeForWord(i);
    if (!r) return;
    expect(normalizeWord(r.toString())).toBe(normalizeWord(x.doc.text.slice(w.start, w.end)));
    checked++;
  });
  return checked;
}

describe('text index', () => {
  it('separates blocks, joins inline elements and skips scripts', () => {
    load('<body><h1>Title</h1><p>Hel<b>lo</b> world<script>var x = 1;</script></p><p>Second<br>line</p><style>p{}</style></body>');
    const idx = buildTextIndex(document.body);
    expect(idx.text).toBe('Title\nHello world\nSecond\nline\n');
    expect(idx.words.map((w) => idx.text.slice(w.start, w.end))).toEqual(['Title', 'Hello', 'world', 'Second', 'line']);
    expect(idx.blocks.map((b) => `${b.kind}:${idx.text.slice(b.start, b.end)}`)).toEqual(['h1:Title', 'p:Hello world', 'p:Second', 'p:line']);
  });

  it('maps flat offsets to DOM positions and back, across element boundaries', () => {
    load('<body><p>Hel<b>lo</b> world</p><p>Next</p></body>');
    const idx = buildTextIndex(document.body);
    const s = flatToDom(idx, 0, 'start')!;
    const e = flatToDom(idx, 5, 'end')!;
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    expect(r.toString()).toBe('Hello');
    // Offset on the block separator resolves to the next paragraph when starting a range.
    const sep = idx.text.indexOf('\n');
    expect(flatToDom(idx, sep + 1, 'start')!.node.data).toBe('Next');
    const b = document.querySelector('b')!.firstChild!;
    expect(domToFlat(idx, b, 1)).toBe(4);
    expect(domToFlat(idx, document.body, 1)).toBe(idx.text.indexOf('Next'));
  });

  it('leaves out excluded elements and hidden ones', () => {
    load('<body><p>Keep this</p><div data-narrata-host>Player text</div><p hidden>Hidden</p></body>');
    const idx = buildTextIndex(document.body, { exclude: (el) => el.hasAttribute('data-narrata-host') });
    expect(idx.text.trim()).toBe('Keep this');
  });

  it('clips to a range', () => {
    load('<body><p id="a">One two three</p><p id="b">four five six</p></body>');
    const r = document.createRange();
    r.setStart(document.getElementById('a')!.firstChild!, 4);
    r.setEnd(document.getElementById('b')!.firstChild!, 9);
    const idx = buildTextIndex(document.body, { clip: r });
    expect(idx.words.map((w) => idx.text.slice(w.start, w.end))).toEqual(['two', 'three', 'four', 'five']);
  });
});

describe('word alignment', () => {
  const words = (s: string) => s.split(' ');

  it('maps identical lists one to one', () => {
    expect(Array.from(alignWords(words('a b c'), words('a b c')))).toEqual([0, 1, 2]);
  });

  it('skips page text around and inside the article', () => {
    const a = words('the night train leaves at nine and arrives at seven');
    const b = words('home world travel the night train leaves at nine ADVERT buy now and arrives at seven comments the end');
    const m = alignWords(a, b);
    expect(Array.from(m).map((j) => b[j])).toEqual(a);
    expect(m[0]).toBe(3);
  });

  it('marks words that are not on the page', () => {
    const a = words('extra title the train leaves');
    const b = words('nav the train leaves footer');
    const m = Array.from(alignWords(a, b));
    expect(m.slice(2)).toEqual([1, 2, 3]);
    expect(m[0]).toBe(-1);
  });

  it('prefers the article over an earlier teaser with the same words', () => {
    const a = words('slow return of the night train sleeper services were written off');
    const b = words('related slow return of the night train | slow return of the night train sleeper services were written off as relics');
    const m = alignWords(a, b);
    // The whole run maps to the second (article) occurrence.
    expect(m[0]).toBe(8);
    expect(Array.from(m).every((j, i) => j === 8 + i)).toBe(true);
  });

  it('stays fast on long pages', () => {
    const vocab = Array.from({ length: 3000 }, (_, i) => `w${i}`);
    let seed = 7;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const article = Array.from({ length: 60000 }, () => vocab[Math.floor(rnd() * vocab.length)]);
    const pageWords = [...vocab.slice(0, 500), ...article.slice(0, 30000), ...vocab.slice(0, 200), ...article.slice(30000), ...vocab.slice(0, 2000)];
    const t0 = performance.now();
    const m = alignWords(article, pageWords);
    const ms = performance.now() - t0;
    const correct = Array.from(m).filter((j, i) => j === (i < 30000 ? 500 + i : 700 + i)).length;
    expect(correct / article.length).toBeGreaterThan(0.99);
    expect(ms).toBeLessThan(3000);
  });
});

describe('reading a page', () => {
  it('finds the news article and maps every word back to the original page', () => {
    const doc = load(page('article.html'));
    const x = extractPage(doc)!;
    expect(x.method).toBe('readability');
    expect(x.title).toBe('The Slow Return of the Night Train');
    expect(x.doc.text.startsWith('The Slow Return of the Night Train')).toBe(true);
    expect(x.doc.text).toContain('At ten past nine on a Thursday evening');
    expect(x.doc.text).not.toContain('Most read');
    expect(x.doc.text).not.toContain('cookies');
    expect(x.mapping!.coverage).toBeGreaterThan(0.98);
    expect(checkAllWords(x)).toBeGreaterThan(850);
    // The title is highlighted in the page heading, not in the <title>.
    const r = x.mapping!.rangeForWord(0)!;
    expect(r.startContainer.parentElement!.tagName).toBe('H1');
    // A word that is not on the page in reading order (the kicker) still has a place to scroll to.
    const kicker = x.words.findIndex((w) => x.doc.text.slice(w.start, w.end) === 'Travel');
    expect(x.mapping!.rangeForWord(kicker)).toBeNull();
    expect(x.mapping!.nearestRange(kicker)!.toString()).toBe('Train');
    // A word deep in the article lands in the right paragraph.
    const i = x.words.findIndex((w) => x.doc.text.slice(w.start, w.end) === 'Lindqvist');
    expect(x.mapping!.rangeForWord(i)!.startContainer.parentElement!.textContent).toContain('Marta Lindqvist, who manages');
  });

  it('handles a wiki page with tables, footnote markers and lists', () => {
    const doc = load(page('wiki.html'));
    const x = extractPage(doc)!;
    expect(x.doc.text).toContain('A lighthouse is a tower');
    expect(x.doc.text).not.toContain('[1]');
    expect(x.mapping!.coverage).toBeGreaterThan(0.95);
    checkAllWords(x);
    const i = x.words.findIndex((w) => x.doc.text.slice(w.start, w.end) === 'Occulting');
    if (i >= 0) expect(x.mapping!.rangeForWord(i)!.startContainer.parentElement!.tagName).toBe('TD');
  });

  it('falls back to the largest block of text when there is no article', () => {
    const doc = load('<body><div id="menu"><a>Home</a> <a>About</a></div><div id="main">First line of a plain page without paragraphs, only text and breaks.<br>Second line carries on with more words to read aloud here.<br>Third line ends it.</div><div>Footer</div></body>');
    const x = extractPage(doc)!;
    expect(x.method).toBe('largest-block');
    expect(x.doc.blocks.length).toBe(3);
    expect(x.doc.text).not.toContain('Home');
    expect(checkAllWords(x)).toBe(x.words.length);
    expect(largestTextBlock(doc.body)!.id).toBe('main');
  });

  it('reads a selection across paragraphs', () => {
    const doc = load(page('article.html'));
    const ps = Array.from(doc.querySelectorAll('article p'));
    const p1 = ps.find((p) => p.textContent!.startsWith('At ten past nine'))!;
    const p2 = p1.nextElementSibling!;
    const r = doc.createRange();
    r.setStart(p1.firstChild!, p1.textContent!.indexOf('A couple'));
    r.setEnd(p2.firstChild!, p2.textContent!.indexOf(' It is not fast') + 1);
    doc.getSelection()!.removeAllRanges();
    doc.getSelection()!.addRange(r);
    const x = extractSelection(doc)!;
    expect(x.doc.text.startsWith('A couple shares a paper bag')).toBe(true);
    expect(x.doc.text.endsWith('seven the next morning.')).toBe(true);
    expect(x.doc.blocks.length).toBe(2);
    expect(checkAllWords(x)).toBe(x.words.length);
  });

  it('starts from a point on the page', () => {
    const doc = load(page('article.html'));
    const h = Array.from(doc.querySelectorAll('h2')).find((e) => e.textContent === 'Old lessons')!;
    const p = h.nextElementSibling!;
    const x = extractFrom(doc, p.firstChild!, 0)!;
    expect(x.doc.text.startsWith('Some of what the new operators')).toBe(true);
    expect(x.doc.text).toContain('settles into the long rhythm');
    expect(checkAllWords(x)).toBe(x.words.length);
  });

  it('maps a click on the page to the reading word', () => {
    const doc = load(page('article.html'));
    const x = extractPage(doc)!;
    const p = Array.from(doc.querySelectorAll('article p')).find((e) => e.textContent!.includes('The arithmetic has not changed'))!;
    const node = p.firstChild!;
    const flat = domToFlat(x.mapping!.index, node, (node as Text).data.indexOf('people'));
    const i = x.mapping!.readingWordForPageWord(x.mapping!.pageWordAt(flat));
    expect(x.doc.text.slice(x.words[i].start, x.words[i].end)).toBe('people');
  });

  it('reads plain text that has no place on the page', () => {
    const doc = load('<body><p>x</p></body>');
    const x = extractText(doc, 'Text from a frame.\n\nSecond paragraph.')!;
    expect(x.mapping).toBeNull();
    expect(x.doc.blocks.length).toBe(2);
  });

  it('maps a 60,000 word page quickly', () => {
    const paras: string[] = [];
    for (let s = 0; s < 700; s++) paras.push(`<p>Paragraph ${s}. The committee recorded the river levels over the whole year. Each district measured the bridge repairs in every village along the valley, and the volunteers compared the library hours.</p>`);
    const doc = load(`<body><nav>Home About</nav><article><h1>Report</h1>${paras.join('')}</article><footer>Footer</footer></body>`);
    const t0 = performance.now();
    const idx = buildTextIndex(doc.body);
    const article = Array.from(doc.querySelectorAll('article > *'), (e) => e.textContent).join('\n\n');
    const words = tokenizeWords(article);
    const m = mapText(article, words, idx);
    const ms = performance.now() - t0;
    expect(m.coverage).toBeGreaterThan(0.99);
    expect(ms).toBeLessThan(5000);
  });
});

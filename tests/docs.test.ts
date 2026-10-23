// @vitest-environment jsdom
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildDocText, tokenizeWords } from '../src/core/text';
import { detectKind, loadPastedText } from '../src/docs';
import { parseEpub } from '../src/docs/epub';
import { decodeHtml, htmlToBlocks, parseHtml } from '../src/docs/html';
import { parseMarkdown, stripInline } from '../src/docs/markdown';
import { parseTxt } from '../src/docs/txt';

const blockTexts = (p: { blocks: { kind: string; text: string }[] }) => p.blocks.map((b) => `${b.kind}:${b.text}`);

describe('plain text', () => {
  it('joins hard-wrapped lines and splits paragraphs on blank lines', () => {
    const p = parseTxt('CHAPTER ONE\n\nThe keeper climbed\nthe stairs.\n\n\nHe slept.\r\n', 'story.txt');
    expect(p.title).toBe('story');
    expect(blockTexts(p)).toEqual(['h2:CHAPTER ONE', 'p:The keeper climbed the stairs.', 'p:He slept.']);
  });

  it('treats each line as a paragraph when there are no blank lines', () => {
    expect(parseTxt('One line.\nAnother line.').blocks.length).toBe(2);
  });

  it('builds document text with block offsets', () => {
    const doc = buildDocText(parseTxt('Alpha  beta.\n\nGamma.').blocks);
    expect(doc.text).toBe('Alpha beta.\n\nGamma.');
    expect(doc.blocks.map((b) => doc.text.slice(b.start, b.end))).toEqual(['Alpha beta.', 'Gamma.']);
  });

  it('tokenizes spoken words without punctuation', () => {
    const t = '"Hello," she said—twice. (Really) 1987 — ok';
    expect(tokenizeWords(t).map((w) => t.slice(w.start, w.end))).toEqual(['Hello', 'she', 'said', 'twice', 'Really', '1987', 'ok']);
  });
});

describe('markdown', () => {
  it('reads headings, paragraphs, lists and quotes and skips code', () => {
    const md = `---\ntitle: Notes\n---\n# Big idea\n\nSome **bold** and _italic_ text with a [link](https://x.y) and \`code\`.\n\n- first item\n- second item\n\n> quoted line\n> continues\n\n\`\`\`js\nconsole.log('skip me')\n\`\`\`\n\nSetext\n------\n`;
    const p = parseMarkdown(md, 'notes.md');
    expect(p.title).toBe('Notes');
    expect(blockTexts(p)).toEqual([
      'h1:Big idea',
      'p:Some bold and italic text with a link and code.',
      'li:first item',
      'li:second item',
      'quote:quoted line continues',
      'h2:Setext',
    ]);
  });

  it('strips images, footnotes and escapes', () => {
    expect(stripInline('![A cat](cat.png) sat[^1] on \\*mat\\*')).toBe('A cat sat on *mat*');
  });
});

describe('html', () => {
  const page = `<!doctype html><html><head><title>The Keeper | Site</title><meta charset="utf-8"></head><body>
    <nav><a href="/">Home</a><a href="/about">About</a></nav>
    <article><h1>The Keeper</h1><p class="byline">By Ann Writer</p>
    ${'<p>The lighthouse keeper climbed the spiral stairs every evening, counting each step as the wind pressed against the walls. He cleaned the lens and watched the ships.</p>'.repeat(4)}
    <ul><li>First point here</li><li>Second point</li></ul>
    <p>Text with a footnote<sup><a href="#n1">1</a></sup> marker.</p>
    <script>alert('x')</script></article>
    <footer>Copyright notice</footer></body></html>`;

  it('extracts the article with Readability', () => {
    const p = parseHtml(page, 'keeper.html');
    expect(p.kind).toBe('html');
    expect(p.title).toMatch(/The Keeper/);
    const texts = p.blocks.map((b) => b.text);
    expect(texts.some((t) => t.startsWith('The lighthouse keeper climbed'))).toBe(true);
    expect(texts).toContain('First point here');
    expect(texts.join(' ')).not.toMatch(/alert|Home About/);
    expect(texts).toContain('Text with a footnote marker.');
  });

  it('turns block elements into blocks', () => {
    const doc = new DOMParser().parseFromString('<div><h2>Head</h2><p>One <b>two</b><br>three</p><blockquote><p>Q</p></blockquote><pre>a\n b</pre></div>', 'text/html');
    expect(blockTexts({ blocks: htmlToBlocks(doc.body) })).toEqual(['h2:Head', 'p:One two three', 'quote:Q', 'pre:a\n b']);
  });

  it('decodes a declared charset', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><p>caf'), 0xe9, ...new TextEncoder().encode('</p>')]);
    expect(decodeHtml(bytes)).toContain('café');
  });
});

function makeEpub(): Uint8Array {
  const chapter = (title: string, body: string) =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>The Keeper's Journal</dc:title><dc:creator>A. Writer</dc:creator></metadata>
      <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="cover" linear="no"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    'OEBPS/nav.xhtml': strToU8('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="text/c1.xhtml">Chapter One: Stairs</a></li><li><a href="text/c2.xhtml#start">Chapter Two: Lamp</a></li></ol></nav></body></html>'),
    'OEBPS/cover.xhtml': strToU8(chapter('Cover', '<p>Cover text</p>')),
    'OEBPS/text/c1.xhtml': strToU8(chapter('Stairs', '<p>He climbed the stairs.</p><p>He counted every step<a epub:type="noteref" href="#n">1</a>.</p><aside epub:type="footnote" id="n">A note.</aside>')),
    'OEBPS/text/c2.xhtml': strToU8(chapter('Lamp', '<p>The lamp was automated.</p>')),
  });
}

describe('epub', () => {
  it('reads the spine in order with chapter titles from the nav document', () => {
    const p = parseEpub(makeEpub(), 'keeper.epub');
    expect(p.title).toBe("The Keeper's Journal");
    expect(p.author).toBe('A. Writer');
    expect(p.chapters.map((c) => c.title)).toEqual(['Chapter One: Stairs', 'Chapter Two: Lamp']);
    expect(blockTexts(p)).toEqual(['h1:Stairs', 'p:He climbed the stairs.', 'p:He counted every step.', 'h1:Lamp', 'p:The lamp was automated.']);
    const doc = buildDocText(p.blocks, p.chapters);
    expect(doc.chapters[1].block).toBe(3);
    expect(doc.blocks[3].chapter).toBe(1);
  });

  it('rejects files without a container', () => {
    expect(() => parseEpub(zipSync({ 'a.txt': strToU8('x') }))).toThrow(/container/);
  });
});

describe('format detection and paste', () => {
  it('detects formats by extension and type', () => {
    expect(detectKind('a.PDF')).toBe('pdf');
    expect(detectKind('book.epub')).toBe('epub');
    expect(detectKind('n.md')).toBe('markdown');
    expect(detectKind('page.htm')).toBe('html');
    expect(detectKind('x', 'text/plain')).toBe('text');
    expect(detectKind('image.png', 'image/png')).toBeNull();
  });

  it('titles pasted text from its first line', () => {
    const d = loadPastedText('A short heading\n\nBody text follows here.');
    expect(d.title).toBe('A short heading');
    expect(d.doc.blocks.length).toBe(2);
  });
});

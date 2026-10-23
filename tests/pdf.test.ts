import { describe, expect, it } from 'vitest';
import { buildPdfDoc, pdfOffsetOf, pdfRunsFor, type PdfItem } from '../src/docs/pdf-text';
import { extractPdf } from '../src/docs/pdf';

const item = (str: string, x: number, y: number, opts: Partial<PdfItem> = {}): PdfItem => ({ str, x, y, width: str.length * 5, height: 10, hasEOL: false, ...opts });

describe('buildPdfDoc', () => {
  it('joins lines into paragraphs, dehyphenates and maps back to items', () => {
    const page = {
      items: [
        item('Chapter 1', 50, 760, { height: 18, width: 80, hasEOL: true }),
        item('The keeper climbed the spi-', 50, 720, { width: 400, hasEOL: true }),
        item('ral stairs every evening.', 50, 708, { width: 300, hasEOL: true }),
        item('A new paragraph starts', 50, 680, { width: 400, hasEOL: true }),
        item('here.', 50, 668, { width: 30, hasEOL: true }),
        item('7', 300, 40, { width: 5, hasEOL: true }),
      ],
    };
    const { doc, map } = buildPdfDoc([page]);
    expect(doc.blocks.map((b) => [b.kind, doc.text.slice(b.start, b.end)])).toEqual([
      ['h1', 'Chapter 1'],
      ['p', 'The keeper climbed the spiral stairs every evening.'],
      ['p', 'A new paragraph starts here.'],
    ]);
    // "spiral" spans two items: "spi" from item 1 and "ral" from item 2.
    const s = doc.text.indexOf('spiral');
    expect(pdfRunsFor(map, s, s + 6)).toEqual([
      { page: 0, item: 1, from: 23, to: 26 },
      { page: 0, item: 2, from: 0, to: 3 },
    ]);
    // Reverse lookup from a character in an item.
    expect(pdfOffsetOf(map, 0, 2, 4)).toBe(doc.text.indexOf('stairs'));
  });

  it('continues a paragraph across pages unless the sentence ended', () => {
    const p1 = { items: [item('It was a long', 50, 100, { hasEOL: true })] };
    const p2 = { items: [item('night. Then morning came.', 50, 760, { hasEOL: true })] };
    const { doc } = buildPdfDoc([p1, p2]);
    expect(doc.blocks.length).toBe(1);
    expect(doc.text).toBe('It was a long night. Then morning came.');
  });

  it('inserts a space between items separated by a gap', () => {
    const { doc } = buildPdfDoc([{ items: [item('Hello', 50, 700, { width: 25 }), item('world', 90, 700, { width: 25, hasEOL: true })] }]);
    expect(doc.text).toBe('Hello world');
  });
});

/** A one-page PDF with two lines of Helvetica text. */
function makePdf(lines: string[]): ArrayBuffer {
  const content = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out).buffer as ArrayBuffer;
}

describe('extractPdf with pdf.js (Node legacy build)', () => {
  it('extracts text and a character map from a real PDF', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loaded = await extractPdf(pdfjs, makePdf(['The lighthouse keeper climbed the stairs.', 'He cleaned the great lens.']), 'keeper.pdf');
    expect(loaded.kind).toBe('pdf');
    expect(loaded.title).toBe('keeper');
    expect(loaded.doc.text).toContain('The lighthouse keeper climbed the stairs.');
    expect(loaded.doc.text).toContain('He cleaned the great lens.');
    expect(loaded.pdfPages).toEqual([{ width: 612, height: 792 }]);
    const s = loaded.doc.text.indexOf('keeper');
    const runs = pdfRunsFor(loaded.pdfMap!, s, s + 6);
    expect(runs.length).toBe(1);
    expect(runs[0].page).toBe(0);
  });
});

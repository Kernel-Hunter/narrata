// Generates the sample PDF and EPUB in tests/fixtures (used by tests and manual checks).
// Run: node scripts/make-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'tests', 'fixtures');
mkdirSync(out, { recursive: true });

const story = [
  ['h1', 'The Harbor Office'],
  ['p', 'The harbor office stood at the end of the stone pier, a narrow building with blue shutters and a bell that nobody rang anymore. Inside, the shelves held ledgers going back more than a century, each one bound in cloth that had faded to the color of weak tea.'],
  ['p', 'Every morning the clerk unlocked the door, opened the windows, and wrote the date at the top of a fresh page. Some days she recorded a dozen arrivals. Other days the page stayed empty except for the weather, which she noted carefully: wind from the west, light rain, visibility good.'],
  ['h2', 'The Box'],
  ['p', 'In the spring, while clearing a cupboard, she found a wooden box tied with string. It held seven small notebooks filled with neat handwriting. They described ships, clouds, and the changing color of the sea, and they were signed only with the initials of the old lighthouse keeper.'],
  ['p', 'She read the first notebook that evening and could not stop. The keeper wrote about storms that lasted three days and about calm nights when the water looked like polished slate. He wrote about a fishing boat that came home late, long after the others, with every lamp on board lit.'],
  ['p', "By the end of the week she had read them all. She copied her favorite passages into the margins of the harbor ledger, so that anyone who opened it would find a little of the keeper's voice between the dates and the tides."],
  ['h2', 'Visitors'],
  ['p', 'Word spread through the village. People who had never set foot in the harbor office began to visit, asking to see the notebooks. Children traced the drawings of ships with their fingers. An old fisherman sat for an hour with one volume on his knees, reading slowly, and when he left he said that he remembered the night of the late boat.'],
  ['p', 'The clerk started a new ledger just for the visitors. On its first page she wrote a single line: the sea is easier to understand when someone has written it down.'],
];

function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const w of text.split(' ')) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line);
      line = w;
    } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines;
}

function pdf() {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const pages = [];
  let ops = [];
  let y = 720;
  const newPage = () => {
    ops.push(`BT /F1 10 Tf 300 40 Td (${pages.length + 1}) Tj ET`);
    pages.push(ops.join('\n'));
    ops = [];
    y = 720;
  };
  for (const [kind, text] of story) {
    const size = kind === 'h1' ? 22 : kind === 'h2' ? 16 : 12;
    const lead = size * 1.45;
    const lines = kind === 'p' ? wrap(text, 80) : [text];
    if (kind !== 'p') y -= size * 0.6;
    if (y - lines.length * lead < 330 && pages.length === 0) newPage();
    for (const l of lines) {
      ops.push(`BT /${kind === 'p' ? 'F1' : 'F2'} ${size} Tf 72 ${y.toFixed(1)} Td (${esc(l)}) Tj ET`);
      y -= lead;
    }
    y -= 8;
  }
  newPage();
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const content of pages) {
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add('<< /Title (The Harbor Office) /Producer (Narrata fixtures) >>');
  let s = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(s.length);
    s += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = s.length;
  s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  s += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(s, 'latin1');
}

function epub() {
  const chapters = [
    ['The Stairs', ['The lighthouse keeper climbed the spiral stairs every evening, counting each step as the wind pressed against the old stone walls.', 'At the top, he cleaned the great lens, trimmed the wick, and watched the first ships appear on the horizon.']],
    ['The Lamp', ['In 1987, the lamp was finally automated, and the keeper moved to a small house in the village.', 'He still walked to the cliff on clear nights. From there, he could see the beam sweep across the water, steady and patient.']],
    ['The Journals', ['Years later, a student found the journals in a box at the harbor office.', 'She read them aloud to her grandmother, one page each night, until the old woman could name every ship that had passed the point in a single winter.']],
  ];
  const xhtml = (title, paras) =>
    `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><title>${title}</title></head><body><section epub:type="chapter"><h1>${title}</h1>${paras.map((p) => `<p>${p}</p>`).join('')}</section></body></html>`;
  const files = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">narrata-fixture-keeper</dc:identifier><dc:title>The Keeper's Year</dc:title><dc:creator>Narrata</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${chapters.map((_, i) => `<item id="c${i + 1}" href="c${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('')}</spine></package>`),
    'OEBPS/nav.xhtml': strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>${chapters.map(([t], i) => `<li><a href="c${i + 1}.xhtml">${i + 1}. ${t}</a></li>`).join('')}</ol></nav></body></html>`),
  };
  chapters.forEach(([t, p], i) => (files[`OEBPS/c${i + 1}.xhtml`] = strToU8(xhtml(t, p))));
  return Buffer.from(zipSync(files));
}

writeFileSync(join(out, 'harbor.pdf'), pdf());
writeFileSync(join(out, 'keeper.epub'), epub());
console.log('wrote tests/fixtures/harbor.pdf and tests/fixtures/keeper.epub');

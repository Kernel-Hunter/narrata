import type { PDFDocumentProxy } from 'pdfjs-dist';
import { buildPdfDoc, type PdfItem } from './pdf-text';
import type { LoadedDoc } from './types';

type PdfJs = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfJs> | null = null;

/** Where pdf.js finds fonts, character maps and decoders (served by the app, see scripts/copy-assets.mjs). */
export function pdfAssetParams(): Record<string, unknown> {
  if (typeof document === 'undefined') return {};
  const base = new URL('./pdfjs/', document.baseURI).href;
  return { standardFontDataUrl: `${base}standard_fonts/`, cMapUrl: `${base}cmaps/`, cMapPacked: true, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/` };
}

/** pdf.js, loaded on first use with its worker served from this origin. */
export function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  return pdfjsPromise;
}

interface RawTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

export function toPdfItems(items: RawTextItem[]): PdfItem[] {
  return items
    .filter((i) => i.str !== undefined)
    .map((i) => ({
      str: i.str!,
      x: i.transform?.[4] ?? 0,
      y: i.transform?.[5] ?? 0,
      width: i.width ?? 0,
      height: i.height || Math.hypot(i.transform?.[2] ?? 0, i.transform?.[3] ?? 0),
      hasEOL: !!i.hasEOL,
    }));
}

/** Extract reading text from a PDF. Works with the browser build and the Node legacy build. */
export async function extractPdf(
  pdfjs: Pick<PdfJs, 'getDocument'>,
  bytes: ArrayBuffer,
  filename?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<LoadedDoc> {
  // pdf.js transfers the buffer to its worker, so give it a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), ...pdfAssetParams() });
  const pdf: PDFDocumentProxy = await task.promise;
  const pages = [];
  const sizes = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ width: vp.width, height: vp.height });
    const tc = await page.getTextContent();
    pages.push({ items: toPdfItems(tc.items as RawTextItem[]) });
    page.cleanup();
    onProgress?.(n, pdf.numPages);
  }
  let title = filename ? filename.replace(/\.pdf$/i, '') : 'PDF';
  try {
    const meta = await pdf.getMetadata();
    const t = (meta.info as { Title?: string })?.Title?.trim();
    if (t && t.length > 2 && !/^(untitled|microsoft word)/i.test(t)) title = t;
  } catch {
    // keep the file name
  }
  await task.destroy();
  const { doc, map } = buildPdfDoc(pages);
  if (!doc.text.trim()) throw new Error('This PDF has no selectable text. Scanned pages need OCR, which Narrata does not do yet.');
  return { title, kind: 'pdf', doc, source: bytes, pdfMap: map, pdfPages: sizes };
}

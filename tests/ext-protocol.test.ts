import { describe, expect, it } from 'vitest';
import { chunksFrom, documentSentences, planChunks } from '../src/core/chunker';
import { buildDocText, tokenizeWords, wordIndexAt } from '../src/core/text';
import { type DocPayload, SessionTable, envelope, isEnvelope, isTabRequest, looksLikePdf, restrictedReason, routeInBackground } from '../extension/src/protocol';

describe('envelopes', () => {
  it('recognises only Narrata envelopes', () => {
    expect(isEnvelope(envelope('offscreen', { type: 'debug' }))).toBe(true);
    expect(isEnvelope({ to: 'offscreen', msg: {} })).toBe(false);
    expect(isEnvelope('hello')).toBe(false);
    expect(isEnvelope(null)).toBe(false);
  });

  it('checks tab requests', () => {
    expect(isTabRequest({ type: 'toggle', session: 3 })).toBe(true);
    expect(isTabRequest({ type: 'toggle' })).toBe(false);
    expect(isTabRequest({ type: 'debug', session: 3 })).toBe(false);
  });
});

describe('routing in the service worker', () => {
  const req = { type: 'toggle', session: 7 };

  it('forwards a content script request to the offscreen document with the sender tab', () => {
    const r = routeInBackground(envelope('background', req), { tabId: 12, frameId: 0 });
    expect(r).toEqual({ kind: 'offscreen', env: { narrata: 1, to: 'offscreen', tabId: 12, msg: req } });
  });

  it('never lets a tab speak for another tab', () => {
    const r = routeInBackground(envelope('background', req, 99), { tabId: 12, frameId: 0 });
    expect(r.kind === 'offscreen' && r.env.tabId).toBe(12);
    // A content script cannot address another tab directly either.
    expect(routeInBackground(envelope('tab', { type: 'stop' }, 99), { tabId: 12, frameId: 0 }).kind).toBe('ignore');
  });

  it('ignores sub-frames', () => {
    expect(routeInBackground(envelope('background', req), { tabId: 12, frameId: 3 }).kind).toBe('ignore');
  });

  it('relays engine events to the addressed tab', () => {
    const ev = { type: 'word', session: 7, word: 42 };
    const r = routeInBackground(envelope('tab', ev, 12), { url: 'chrome-extension://abc/offscreen.html' });
    expect(r).toEqual({ kind: 'tab', tabId: 12, env: { narrata: 1, to: 'tab', msg: ev } });
    expect(routeInBackground(envelope('tab', ev), { url: 'chrome-extension://abc/offscreen.html' }).kind).toBe('ignore');
  });

  it('handles popup requests itself and leaves other parts alone', () => {
    expect(routeInBackground(envelope('background', { type: 'status', tabId: 1 }), { url: 'chrome-extension://abc/popup.html' }).kind).toBe('self');
    expect(routeInBackground(envelope('popup', { type: 'engine' }), { url: 'chrome-extension://abc/offscreen.html' }).kind).toBe('ignore');
    expect(routeInBackground(envelope('offscreen', { type: 'debug' }), {}).kind).toBe('ignore');
  });
});

describe('sessions', () => {
  it('sends events only to the tab that owns the engine', () => {
    const t = new SessionTable();
    expect(t.address({ type: 'word', word: 1 })).toBeNull();
    expect(t.claim(1, 100)).toBeNull();
    expect(t.address({ type: 'word', word: 5 })).toEqual({ narrata: 1, to: 'tab', tabId: 1, msg: { type: 'word', word: 5, session: 100 } });
    expect(t.accepts(1, 100)).toBe(true);
    expect(t.accepts(1, 99)).toBe(false);
  });

  it('hands the engine to a new tab and reports the old owner', () => {
    const t = new SessionTable();
    t.claim(1, 100);
    expect(t.claim(2, 200)).toEqual({ tabId: 1, session: 100 });
    expect(t.accepts(1, 100)).toBe(false);
    expect(t.address({ type: 'state', state: 'playing' })?.tabId).toBe(2);
    // Re-claiming the same session is not a handover.
    expect(t.claim(2, 200)).toBeNull();
  });

  it('releases only for the owner', () => {
    const t = new SessionTable();
    t.claim(1, 100);
    expect(t.release(2, 100)).toBe(false);
    expect(t.release(1, 100)).toBe(true);
    expect(t.owner).toBeNull();
  });
});

describe('restricted pages', () => {
  it('names pages Chrome does not let extensions read', () => {
    expect(restrictedReason('chrome://settings')).toMatch(/own pages/);
    expect(restrictedReason('chrome://newtab/')).toMatch(/own pages/);
    expect(restrictedReason('edge://extensions')).toMatch(/own pages/);
    expect(restrictedReason('view-source:https://example.com')).toMatch(/own pages/);
    expect(restrictedReason('https://chromewebstore.google.com/detail/abc')).toMatch(/Web Store/);
    expect(restrictedReason('https://chrome.google.com/webstore/category/extensions')).toMatch(/Web Store/);
    expect(restrictedReason('chrome-extension://abc/page.html')).toMatch(/other extensions/);
    expect(restrictedReason(undefined)).toMatch(/cannot read/);
  });

  it('allows ordinary pages', () => {
    expect(restrictedReason('https://example.com/article')).toBeNull();
    expect(restrictedReason('http://127.0.0.1:5480/article.html')).toBeNull();
    expect(restrictedReason('https://chrome.google.com/search')).toBeNull();
    expect(restrictedReason('file:///Users/me/page.html')).toBeNull();
  });

  it('spots PDFs', () => {
    expect(looksLikePdf('https://example.com/paper.PDF')).toBe(true);
    expect(looksLikePdf('https://example.com/paper.pdf?x=1')).toBe(true);
    expect(looksLikePdf('https://example.com/pdf-guide')).toBe(false);
  });
});

describe('chunk routing between the page and the engine', () => {
  // The content script and the offscreen document tokenize the same text independently; word
  // indices sent by the engine must point at the same words on the page.
  const doc = buildDocText([
    { kind: 'h1', text: 'The Slow Return of the Night Train' },
    { kind: 'p', text: 'At ten past nine on a Thursday evening, the platform at the central station is crowded with people who do not look like they are going anywhere in a hurry. A couple shares a paper bag of pastries.' },
    { kind: 'p', text: 'The night train to the coast leaves at nine thirty and arrives a little after seven the next morning. It is not fast.' },
  ]);
  const payload: DocPayload = JSON.parse(JSON.stringify({ text: doc.text, blocks: doc.blocks, title: 'T', url: 'https://x.y/' }));

  it('keeps word indices identical after the message round trip', () => {
    const pageWords = tokenizeWords(doc.text);
    const engineWords = tokenizeWords(payload.text);
    expect(engineWords).toEqual(pageWords);
  });

  it('starts the chunk plan at the requested word and covers the rest without gaps', () => {
    const engineDoc = { text: payload.text, blocks: payload.blocks, chapters: [] };
    const words = tokenizeWords(engineDoc.text);
    const sentences = documentSentences(engineDoc);
    const chunks = planChunks(engineDoc, sentences);
    const i = words.findIndex((w) => engineDoc.text.slice(w.start, w.end) === 'platform');
    const plan = chunksFrom(engineDoc.text, chunks, words[i].start);
    expect(wordIndexAt(words, plan[0].start)).toBe(i);
    expect(plan[0].end - plan[0].start).toBeLessThan(60); // short first chunk for a fast start
    // Every word from the start on is in exactly one chunk.
    const covered = words.slice(i).every((w) => plan.filter((c) => w.start >= c.start && w.end <= c.end).length === 1);
    expect(covered).toBe(true);
    // Chunks never cross a block.
    for (const c of plan) {
      const b = engineDoc.blocks.find((bl) => c.start >= bl.start && c.end <= bl.end);
      expect(b).toBeDefined();
    }
  });

  it('plans a very long page lazily from any offset', () => {
    const blocks = Array.from({ length: 3000 }, (_, n) => ({ kind: 'p' as const, text: `Paragraph ${n}. The committee recorded the river levels over the whole year, and each district measured the bridge repairs.` }));
    const big = buildDocText(blocks);
    const t0 = performance.now();
    const sentences = documentSentences(big);
    const chunks = planChunks(big, sentences);
    const plan = chunksFrom(big.text, chunks, big.blocks[2500].start);
    const ms = performance.now() - t0;
    expect(plan[0].block).toBe(2500);
    expect(ms).toBeLessThan(1500);
  });
});

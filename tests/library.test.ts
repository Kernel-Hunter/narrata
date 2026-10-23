import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { buildDocText } from '../src/core/text';
import type { LoadedDoc } from '../src/docs/types';
import { Library, docId, progressFor, sortRecent } from '../src/store/library';
import { DEFAULTS, clampSettings, loadSettings, saveSettings } from '../src/store/settings';

const doc = (text: string, title = 'T'): LoadedDoc => ({ title, kind: 'text', doc: buildDocText([{ kind: 'p', text }]) });

describe('library logic', () => {
  it('derives a stable id from content', () => {
    expect(docId(doc('same text'))).toBe(docId(doc('same text', 'Other title')));
    expect(docId(doc('same text'))).not.toBe(docId(doc('different text')));
  });

  it('computes progress and sorts by last opened', () => {
    expect(progressFor(50, 200)).toBe(0.25);
    expect(progressFor(500, 200)).toBe(1);
    expect(progressFor(5, 0)).toBe(0);
    const metas = [{ openedAt: 1 }, { openedAt: 3 }, { openedAt: 2 }] as never[];
    expect(sortRecent(metas).map((m: { openedAt: number }) => m.openedAt)).toEqual([3, 2, 1]);
  });
});

describe('Library (IndexedDB)', () => {
  it('adds, resumes, lists and removes documents', async () => {
    const lib = new Library(new IDBFactory(), 'test');
    const a = await lib.add(doc('Alpha text here.', 'Alpha'), 1000);
    const b = await lib.add(doc('Beta text.', 'Beta'), 2000);
    expect((await lib.list()).map((m) => m.title)).toEqual(['Beta', 'Alpha']);

    const saved = await lib.savePosition(a.id, 8, 3000);
    expect(saved?.progress).toBeCloseTo(8 / 16);
    expect((await lib.list())[0].id).toBe(a.id);

    // Opening the same document again keeps the reading position.
    const again = await lib.add(doc('Alpha text here.', 'Alpha'), 4000);
    expect(again.position).toBe(8);
    expect(again.openedAt).toBe(4000);
    expect((await lib.list()).length).toBe(2);

    const got = await lib.get(b.id);
    expect(got?.content.doc.text).toBe('Beta text.');

    await lib.remove(a.id);
    expect((await lib.list()).map((m) => m.title)).toEqual(['Beta']);
    expect(await lib.get(a.id)).toBeNull();
    expect(await lib.savePosition('missing', 1)).toBeNull();
  });
});

describe('settings', () => {
  it('clamps and round-trips through storage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } as Storage;
    expect(loadSettings(storage)).toEqual(DEFAULTS);
    saveSettings({ ...DEFAULTS, rate: 2, theme: 'dark' }, storage);
    expect(loadSettings(storage)).toMatchObject({ rate: 2, theme: 'dark' });
    expect(clampSettings({ rate: 10, fontSize: 4, volume: NaN, theme: 'neon' as never })).toMatchObject({ rate: 3, fontSize: 15, volume: 1, theme: 'system' });
  });
});

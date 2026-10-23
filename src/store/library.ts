// Recent documents, stored only in this browser (IndexedDB). Metadata and content live in
// separate object stores so listing the library never loads whole books.

import type { DocKind, LoadedDoc } from '../docs/types';

export interface DocMeta {
  id: string;
  title: string;
  author?: string;
  kind: DocKind;
  chars: number;
  createdAt: number;
  openedAt: number;
  /** Character offset to resume from. */
  position: number;
  /** 0..1 */
  progress: number;
}

interface ContentRecord extends LoadedDoc {
  id: string;
}

/** Stable id from the document text, so opening the same file twice keeps one entry. */
export function docId(loaded: Pick<LoadedDoc, 'kind' | 'doc'>): string {
  const s = `${loaded.kind}\u0000${loaded.doc.text}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

export function progressFor(position: number, chars: number): number {
  if (chars <= 0) return 0;
  return Math.min(1, Math.max(0, position / chars));
}

export function sortRecent(list: DocMeta[]): DocMeta[] {
  return [...list].sort((a, b) => b.openedAt - a.openedAt);
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
}

export class Library {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly idb: IDBFactory = indexedDB,
    private readonly name = 'narrata',
  ) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const r = this.idb.open(this.name, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('content')) db.createObjectStore('content', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return this.db;
  }

  async list(): Promise<DocMeta[]> {
    const db = await this.open();
    const all = await req(db.transaction('docs').objectStore('docs').getAll() as IDBRequest<DocMeta[]>);
    return sortRecent(all);
  }

  /** Add a document, or bump it to the top if it is already there (keeping its position). */
  async add(loaded: LoadedDoc, now = Date.now()): Promise<DocMeta> {
    const db = await this.open();
    const id = docId(loaded);
    const tx = db.transaction(['docs', 'content'], 'readwrite');
    const docs = tx.objectStore('docs');
    const existing = (await req(docs.get(id) as IDBRequest<DocMeta | undefined>)) ?? null;
    const meta: DocMeta = existing
      ? { ...existing, title: existing.title || loaded.title, openedAt: now }
      : { id, title: loaded.title, author: loaded.author, kind: loaded.kind, chars: loaded.doc.text.length, createdAt: now, openedAt: now, position: 0, progress: 0 };
    docs.put(meta);
    if (!existing) tx.objectStore('content').put({ id, ...loaded } satisfies ContentRecord);
    await done(tx);
    return meta;
  }

  async get(id: string): Promise<{ meta: DocMeta; content: LoadedDoc } | null> {
    const db = await this.open();
    const tx = db.transaction(['docs', 'content']);
    const [meta, content] = await Promise.all([
      req(tx.objectStore('docs').get(id) as IDBRequest<DocMeta | undefined>),
      req(tx.objectStore('content').get(id) as IDBRequest<ContentRecord | undefined>),
    ]);
    if (!meta || !content) return null;
    const { id: _id, ...loaded } = content;
    return { meta, content: loaded };
  }

  async savePosition(id: string, position: number, now = Date.now()): Promise<DocMeta | null> {
    const db = await this.open();
    const tx = db.transaction('docs', 'readwrite');
    const store = tx.objectStore('docs');
    const meta = (await req(store.get(id) as IDBRequest<DocMeta | undefined>)) ?? null;
    if (!meta) return null;
    const next: DocMeta = { ...meta, position, progress: progressFor(position, meta.chars), openedAt: now };
    store.put(next);
    await done(tx);
    return next;
  }

  async rename(id: string, title: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction('docs', 'readwrite');
    const store = tx.objectStore('docs');
    const meta = await req(store.get(id) as IDBRequest<DocMeta | undefined>);
    if (meta) store.put({ ...meta, title });
    await done(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['docs', 'content'], 'readwrite');
    tx.objectStore('docs').delete(id);
    tx.objectStore('content').delete(id);
    await done(tx);
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(['docs', 'content'], 'readwrite');
    tx.objectStore('docs').clear();
    tx.objectStore('content').clear();
    await done(tx);
  }
}

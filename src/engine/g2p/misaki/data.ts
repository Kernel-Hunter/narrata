// Loading the G2P data files (src/engine/g2p/data, built by scripts/g2p/build-data.mjs).

import { gunzipSync } from 'fflate';
import { Dictionary, type Entry } from './lexicon';
import type { TaggerModel } from './tagger';
import { readSafetensors, type BartConfig, type Tensors } from './fallback';

/** Returns the bytes of a data file by name (for example "en-us.lex.gz"). */
export type DataLoader = (name: string) => Promise<ArrayBuffer>;

/** Some servers send .gz files with Content-Encoding: gzip, so the browser has already inflated them. */
export async function maybeGunzip(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(gunzipSync(bytes));
}

export interface LexiconData {
  gold: Dictionary;
  silver: Dictionary;
}

/** Parses "word<TAB>phonemes" lines; homographs are "@TAG=phonemes|TAG=phonemes" (empty = null). */
export function parseLexicon(text: string): LexiconData {
  const sections: Record<string, Map<string, Entry>> = { gold: new Map(), silver: new Map() };
  let current: Map<string, Entry> | null = null;
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (!line) continue;
    if (line[0] === '#') {
      current = sections[line.slice(1)] ?? null;
      continue;
    }
    const tab = line.indexOf('\t');
    if (tab < 0 || !current) continue;
    const key = line.slice(0, tab);
    const value = line.slice(tab + 1);
    if (value[0] === '@') {
      const entry: Record<string, string | null> = {};
      for (const part of value.slice(1).split('|')) {
        const eq = part.indexOf('=');
        const ps = part.slice(eq + 1);
        entry[part.slice(0, eq)] = ps === '' ? null : ps;
      }
      current.set(key, entry);
    } else current.set(key, value);
  }
  return { gold: new Dictionary(sections.gold), silver: new Dictionary(sections.silver) };
}

export async function loadLexicon(load: DataLoader, accent: 'us' | 'gb'): Promise<LexiconData> {
  return parseLexicon(await maybeGunzip(await load(`en-${accent}.lex.gz`)));
}

export async function loadTagger(load: DataLoader): Promise<TaggerModel> {
  return JSON.parse(await maybeGunzip(await load('tagger.json.gz'))) as TaggerModel;
}

export async function loadFallback(load: DataLoader, accent: 'us' | 'gb'): Promise<{ tensors: Tensors; config: BartConfig }> {
  const buf = await load(`fallback-${accent}.safetensors`);
  const view = new DataView(buf);
  const n = Number(view.getBigUint64(0, true));
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))).__metadata__ as { grapheme_chars: string; phoneme_chars: string };
  return { tensors: readSafetensors(buf), config: { graphemeChars: meta.grapheme_chars, phonemeChars: meta.phoneme_chars } };
}

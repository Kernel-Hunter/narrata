// The pronunciation list, kept in local storage next to the settings. It never leaves the browser.

import { normalizePronunciations, type Pronunciation } from '../engine/g2p/pronunciations';

const KEY = 'narrata.pronunciations';

export function loadPronunciations(storage: Storage | null = safeStorage()): Pronunciation[] {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? normalizePronunciations(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function savePronunciations(list: Pronunciation[], storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(normalizePronunciations(list)));
  } catch {
    // Private mode or storage disabled: the list lasts for this session only.
  }
}

/** Adds or replaces the entry for a word (ignoring case); a replaced entry keeps its place. */
export function upsertPronunciation(list: Pronunciation[], entry: Pronunciation): Pronunciation[] {
  const key = entry.word.trim().toLocaleLowerCase();
  const i = list.findIndex((p) => p.word.toLocaleLowerCase() === key);
  const next = i >= 0 ? list.map((p, j) => (j === i ? entry : p)) : [entry, ...list];
  return normalizePronunciations(next);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

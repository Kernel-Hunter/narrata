// The G2P data files, bundled with the app and the extension and fetched on first use. Vite turns
// each `new URL(..., import.meta.url)` into the URL of the emitted file.

import type { DataLoader } from './misaki/data';

const FILES: Record<string, URL> = {
  'en-us.lex.gz': new URL('./data/en-us.lex.gz', import.meta.url),
  'en-gb.lex.gz': new URL('./data/en-gb.lex.gz', import.meta.url),
  'fallback-us.safetensors': new URL('./data/fallback-us.safetensors', import.meta.url),
  'fallback-gb.safetensors': new URL('./data/fallback-gb.safetensors', import.meta.url),
  'tagger.json.gz': new URL('./data/tagger.json.gz', import.meta.url),
};

export const fetchData: DataLoader = async (name) => {
  const url = FILES[name];
  if (!url) throw new Error(`Unknown G2P data file ${name}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
  return res.arrayBuffer();
};

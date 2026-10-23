// Accuracy of the English G2P against misaki 0.9.4, the G2P Kokoro was trained with, on the
// evaluation set in tests/g2p-eval (built by scripts/g2p/make_eval_set.py and
// scripts/g2p/reference.py). Cases where misaki itself handed a word to eSpeak NG are reported
// separately: Narrata does not ship eSpeak, so those cannot match exactly.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnglishG2P } from '../src/engine/g2p/english';
import type { DataLoader } from '../src/engine/g2p/misaki/data';

interface Case {
  id: number;
  cat: string;
  text: string;
  us: string;
  gb: string;
  us_fallback: string[];
  gb_fallback: string[];
}

const dataDir = join(__dirname, '../src/engine/g2p/data');
const load: DataLoader = async (name) => {
  const b = readFileSync(join(dataDir, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const cases = JSON.parse(readFileSync(join(__dirname, 'g2p-eval/cases.json'), 'utf8')) as Case[];
const g2p = new EnglishG2P(load);

/** Exact-match rate per category: [cases without eSpeak in the reference, all cases]. */
async function score(accent: 'us' | 'gb'): Promise<Map<string, { n: number; ok: number; nAll: number; okAll: number }>> {
  const out = new Map<string, { n: number; ok: number; nAll: number; okAll: number }>();
  for (const c of cases) {
    const got = (await g2p.phonemize(c.text, accent === 'gb' ? 'b' : 'a')).phonemes;
    const cat = c.cat.startsWith('word-') ? 'word' : c.cat;
    const s = out.get(cat) ?? { n: 0, ok: 0, nAll: 0, okAll: 0 };
    const ok = got === c[accent];
    s.nAll++;
    if (ok) s.okAll++;
    if (!c[`${accent}_fallback`].length) {
      s.n++;
      if (ok) s.ok++;
    }
    out.set(cat, s);
  }
  return out;
}

const pct = (a: number, b: number) => (b ? (100 * a) / b : 100);

describe.each(['us', 'gb'] as const)('G2P accuracy against misaki (%s)', (accent) => {
  it('meets the targets', async () => {
    const s = await score(accent);
    const rows = [...s].map(([cat, v]) => `${cat.padEnd(14)} ${pct(v.ok, v.n).toFixed(1).padStart(5)}% of ${String(v.n).padStart(3)}   ${pct(v.okAll, v.nAll).toFixed(1).padStart(5)}% of ${v.nAll}`);
    console.log(`${accent}: category, exact match without / with misaki's eSpeak cases\n${rows.join('\n')}`);
    const rate = (cat: string) => pct(s.get(cat)!.ok, s.get(cat)!.n);
    expect(rate('word')).toBeGreaterThanOrEqual(98);
    expect(rate('homograph')).toBeGreaterThanOrEqual(95);
    expect(rate('number')).toBeGreaterThanOrEqual(90);
    expect(rate('sentence')).toBeGreaterThanOrEqual(90);
  }, 120000);
});

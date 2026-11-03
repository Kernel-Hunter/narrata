import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tokenTimings } from '../src/core/align';
import { tokenizeWords } from '../src/core/text';
import { EnglishG2P } from '../src/engine/g2p/english';
import type { DataLoader } from '../src/engine/g2p/misaki/data';
import { MAX_PRONUNCIATIONS, Pronouncer, normalizePronunciations, phonemizeWith } from '../src/engine/g2p/pronunciations';
import { loadPronunciations, savePronunciations, upsertPronunciation } from '../src/store/pronunciations';

const dataDir = join(__dirname, '../src/engine/g2p/data');
const load: DataLoader = async (name) => {
  const b = readFileSync(join(dataDir, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const g2p = new EnglishG2P(load);

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

describe('normalizePronunciations', () => {
  it('trims, drops empty entries and keeps the last entry for a word', () => {
    expect(
      normalizePronunciations([
        { word: '  nginx ', sayAs: ' engine   x ' },
        { word: '', sayAs: 'x' },
        { word: 'GIF', sayAs: '' },
        { word: '!!', sayAs: 'bang bang' },
        { word: 'NGINX', sayAs: 'engine ex' },
        null,
        'nonsense',
      ]),
    ).toEqual([{ word: 'NGINX', sayAs: 'engine ex' }]);
    expect(normalizePronunciations('not a list')).toEqual([]);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: MAX_PRONUNCIATIONS + 20 }, (_, i) => ({ word: `w${i}`, sayAs: 'x' }));
    expect(normalizePronunciations(many)).toHaveLength(MAX_PRONUNCIATIONS);
  });
});

describe('Pronouncer.rewrite', () => {
  const p = new Pronouncer([
    { word: 'nginx', sayAs: 'engine x' },
    { word: 'New York', sayAs: 'Noo Yawk' },
    { word: 'New York City', sayAs: 'the big apple' },
    { word: 'C++', sayAs: 'C plus plus' },
  ]);

  it('replaces whole words, ignoring case', () => {
    expect(p.rewrite('Run NGINX, then nginx\'s config.').text).toBe("Run engine x, then engine x's config.");
    expect(p.rewrite('nginxes and unginx stay').changed).toBe(false);
    expect(p.rewrite('I wrote C++ today.').text).toBe('I wrote C plus plus today.');
  });

  it('prefers the longest phrase and allows any spacing inside it', () => {
    expect(p.rewrite('In New York City now.').text).toBe('In the big apple now.');
    expect(p.rewrite('In New\nYork today.').text).toBe('In Noo Yawk today.');
  });

  it('maps offsets in the new text back to the original', () => {
    const text = 'Use nginx here.';
    const r = p.rewrite(text);
    expect(r.text).toBe('Use engine x here.');
    // "Use" is unchanged.
    expect([r.start(0), r.end(3)]).toEqual([0, 3]);
    // "engine" and "x" both cover "nginx".
    const engine = r.text.indexOf('engine');
    expect([r.start(engine), r.end(engine + 6)]).toEqual([4, 9]);
    const x = r.text.indexOf('x ');
    expect([r.start(x), r.end(x + 1)]).toEqual([4, 9]);
    // "here" and the full stop shift back.
    const here = r.text.indexOf('here');
    expect(text.slice(r.start(here), r.end(here + 4))).toBe('here');
    expect([r.start(r.text.length), r.end(r.text.length)]).toEqual([text.length, text.length]);
  });

  it('leaves text alone when the list is empty', () => {
    const r = new Pronouncer([]).rewrite('Nothing to do.');
    expect(r.changed).toBe(false);
    expect(r.text).toBe('Nothing to do.');
  });
});

describe('phonemizeWith', () => {
  it('reads a listed word as its spelling and keeps the tokens on the original text', async () => {
    const p = new Pronouncer([{ word: 'nginx', sayAs: 'engine x' }]);
    const text = 'Restart nginx now.';
    const g = await phonemizeWith(g2p, p, text, 'a');
    const expected = await g2p.phonemize('Restart engine x now.', 'a');
    expect(g.phonemes).toBe(expected.phonemes);
    const nginx = { start: text.indexOf('nginx'), end: text.indexOf('nginx') + 5 };
    const covering = g.tokens.filter((t) => t.start === nginx.start && t.end === nginx.end);
    expect(covering.map((t) => t.phonemes).join(' ')).toBe(expected.tokens.filter((t) => /^(engine|x)$/.test('Restart engine x now.'.slice(t.start, t.end))).map((t) => t.phonemes).join(' '));
    for (const t of g.tokens) expect(t.end).toBeLessThanOrEqual(text.length);
  });

  it('gives every word of the original text a time, in order', async () => {
    const p = new Pronouncer([{ word: 'nginx', sayAs: 'engine x' }]);
    const text = 'Restart nginx now.';
    const g = await phonemizeWith(g2p, p, text, 'a');
    // One model token per phoneme character, as in the worker; every phoneme lasts 2 frames.
    const phonemes: string[] = [];
    const owner: number[] = [];
    g.tokens.forEach((t, i) => {
      for (const c of t.phonemes) {
        phonemes.push(c);
        owner.push(i);
      }
      if (t.whitespace) {
        phonemes.push(' ');
        owner.push(-1);
      }
    });
    const durations = [1, ...phonemes.map(() => 2), 1];
    const words = tokenizeWords(text);
    const timing = tokenTimings({ words, tokens: g.tokens, phonemes, owner, durations, samples: 24000, sampleRate: 24000 });
    expect(timing).not.toBeNull();
    expect(timing!.starts).toHaveLength(3);
    expect(timing!.starts[0]).toBeLessThan(timing!.starts[1]);
    expect(timing!.starts[1]).toBeLessThan(timing!.starts[2]);
  });
});

describe('pronunciation storage', () => {
  it('saves, loads and updates the list', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    expect(loadPronunciations(storage)).toEqual([]);
    let list = upsertPronunciation([], { word: 'nginx', sayAs: 'engine x' });
    list = upsertPronunciation(list, { word: 'Saoirse', sayAs: 'sur sha' });
    list = upsertPronunciation(list, { word: 'NGINX', sayAs: 'engine ex' });
    expect(list).toEqual([
      { word: 'Saoirse', sayAs: 'sur sha' },
      { word: 'NGINX', sayAs: 'engine ex' },
    ]);
    savePronunciations(list, storage);
    expect(loadPronunciations(storage)).toEqual(list);
  });

  it('ignores a broken stored value', () => {
    const storage = new MemoryStorage() as unknown as Storage;
    storage.setItem('narrata.pronunciations', '{oops');
    expect(loadPronunciations(storage)).toEqual([]);
  });
});

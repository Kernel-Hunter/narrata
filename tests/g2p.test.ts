import { describe, expect, it } from 'vitest';
import { flipMoney, normalizeText, pointNum, splitNum, splitPunctuation } from '../src/engine/g2p/normalize';
import { EspeakG2P } from '../src/engine/g2p/espeak';

describe('text normalisation', () => {
  it('reads years, times, money and decimals the way people say them', () => {
    expect(splitNum('1987')).toBe('19 87');
    expect(splitNum('1900s')).toBe('19 hundreds');
    expect(splitNum('2005')).toBe('2005');
    expect(splitNum('10:05')).toBe('10 oh 5');
    expect(flipMoney('$5.50')).toBe('5 dollars and 50 cents');
    expect(flipMoney('£1')).toBe('1 pound');
    expect(pointNum('3.14')).toBe('3 point 1 4');
    expect(normalizeText('Dr. Smith paid $3 in 1987.')).toBe('Doctor Smith paid 3 dollars in 19 87.');
  });

  it('keeps punctuation as separate sections', () => {
    expect(splitPunctuation('Hello, world.')).toEqual([
      { punct: false, text: 'Hello' },
      { punct: true, text: ', ' },
      { punct: false, text: 'world' },
      { punct: true, text: '.' },
    ]);
  });
});

describe('eSpeak G2P', () => {
  it('produces Kokoro phonemes with one phoneme word per spoken word', async () => {
    const g2p = new EspeakG2P();
    const ph = await g2p.phonemize('The keeper climbed the stairs.', 'a');
    expect(ph).toMatch(/kˈiːpɚ/);
    expect(ph.endsWith('.')).toBe(true);
    const gb = await g2p.phonemize('The keeper.', 'b');
    expect(gb).toMatch(/kˈiːpə/);
  });
});

// What to say for a word that is in neither lexicon and is not a number.

import { BartFallback } from './fallback';
import type { Fallback } from './g2p';
import type { Lexicon } from './lexicon';
import { cardinalWords } from './numbers';

export function makeFallback(lexicon: Lexicon, bart: BartFallback | null): Fallback {
  const noContext = { futureVowel: null, futureTo: false };
  const read = (word: string): string => {
    // The network's alphabet is ASCII letters, apostrophe, hyphen and period: drop accents.
    const plain = word.normalize('NFD').replace(/\p{M}/gu, '');
    if (!/[A-Za-z]/.test(plain)) return '';
    // Letters and digits mixed ("mp3"): numbers as words, letters on their own.
    if (/\d/.test(plain)) {
      return (plain.match(/\d+|[A-Za-z]+/g) ?? [])
        .map((p) => (/\d/.test(p) ? cardinalWords(BigInt(p)).map((w) => lexicon.getWord(w, 'CD', null, noContext)[0] ?? '').join(' ') : read(p)))
        .filter(Boolean)
        .join(' ');
    }
    // Short words without vowels are abbreviations, read letter by letter ("ml", "Sgt").
    const letters = plain.replace(/[^A-Za-z]/g, '');
    if (letters.length <= 4 && /^[A-Za-z.]+$/.test(plain) && !/[aeiouy]/i.test(letters)) {
      const [ps] = lexicon.getNNP(letters);
      if (ps) return ps;
    }
    return bart ? bart.run(plain) : '';
  };
  return (tk) => [read(tk.alias ?? tk.text), 1];
}

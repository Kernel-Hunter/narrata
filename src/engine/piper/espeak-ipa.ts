// Piper voices were trained on eSpeak NG's IPA. Narrata's G2P (a port of misaki) writes Kokoro's
// symbols, which misaki derives from eSpeak's with a fixed table (misaki/espeak.py, E2M). This
// maps them back: diphthongs and affricates become two symbols again, the American flap is ɾ,
// r-coloured vowels become ɚ and ɜː, and American English gets eSpeak's long-vowel marks.

const SINGLE: Record<string, string> = {
  A: 'eɪ',
  I: 'aɪ',
  W: 'aʊ',
  Y: 'ɔɪ',
  O: 'oʊ',
  Q: 'əʊ',
  ʤ: 'dʒ',
  ʧ: 'tʃ',
  T: 'ɾ',
  ᵊ: 'ə',
};

const VOWELS = new Set('aeiouæɑɒɔəɚɛɜɪʊʌᵻɐAIWYOQᵊ');
const STRESS = new Set('ˈˌ');
/** Vowels eSpeak writes long in American English when stressed. */
const LONG_US = new Set('iuɑɔ');

/** Convert the phonemes of one word (or punctuation token) to eSpeak-style IPA. */
export function toEspeakIpa(ph: string, british: boolean): string {
  const chars = [...ph];
  let out = '';
  let stressed = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (STRESS.has(c)) {
      stressed = true;
      out += c;
      continue;
    }
    if (!british && c === 'ə' && next === 'ɹ') {
      // "keeper" kˈipəɹ -> kˈiːpɚ
      out += 'ɚ';
      i++;
      stressed = false;
      continue;
    }
    if (!british && c === 'ɜ' && next === 'ɹ') {
      // "bird" bˈɜɹd -> bˈɜːd, "hurry" hˈɜɹi -> hˈɜːɹi
      const after = chars[i + 2];
      out += after && VOWELS.has(after) ? 'ɜːɹ' : 'ɜː';
      i++;
      stressed = false;
      continue;
    }
    if (british && c === 'ɛ' && next === 'ː') {
      out += 'eə';
      i++;
      stressed = false;
      continue;
    }
    const mapped = SINGLE[c];
    if (mapped) out += mapped;
    else if (!british && stressed && LONG_US.has(c) && next !== 'ː' && next !== 'ə') out += c + 'ː';
    else out += c;
    if (VOWELS.has(c)) stressed = false;
  }
  return out;
}

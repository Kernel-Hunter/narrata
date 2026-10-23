// English text normalisation before phonemisation: quotes, titles, years, times, money and
// decimals. Adapted from kokoro-js 1.2.1 (Apache-2.0, Copyright hexgrad and contributors),
// which follows the normalisation in the reference Kokoro implementation.

/** "1987" -> "19 87", "2005" -> "2005", "1900s" -> "19 hundreds", "10:30" -> "10 30". */
export function splitNum(s: string): string {
  if (s.includes('.')) return s;
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    if (m === 0) return `${h} o'clock`;
    if (m < 10) return `${h} oh ${m}`;
    return `${h} ${m}`;
  }
  const year = parseInt(s.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return s;
  const left = s.slice(0, 2);
  const right = parseInt(s.slice(2, 4), 10);
  const suffix = s.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

/** "$5.50" -> "5 dollars and 50 cents". */
export function flipMoney(s: string): string {
  const unit = s[0] === '$' ? 'dollar' : 'pound';
  const amount = s.slice(1);
  if (isNaN(Number(amount))) return `${amount} ${unit}s`;
  if (!amount.includes('.')) return `${amount} ${unit}${amount === '1' ? '' : 's'}`;
  const [whole, frac] = amount.split('.');
  const cents = parseInt(frac.padEnd(2, '0'), 10);
  const small = s[0] === '$' ? (cents === 1 ? 'cent' : 'cents') : cents === 1 ? 'penny' : 'pence';
  return `${whole} ${unit}${whole === '1' ? '' : 's'} and ${cents} ${small}`;
}

/** "3.14" -> "3 point 1 4". */
export function pointNum(s: string): string {
  const [a, b] = s.split('.');
  return `${a} point ${b.split('').join(' ')}`;
}

export function normalizeText(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/(?<=\n) +(?=\n)/g, '')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCTUATION = ';:,.!?¡¿—…"«»“”(){}[]';
const PUNCT_RUNS = new RegExp(`(\\s*[${PUNCTUATION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]+\\s*)+`, 'g');

/** Split text into alternating plain and punctuation sections (punctuation is kept verbatim). */
export function splitPunctuation(text: string): { punct: boolean; text: string }[] {
  const out: { punct: boolean; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(PUNCT_RUNS)) {
    if (last < m.index!) out.push({ punct: false, text: text.slice(last, m.index) });
    if (m[0].length) out.push({ punct: true, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ punct: false, text: text.slice(last) });
  return out;
}

/** Post-process eSpeak IPA into Kokoro's symbol set. */
export function fixPhonemes(ps: string, lang: 'a' | 'b'): string {
  let out = ps
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (lang === 'a') out = out.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return out.trim();
}

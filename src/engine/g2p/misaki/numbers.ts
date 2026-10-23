// English number words. misaki spells numbers with the num2words package; this is an independent
// implementation that produces the same words for cardinals, ordinals, years and decimals (only
// the words matter: misaki splits num2words' output on anything that is not a letter, and drops
// "and").

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion', 'septillion', 'octillion', 'nonillion', 'decillion'];
const ORDINAL: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', four: 'fourth', five: 'fifth', six: 'sixth', seven: 'seventh',
  eight: 'eighth', nine: 'ninth', ten: 'tenth', eleven: 'eleventh', twelve: 'twelfth',
};

/** Words for 1..999. */
function below1000(n: number, out: string[]): void {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) out.push(ONES[h], 'hundred');
  if (r >= 20) {
    out.push(TENS[Math.floor(r / 10)]);
    if (r % 10) out.push(ONES[r % 10]);
  } else if (r) out.push(ONES[r]);
}

/** Cardinal number as a list of words ("1,234" -> one thousand two hundred thirty four). */
export function cardinalWords(value: bigint | number): string[] {
  let n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const out: string[] = [];
  if (n < 0n) {
    out.push('minus');
    n = -n;
  }
  if (n === 0n) return [...out, 'zero'];
  const groups: number[] = [];
  while (n > 0n) {
    groups.push(Number(n % 1000n));
    n /= 1000n;
  }
  if (groups.length > SCALES.length) return [...out, ...String(value).replace('-', '').split('').map((d) => ONES[Number(d)])];
  for (let g = groups.length - 1; g >= 0; g--) {
    if (!groups[g]) continue;
    below1000(groups[g], out);
    if (SCALES[g]) out.push(SCALES[g]);
  }
  return out;
}

export function ordinalWords(value: bigint | number): string[] {
  const words = cardinalWords(value);
  const last = words[words.length - 1];
  words[words.length - 1] = ORDINAL[last] ?? (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th');
  return words;
}

/** Year reading: 1987 -> nineteen eighty seven, 1905 -> nineteen oh five, 2005 -> two thousand five. */
export function yearWords(value: number): string[] {
  const n = Math.abs(value);
  const high = Math.floor(n / 100);
  const low = n % 100;
  let words: string[];
  if (high === 0 || (high % 10 === 0 && low < 10) || high >= 100) words = cardinalWords(n);
  else {
    words = cardinalWords(high);
    if (low === 0) words.push('hundred');
    else if (low < 10) words.push('oh', ...cardinalWords(low));
    else words.push(...cardinalWords(low));
  }
  if (value < 0) words.push('BC');
  return words;
}

/**
 * A decimal read digit by digit after the point ("3.14" -> three point one four). The number of
 * digits comes from the shortest representation of the parsed float, as in Python's str(float).
 */
export function decimalWords(text: string): string[] {
  const value = parseFloat(text);
  // num2words reads a float with an integral value as an integer ("2.0" -> two).
  if (Number.isInteger(value)) return cardinalWords(BigInt(value));
  const repr = String(value);
  const dot = repr.indexOf('.');
  const precision = dot < 0 ? 0 : repr.length - dot - 1;
  const pre = Math.trunc(value);
  let post = Math.abs(value - pre) * 10 ** precision;
  post = Math.abs(Math.round(post) - post) < 0.01 ? Math.round(post) : Math.floor(post);
  const digits = String(post).padStart(precision, '0');
  const out = cardinalWords(pre);
  if (precision) out.push('point');
  for (let i = 0; i < precision; i++) out.push(...cardinalWords(Number(digits[i])));
  return out;
}

// Narrata's additions to misaki, for text misaki leaves to its eSpeak fallback: clock times,
// common abbreviations ("St.", "Inc.", "Sgt."), units after numbers ("5 km"), web addresses and
// email addresses. They run on the tagged tokens before misaki's own steps and only touch tokens
// misaki cannot read itself (email addresses excepted: misaki reads them without the dots).

import { cardinalWords, decimalWords } from './numbers';
import type { Lexicon } from './lexicon';
import type { MToken } from './g2p';

/** Abbreviation -> word. Titles (and "vs.") are followed by a name, so the period after them is not a pause. */
const TITLES: Record<string, string> = {
  Capt: 'captain', Col: 'colonel', Cpl: 'corporal', Gen: 'general', Gov: 'governor', Lt: 'lieutenant', Maj: 'major',
  Pres: 'president', Prof: 'professor', Pvt: 'private', Rep: 'representative', Rev: 'reverend', Sen: 'senator',
  Sgt: 'sergeant', Supt: 'superintendent', Fr: 'father', Hon: 'honorable', Adm: 'admiral', Cmdr: 'commander',
  Mt: 'mount', Ft: 'fort', Pt: 'point', vs: 'versus',
};
const WORDS: Record<string, string> = {
  Jr: 'junior', Sr: 'senior', Inc: 'incorporated', Ltd: 'limited', Co: 'company', Corp: 'corporation', Bros: 'brothers',
  Dept: 'department', Vol: 'volume', Fig: 'figure', approx: 'approximately', Ave: 'avenue', Blvd: 'boulevard', Rd: 'road',
  Jan: 'january', Feb: 'february', Mar: 'march', Apr: 'april', Jun: 'june', Jul: 'july', Aug: 'august', Sep: 'september',
  Sept: 'september', Oct: 'october', Nov: 'november', Dec: 'december',
};
/** Units read in full after a number: [singular, plural]. */
const UNITS: Record<string, [string, string]> = {
  km: ['kilometer', 'kilometers'], kg: ['kilogram', 'kilograms'], mg: ['milligram', 'milligrams'], g: ['gram', 'grams'],
  cm: ['centimeter', 'centimeters'], mm: ['millimeter', 'millimeters'], ml: ['milliliter', 'milliliters'],
  lb: ['pound', 'pounds'], lbs: ['pound', 'pounds'], oz: ['ounce', 'ounces'], ft: ['foot', 'feet'],
  hr: ['hour', 'hours'], hrs: ['hour', 'hours'], min: ['minute', 'minutes'], mph: ['mile per hour', 'miles per hour'],
  kph: ['kilometer per hour', 'kilometers per hour'], kmh: ['kilometer per hour', 'kilometers per hour'],
};

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const NUMBER = /^[\d,.]+$/;
const RATIO = /^(\d+):(\d+)$/;
const UNIT = /^(\d[\d,]*(?:\.\d+)?)?([a-z]+)(\.?)$/;

function numberWords(text: string): string[] {
  return text.includes('.') ? decimalWords(text.replaceAll(',', '')) : cardinalWords(BigInt(text.replaceAll(',', '')));
}
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;
const TLD = 'com|org|net|edu|gov|io|ai|app|dev|co|uk|us|ca|de|fr|info|me|tv|ly|so|xyz|tech|blog|site';
const WEB_ADDRESS = new RegExp(`^(?:(?:https?|ftp)://\\S+|www\\.\\S+|[\\w-]+(?:\\.[\\w-]+)*\\.(?:${TLD})(?:/\\S*)?)$`, 'i');
const URL_SYMBOLS: Record<string, string> = { '.': 'dot', '@': 'at', '/': 'slash', '-': 'dash', _: 'underscore', '+': 'plus', '~': 'tilde', '#': 'hash', '=': 'equals', '&': 'and' };

/** Reads a web or email address piece by piece: "jane.doe@example.com" -> jane dot doe at example dot com. */
function readAddress(text: string, readWord: (w: string) => string | null): string | null {
  // Leave out the scheme and anything after the path ("https://", "?q=1", "#top", a final slash).
  const address = text.replace(/^(?:https?|ftp):\/\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const out: string[] = [];
  for (const [piece] of address.matchAll(/\p{L}+|\d+|./gu)) {
    let ps: string | null;
    if (/^\d+$/.test(piece)) ps = piece.length > 4 ? [...piece].map((d) => readWord(d)).join(' ') : readWord(piece);
    else if (/^\p{L}+$/u.test(piece)) ps = readWord(/^www$/i.test(piece) ? 'WWW' : piece.toLowerCase());
    else ps = Object.hasOwn(URL_SYMBOLS, piece) ? readWord(URL_SYMBOLS[piece]) : '';
    if (ps === null) return null;
    if (ps) out.push(ps);
  }
  return out.length ? out.join(' ') : null;
}

/**
 * `readWord` gives the phonemes of a single word (lexicon, then the fallback), for the pieces of
 * web and email addresses.
 */
export function normalizeTokens(tokens: MToken[], lexicon: Lexicon, readWord?: (w: string) => string | null): void {
  const noContext = { futureVowel: null, futureTo: false };
  const phonemesOf = (words: string[]): string | null => {
    const out: string[] = [];
    for (const w of words) {
      const ps = readWord ? readWord(w) : lexicon.getWord(w, 'NN', null, noContext)[0];
      if (!ps) return null;
      out.push(ps);
    }
    return out.join(' ');
  };
  const known = (w: string) => lexicon.golds.has(w) || lexicon.silvers.has(w);
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const next = tokens[i + 1];
    // A period after a word and before a lower-case word marks an abbreviation ("The Ave. was
    // closed"), not the end of a sentence.
    const prevTk = tokens[i - 1];
    if (tk.text === '.' && prevTk && !prevTk.whitespace && /\p{L}$/u.test(prevTk.text) && next && /^\p{Ll}/u.test(next.text)) {
      tk.phonemes = '';
      continue;
    }
    // 10:30 -> ten thirty, 7:05 -> seven oh five, 9:00 -> nine o'clock.
    const time = TIME.exec(tk.text);
    if (time) {
      const h = Number(time[1]);
      const m = Number(time[2]);
      const words = [...cardinalWords(h), ...(m === 0 ? ["o'clock"] : m < 10 ? ['oh', ...cardinalWords(m)] : cardinalWords(m))];
      const ps = phonemesOf(words);
      if (ps !== null) tk.phonemes = ps;
      continue;
    }
    // Ratios and scores: 16:9 -> sixteen to nine.
    const ratio = RATIO.exec(tk.text);
    if (ratio) {
      const ps = phonemesOf([...numberWords(ratio[1]), 'to', ...numberWords(ratio[2])]);
      if (ps !== null) tk.phonemes = ps;
      continue;
    }
    // "#1" -> number one, "the # key" -> the hash key.
    if (tk.text === '#') {
      const numbered = next !== undefined && !tk.whitespace && /^\d/.test(next.text);
      const ps = phonemesOf([numbered ? 'number' : 'hash']);
      if (ps !== null) tk.phonemes = ps;
      if (numbered) tk.whitespace = ' ';
      continue;
    }
    if (readWord && (EMAIL.test(tk.text) || WEB_ADDRESS.test(tk.text)) && /\p{L}/u.test(tk.text)) {
      const ps = readAddress(tk.text, readWord);
      if (ps !== null) {
        tk.phonemes = ps;
        continue;
      }
    }
    // Units after a number: "5 km", "3 lbs.", "10kg" (misaki leaves them to eSpeak, which spells them).
    const unit = UNIT.exec(tk.text);
    if (unit && Object.hasOwn(UNITS, unit[2])) {
      const prev = tokens[i - 1];
      const attached = unit[1];
      const num = attached ?? (prev && NUMBER.test(prev.text) && /\d/.test(prev.text) ? prev.text : null);
      if (num !== null) {
        const [one, many] = UNITS[unit[2]];
        const words = [...(attached ? numberWords(attached) : []), ...(num === '1' ? one : many).split(' ')];
        const ps = phonemesOf(words);
        if (ps !== null) {
          // "10kg": a space between the number and the unit.
          if (!attached && !prev.whitespace) prev.whitespace = ' ';
          // A period after the unit ends the sentence unless a lower-case word follows ("3 lbs. of flour").
          const midSentence = (t: MToken | undefined) => t !== undefined && /^\p{Ll}/u.test(t.text);
          tk.phonemes = unit[3] && !midSentence(next) ? ps + '.' : ps;
          if (!unit[3] && next?.text === '.' && !tk.whitespace && midSentence(tokens[i + 2])) next.phonemes = '';
          continue;
        }
      }
    }
    // "St." is one token, "Sgt." can be "Sgt" + "."
    const dotted = tk.text.endsWith('.') && tk.text.length > 1;
    const base = dotted ? tk.text.slice(0, -1) : tk.text;
    const period = !dotted && next && next.text === '.' && !tk.whitespace ? next : null;
    if (!(dotted || period) || known(tk.text) || (period && known(tk.text + '.'))) continue;
    // Only where misaki would give up on the word ("Prof." is "prof" in its lexicon).
    // "vs." is the exception: the lexicon has "vs" as the plural of the letter V.
    if (base !== 'vs' && lexicon.getWord(base, tk.tag, null, noContext)[0] !== null) continue;
    let word: string | undefined;
    let title = false;
    if (base === 'St') {
      // St. Louis, but Main St.
      const after = period ? tokens[i + 2] : next;
      word = after && /^\p{Lu}/u.test(after.text) ? 'saint' : 'street';
      title = word === 'saint';
    } else if (Object.hasOwn(TITLES, base)) {
      word = TITLES[base];
      title = true;
    } else if (Object.hasOwn(WORDS, base)) word = WORDS[base];
    if (!word) continue;
    const ps = phonemesOf([word]);
    if (ps === null) continue;
    // The period of an abbreviation is not a pause unless it ends the sentence.
    const after = period ? tokens[i + 2] : next;
    const continues = after !== undefined && (title || /^[\p{Ll}\p{Nd}]/u.test(after.text));
    tk.phonemes = dotted && !continues ? ps + '.' : ps;
    if (period && continues) period.phonemes = '';
  }
}

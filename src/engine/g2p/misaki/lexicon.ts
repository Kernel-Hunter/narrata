// Port of the Lexicon class from misaki/en.py (misaki 0.9.4, Apache-2.0, Copyright hexgrad).
// https://github.com/hexgrad/misaki/blob/main/misaki/en.py
// Dictionary lookup (gold, then silver), capitalisation and stress, possessives, the -s / -ed /
// -ing suffix rules, special cases (a, the, to, in, used...) and numbers. Comments name the
// Python function each piece comes from.

import { cardinalWords, decimalWords, ordinalWords, yearWords } from './numbers';

export type Entry = string | { [tag: string]: string | null };
export type Phonemes = string | null;
/** Phonemes and misaki's rating (how sure the lexicon is: 4 gold, 3 silver...). */
export type Lookup = [Phonemes, number | null];

export interface TokenContext {
  /** Whether the next spoken token starts with a vowel (null: punctuation or end follows). */
  futureVowel: boolean | null;
  /** Whether the next token is "to". */
  futureTo: boolean;
}

export const PRIMARY_STRESS = 'ˈ';
export const SECONDARY_STRESS = 'ˌ';
const STRESSES = 'ˌˈ';
export const VOWELS = new Set('AIOQWYaiuæɑɒɔəɛɜɪʊʌᵻ');
export const CONSONANTS = new Set('bdfhjklmnpstvwzðŋɡɹɾʃʒʤʧθ');
const US_TAUS = new Set('AIOWYiuæɑəɛɪɹʊʌ');
export const CURRENCIES: Record<string, [string, string]> = { $: ['dollar', 'cent'], '£': ['pound', 'pence'], '€': ['euro', 'cent'] };
const ORDINALS = new Set(['st', 'nd', 'rd', 'th']);
const ADD_SYMBOLS: Record<string, string> = { '.': 'dot', '/': 'slash' };
export const SYMBOLS: Record<string, string> = { '%': 'percent', '&': 'and', '+': 'plus', '@': 'at' };

// LEXICON_ORDS: apostrophe, hyphen, A-Z, a-z.
const lexiconChar = (c: string) => c === "'" || c === '-' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
const allLexiconChars = (w: string) => [...w].every(lexiconChar);
const isAlpha = (w: string) => w.length > 0 && /^\p{L}+$/u.test(w);
export const isDigit = (w: string) => /^[0-9]+$/.test(w);
/** Python's str.capitalize(). */
export const capitalize = (w: string) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);

/** apply_stress */
export function applyStress(ps: Phonemes, stress: number | null): Phonemes {
  if (ps === null) return null;
  const restress = (s: string) => {
    const chars = [...s];
    const pos: [number, string][] = chars.map((c, i) => [i, c]);
    chars.forEach((c, i) => {
      if (!STRESSES.includes(c)) return;
      const j = chars.findIndex((v, k) => k >= i && VOWELS.has(v));
      pos[i] = [j - 0.5, c];
    });
    return pos
      .sort((a, b) => a[0] - b[0])
      .map((p) => p[1])
      .join('');
  };
  const hasVowel = [...ps].some((c) => VOWELS.has(c));
  const noStress = !ps.includes(PRIMARY_STRESS) && !ps.includes(SECONDARY_STRESS);
  if (stress === null) return ps;
  if (stress < -1) return ps.replaceAll(PRIMARY_STRESS, '').replaceAll(SECONDARY_STRESS, '');
  if (stress === -1 || ((stress === 0 || stress === -0.5) && ps.includes(PRIMARY_STRESS))) {
    return ps.replaceAll(SECONDARY_STRESS, '').replaceAll(PRIMARY_STRESS, SECONDARY_STRESS);
  }
  if ((stress === 0 || stress === 0.5 || stress === 1) && noStress) return hasVowel ? restress(SECONDARY_STRESS + ps) : ps;
  if (stress >= 1 && !ps.includes(PRIMARY_STRESS) && ps.includes(SECONDARY_STRESS)) return ps.replaceAll(SECONDARY_STRESS, PRIMARY_STRESS);
  if (stress > 1 && noStress) return hasVowel ? restress(PRIMARY_STRESS + ps) : ps;
  return ps;
}

/** Lexicon.get_parent_tag */
export function parentTag(tag: string | null): string | null {
  if (tag === null) return null;
  if (tag.startsWith('VB')) return 'VERB';
  if (tag.startsWith('NN')) return 'NOUN';
  if (tag.startsWith('ADV') || tag.startsWith('RB')) return 'ADV';
  if (tag.startsWith('ADJ') || tag.startsWith('JJ')) return 'ADJ';
  return tag;
}

/**
 * A dictionary as misaki's Lexicon.grow_dictionary sees it: every lowercase word also answers to
 * its capitalised form and every capitalised word to its lowercase form, without storing both.
 */
export class Dictionary {
  private readonly d: Map<string, Entry>;

  constructor(d: Map<string, Entry>) {
    this.d = d;
  }

  get(k: string): Entry | undefined {
    const v = this.d.get(k);
    if (v !== undefined || k.length < 2) return v;
    const lower = k.toLowerCase();
    if (k !== lower && k === capitalize(lower)) {
      if (lower !== capitalize(lower)) return this.d.get(lower);
    } else if (k === lower) {
      const cap = capitalize(k);
      if (cap !== k) return this.d.get(cap);
    }
    return undefined;
  }

  has(k: string): boolean {
    return this.get(k) !== undefined;
  }
}

export interface Features {
  tag: string | null;
  isHead: boolean;
  currency: string | null;
  numFlags: string;
  stress: number | null;
}

export class Lexicon {
  readonly capStresses: [number, number] = [0.5, 2];
  readonly golds: Dictionary;
  readonly silvers: Dictionary;
  readonly british: boolean;

  constructor(golds: Dictionary, silvers: Dictionary, british: boolean) {
    this.golds = golds;
    this.silvers = silvers;
    this.british = british;
  }

  private gold(k: string): string {
    return this.golds.get(k) as string;
  }

  /** get_NNP: spell a word letter by letter (acronyms). */
  getNNP(word: string): Lookup {
    const ps: string[] = [];
    for (const c of word) {
      if (!/\p{L}/u.test(c)) continue;
      const p = this.golds.get(c.toUpperCase());
      if (typeof p !== 'string') return [null, null];
      ps.push(p);
    }
    const joined = applyStress(ps.join(''), 0)!;
    const i = joined.lastIndexOf(SECONDARY_STRESS);
    return [i < 0 ? joined : joined.slice(0, i) + PRIMARY_STRESS + joined.slice(i + 1), 3];
  }

  /** get_special_case */
  getSpecialCase(word: string, tag: string | null, stress: number | null, ctx: TokenContext): Lookup {
    if (tag === 'ADD' && Object.hasOwn(ADD_SYMBOLS, word)) return this.lookup(ADD_SYMBOLS[word], null, -0.5, ctx);
    if (Object.hasOwn(SYMBOLS, word)) return this.lookup(SYMBOLS[word], null, null, ctx);
    const stripped = word.replace(/^\.+|\.+$/g, '');
    if (stripped.includes('.') && isAlpha(word.replaceAll('.', '')) && Math.max(...word.split('.').map((p) => [...p].length)) < 3) {
      return this.getNNP(word);
    }
    if (word === 'a' || word === 'A') return [tag === 'DT' ? 'ɐ' : 'ˈA', 4];
    if (word === 'am' || word === 'Am' || word === 'AM') {
      if (tag?.startsWith('NN')) return this.getNNP(word);
      if (ctx.futureVowel === null || word !== 'am' || (stress !== null && stress > 0)) return [this.gold('am'), 4];
      return ['ɐm', 4];
    }
    if (word === 'an' || word === 'An' || word === 'AN') {
      if (word === 'AN' && tag?.startsWith('NN')) return this.getNNP(word);
      return ['ɐn', 4];
    }
    if (word === 'I' && tag === 'PRP') return [`${SECONDARY_STRESS}I`, 4];
    if ((word === 'by' || word === 'By' || word === 'BY') && parentTag(tag) === 'ADV') return ['bˈI', 4];
    if (word === 'to' || word === 'To' || (word === 'TO' && (tag === 'TO' || tag === 'IN'))) {
      return [ctx.futureVowel === null ? this.gold('to') : ctx.futureVowel ? 'tʊ' : 'tə', 4];
    }
    if (word === 'in' || word === 'In' || (word === 'IN' && tag !== 'NNP')) {
      const s = ctx.futureVowel === null || tag !== 'IN' ? PRIMARY_STRESS : '';
      return [s + 'ɪn', 4];
    }
    if (word === 'the' || word === 'The' || (word === 'THE' && tag === 'DT')) return [ctx.futureVowel === true ? 'ði' : 'ðə', 4];
    if (tag === 'IN' && /^vs\.?$/i.test(word)) return this.lookup('versus', null, null, ctx);
    if (word === 'used' || word === 'Used' || word === 'USED') {
      const used = this.golds.get('used') as Record<string, string>;
      if ((tag === 'VBD' || tag === 'JJ') && ctx.futureTo) return [used.VBD, 4];
      return [used.DEFAULT, 4];
    }
    return [null, null];
  }

  /** is_known */
  isKnown(word: string): boolean {
    if (this.golds.has(word) || Object.hasOwn(SYMBOLS, word) || this.silvers.has(word)) return true;
    if (!isAlpha(word) || !allLexiconChars(word)) return false;
    if (word.length === 1) return true;
    if (word === word.toUpperCase() && this.golds.has(word.toLowerCase())) return true;
    return word.slice(1) === word.slice(1).toUpperCase();
  }

  /** lookup */
  lookup(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): Lookup {
    let isNNP: boolean | null = null;
    if (word === word.toUpperCase() && !this.golds.has(word)) {
      word = word.toLowerCase();
      isNNP = tag === 'NNP';
    }
    let entry: Entry | null | undefined = this.golds.get(word);
    let rating = 4;
    if (entry === undefined && !isNNP) {
      entry = this.silvers.get(word);
      rating = 3;
    }
    let ps: Phonemes = null;
    if (entry !== undefined && entry !== null && typeof entry === 'object') {
      let t: string | null = tag;
      if (ctx && ctx.futureVowel === null && 'None' in entry) t = 'None';
      else if (t === null || !(t in entry)) t = parentTag(t);
      ps = t !== null && t in entry ? entry[t] : entry.DEFAULT;
    } else ps = entry ?? null;
    if (ps === null || (isNNP && !ps.includes(PRIMARY_STRESS))) {
      const [nnp, r] = this.getNNP(word);
      if (nnp !== null) return [nnp, r];
    }
    return [applyStress(ps, stress), rating];
  }

  /** _s */
  private s(stem: Phonemes): Phonemes {
    if (!stem) return null;
    const last = stem[stem.length - 1];
    if ('ptkfθ'.includes(last)) return stem + 's';
    if ('szʃʒʧʤ'.includes(last)) return stem + (this.british ? 'ɪ' : 'ᵻ') + 'z';
    return stem + 'z';
  }

  /** stem_s */
  stemS(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): Lookup {
    if (word.length < 3 || !word.endsWith('s')) return [null, null];
    let stem: string;
    if (!word.endsWith('ss') && this.isKnown(word.slice(0, -1))) stem = word.slice(0, -1);
    else if ((word.endsWith("'s") || (word.length > 4 && word.endsWith('es') && !word.endsWith('ies'))) && this.isKnown(word.slice(0, -2))) stem = word.slice(0, -2);
    else if (word.length > 4 && word.endsWith('ies') && this.isKnown(word.slice(0, -3) + 'y')) stem = word.slice(0, -3) + 'y';
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.s(ps), rating];
  }

  /** _ed */
  private ed(stem: Phonemes): Phonemes {
    if (!stem) return null;
    const last = stem[stem.length - 1];
    if ('pkfθʃsʧ'.includes(last)) return stem + 't';
    if (last === 'd') return stem + (this.british ? 'ɪ' : 'ᵻ') + 'd';
    if (last !== 't') return stem + 'd';
    if (this.british || stem.length < 2) return stem + 'ɪd';
    if (US_TAUS.has(stem[stem.length - 2])) return stem.slice(0, -1) + 'ɾᵻd';
    return stem + 'ᵻd';
  }

  /** stem_ed */
  stemEd(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): Lookup {
    if (word.length < 4 || !word.endsWith('d')) return [null, null];
    let stem: string;
    if (!word.endsWith('dd') && this.isKnown(word.slice(0, -1))) stem = word.slice(0, -1);
    else if (word.length > 4 && word.endsWith('ed') && !word.endsWith('eed') && this.isKnown(word.slice(0, -2))) stem = word.slice(0, -2);
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.ed(ps), rating];
  }

  /** _ing */
  private ing(stem: Phonemes): Phonemes {
    if (!stem) return null;
    if (this.british) {
      if ('əː'.includes(stem[stem.length - 1])) return null;
    } else if (stem.length > 1 && stem[stem.length - 1] === 't' && US_TAUS.has(stem[stem.length - 2])) {
      return stem.slice(0, -1) + 'ɾɪŋ';
    }
    return stem + 'ɪŋ';
  }

  /** stem_ing */
  stemIng(word: string, tag: string | null, stress: number | null, ctx: TokenContext | null): Lookup {
    if (word.length < 5 || !word.endsWith('ing')) return [null, null];
    let stem: string;
    if (word.length > 5 && this.isKnown(word.slice(0, -3))) stem = word.slice(0, -3);
    else if (this.isKnown(word.slice(0, -3) + 'e')) stem = word.slice(0, -3) + 'e';
    else if (word.length > 5 && /([bcdgklmnprstvxz])\1ing$|cking$/.test(word) && this.isKnown(word.slice(0, -4))) stem = word.slice(0, -4);
    else return [null, null];
    const [ps, rating] = this.lookup(stem, tag, stress, ctx);
    return [this.ing(ps), rating];
  }

  /** get_word */
  getWord(word: string, tag: string | null, stress: number | null, ctx: TokenContext): Lookup {
    const special = this.getSpecialCase(word, tag, stress, ctx);
    if (special[0] !== null) return special;
    const wl = word.toLowerCase();
    if (
      word.length > 1 &&
      isAlpha(word.replaceAll("'", '')) &&
      word !== wl &&
      (tag !== 'NNP' || word.length > 7) &&
      !this.golds.has(word) &&
      !this.silvers.has(word) &&
      (word === word.toUpperCase() || word.slice(1) === word.slice(1).toLowerCase()) &&
      (this.golds.has(wl) || this.silvers.has(wl) || [this.stemS, this.stemEd, this.stemIng].some((fn) => fn.call(this, wl, tag, stress, ctx)[0]))
    ) {
      word = wl;
    }
    if (this.isKnown(word)) return this.lookup(word, tag, stress, ctx);
    if (word.endsWith("s'") && this.isKnown(word.slice(0, -2) + "'s")) return this.lookup(word.slice(0, -2) + "'s", tag, stress, ctx);
    if (word.endsWith("'") && this.isKnown(word.slice(0, -1))) return this.lookup(word.slice(0, -1), tag, stress, ctx);
    const s = this.stemS(word, tag, stress, ctx);
    if (s[0] !== null) return s;
    const ed = this.stemEd(word, tag, stress, ctx);
    if (ed[0] !== null) return ed;
    const ing = this.stemIng(word, tag, stress === null ? 0.5 : stress, ctx);
    if (ing[0] !== null) return ing;
    return [null, null];
  }

  /** is_currency */
  static isCurrency(word: string): boolean {
    if (!word.includes('.')) return true;
    if (word.split('.').length > 2) return false;
    const cents = word.split('.')[1];
    return cents.length < 3;
  }

  /** get_number */
  getNumber(word: string, currency: string | null, isHead: boolean, numFlags: string): Lookup {
    const sm = /[a-z']+$/.exec(word);
    const suffix = sm ? sm[0] : null;
    if (suffix) word = word.slice(0, -suffix.length);
    const result: [string, number][] = [];
    const push = (l: Lookup) => result.push(l as [string, number]);
    if (word.startsWith('-')) {
      push(this.lookup('minus', null, null, null));
      word = word.slice(1);
    }
    const extend = (words: string[], first = true) => {
      words.forEach((w, i) => {
        if (first && i === 0 && words.length > 1 && w === 'one' && numFlags.includes('a')) result.push(['ə', 4]);
        else push(this.lookup(w, null, w === 'point' ? -2 : null, null));
      });
    };
    const num = (n: string, first = true) => extend(cardinalWords(BigInt(n)), first);
    if (isDigit(word) && suffix !== null && ORDINALS.has(suffix)) extend(ordinalWords(BigInt(word)));
    else if (!result.length && word.length === 4 && !(currency !== null && Object.hasOwn(CURRENCIES, currency)) && isDigit(word)) extend(yearWords(Number(word)));
    else if (!isHead && !word.includes('.')) {
      const n = word.replaceAll(',', '');
      if (n[0] === '0' || n.length > 3) for (const d of n) num(d, false);
      else if (n.length === 3 && !n.endsWith('00')) {
        num(n[0]);
        if (n[1] === '0') {
          push(this.lookup('O', null, -2, null));
          num(n[2], false);
        } else num(n.slice(1), false);
      } else num(n);
    } else if (word.split('.').length > 2 || !isHead) {
      let first = true;
      for (const n of word.replaceAll(',', '').split('.')) {
        if (!n) {
          // empty part
        } else if (n[0] === '0' || (n.length !== 2 && [...n.slice(1)].some((d) => d !== '0'))) for (const d of n) num(d, false);
        else num(n, first);
        first = false;
      }
    } else if (currency !== null && Object.hasOwn(CURRENCIES, currency) && Lexicon.isCurrency(word)) {
      const units = CURRENCIES[currency];
      let pairs = word
        .replaceAll(',', '')
        .split('.')
        .slice(0, 2)
        .map((n, i) => [n ? parseInt(n, 10) : 0, units[i]] as [number, string]);
      if (pairs.length > 1) {
        if (pairs[1][0] === 0) pairs = pairs.slice(0, 1);
        else if (pairs[0][0] === 0) pairs = pairs.slice(1);
      }
      pairs.forEach(([n, unit], i) => {
        if (i > 0) push(this.lookup('and', null, null, null));
        extend(cardinalWords(n), i === 0);
        push(Math.abs(n) !== 1 && unit !== 'pence' ? this.stemS(unit + 's', null, null, null) : this.lookup(unit, null, null, null));
      });
    } else {
      let words: string[];
      if (isDigit(word)) words = cardinalWords(BigInt(word));
      else if (!word.includes('.')) {
        const n = BigInt(word.replaceAll(',', ''));
        words = suffix !== null && ORDINALS.has(suffix) ? ordinalWords(n) : cardinalWords(n);
      } else {
        const w = word.replaceAll(',', '');
        if (w[0] === '.') words = ['point', ...[...w.slice(1)].flatMap((d) => cardinalWords(Number(d)))];
        else words = decimalWords(w);
      }
      extend(words);
    }
    if (!result.length) return [null, null];
    if (result.some(([p]) => p === null)) return [null, null];
    const ps = result.map(([p]) => p).join(' ');
    const rating = Math.min(...result.map(([, r]) => r));
    if (suffix === 's' || suffix === "'s") return [this.s(ps), rating];
    if (suffix === 'ed' || suffix === "'d") return [this.ed(ps), rating];
    if (suffix === 'ing') return [this.ing(ps), rating];
    return [ps, rating];
  }

  /** append_currency */
  appendCurrency(ps: string, currency: string | null): string {
    if (!currency) return ps;
    const units = CURRENCIES[currency];
    const unit = units ? this.stemS(units[0] + 's', null, null, null)[0] : null;
    return unit ? `${ps} ${unit}` : ps;
  }

  /** is_number */
  static isNumber(word: string, isHead: boolean): boolean {
    if (![...word].some((c) => isDigit(c))) return false;
    for (const s of ['ing', "'d", 'ed', "'s", 'st', 'nd', 'rd', 'th', 's']) {
      if (word.endsWith(s)) {
        word = word.slice(0, -s.length);
        break;
      }
    }
    return [...word].every((c, i) => isDigit(c) || c === ',' || c === '.' || (isHead && i === 0 && c === '-'));
  }

  /** Lexicon.__call__ */
  call(text: string, f: Features, ctx: TokenContext): Lookup {
    let word = text.replace(/[‘’]/g, "'").normalize('NFKC');
    word = [...word].map(numericIfNeeded).join('');
    const stress = word === word.toLowerCase() ? null : this.capStresses[word === word.toUpperCase() ? 1 : 0];
    const [ps, rating] = this.getWord(word, f.tag, stress, ctx);
    if (ps !== null) return [applyStress(this.appendCurrency(ps, f.currency), f.stress), rating];
    if (Lexicon.isNumber(word, f.isHead)) {
      const [nps, r] = this.getNumber(word, f.currency, f.isHead, f.numFlags);
      return [applyStress(nps, f.stress), r];
    }
    return [null, null];
  }
}

/** numeric_if_needed: other scripts' digits as ASCII digits. */
function numericIfNeeded(c: string): string {
  if (!/\p{Nd}/u.test(c) || isDigit(c)) return c;
  // Decimal digits come in runs of ten code points starting at zero.
  const cp = c.codePointAt(0)!;
  let v = 0;
  while (v < 9 && /\p{Nd}/u.test(String.fromCodePoint(cp - v - 1))) v++;
  return String(v);
}

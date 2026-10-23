// Part-of-speech tagger for misaki's homographs ("I read" vs "I will read", "a record" vs "to record").
//
// misaki tags with spaCy's en_core_web_sm. This is an averaged perceptron (the design from Matthew
// Honnibal's "A good part-of-speech tagger in about 200 lines of Python") trained to reproduce
// spaCy's tags on public-domain books (scripts/g2p/train_tagger.py). It agrees with spaCy on 96.9%
// of tokens of held-out paragraphs, and on 99.2% of the tokens where the tag changes a pronunciation.

export interface TaggerModel {
  classes: string[];
  /** Words that always get the same tag. */
  tagdict: Record<string, string>;
  /** Feature -> class weights, encoded as class letter (A-Z, a-z) followed by an integer. */
  weights: Record<string, string>;
}

const DIGITS = /^\p{Nd}+$/u;
const ALPHA = /\p{L}/u;
const LOWER = /[\p{Ll}\p{Lt}]/u;
const UPPER = /[\p{Lu}\p{Lt}]/u;

/** Python's str.isupper() / islower() (cased characters only). */
function isUpper(w: string): boolean {
  return /\p{Lu}/u.test(w) && !LOWER.test(w);
}
function isLower(w: string): boolean {
  return /\p{Ll}/u.test(w) && !/[\p{Lu}\p{Lt}]/u.test(w);
}

function shape(w: string): string {
  if (DIGITS.test(w)) return 'd';
  if (isUpper(w) && ALPHA.test(w)) return [...w].length > 1 ? 'X' : 'X1';
  if (UPPER.test(first(w)) && !LOWER.test(first(w))) return 'Xx';
  if (isLower(w)) return 'x';
  if (ALPHA.test(w)) return 'm';
  return 'p';
}

function first(w: string): string {
  const c = w.codePointAt(0);
  return c === undefined ? '' : String.fromCodePoint(c);
}

/** Last three characters (code points, like Python's w[-3:]). */
function last3(w: string): string {
  const cs = [...w];
  return cs.slice(-3).join('');
}

function normalize(w: string): string {
  if (w.includes('-') && w[0] !== '-') return '!HYPHEN';
  if (DIGITS.test(w) && [...w].length === 4) return '!YEAR';
  if (DIGITS.test(first(w))) return '!DIGITS';
  return w.toLowerCase();
}

export class Tagger {
  private weights = new Map<string, Int32Array>();
  private classes: string[];
  private tagdict: Map<string, string>;

  constructor(model: TaggerModel) {
    this.classes = model.classes;
    this.tagdict = new Map(Object.entries(model.tagdict));
    const n = model.classes.length;
    for (const [f, enc] of Object.entries(model.weights)) {
      const w = new Int32Array(n);
      for (const m of enc.matchAll(/([A-Za-z])(-?\d+)/g)) {
        const c = m[1].charCodeAt(0);
        w[c >= 97 ? c - 97 + 26 : c - 65] = Number(m[2]);
      }
      this.weights.set(f, w);
    }
  }

  private predict(feats: string[]): string {
    const scores = new Int32Array(this.classes.length);
    for (const f of feats) {
      const w = this.weights.get(f);
      if (w) for (let i = 0; i < w.length; i++) scores[i] += w[i];
    }
    // Highest score; ties go to the greater class name (Python: max(classes, key=(score, class))).
    let best = 0;
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > scores[best] || (scores[i] === scores[best] && this.classes[i] > this.classes[best])) best = i;
    }
    return this.classes[best];
  }

  /** Tags for a sequence of tokens (whitespace tokens excluded by the caller). */
  tag(words: string[]): string[] {
    const ctx = ['-S-', '-S2-', ...words.map(normalize), '-E-', '-E2-'];
    const raw = ['', '', ...words, '', ''];
    let prev = '-S-';
    let prev2 = '-S2-';
    const out: string[] = [];
    for (let k = 0; k < words.length; k++) {
      let t = this.tagdict.get(words[k]);
      if (t === undefined) {
        const i = k + 2;
        const word = ctx[i];
        const sh = shape(raw[i]);
        t = this.predict([
          'b',
          's ' + last3(word),
          'p ' + first(word),
          't ' + prev,
          'u ' + prev2,
          'tu ' + prev + ' ' + prev2,
          'w ' + word,
          'tw ' + prev + ' ' + word,
          'pw ' + ctx[i - 1],
          'ps ' + last3(ctx[i - 1]),
          'ppw ' + ctx[i - 2],
          'nw ' + ctx[i + 1],
          'ns ' + last3(ctx[i + 1]),
          'nnw ' + ctx[i + 2],
          'h ' + sh,
          'hp ' + sh + ' ' + prev,
          'hn ' + shape(raw[i + 1]),
        ]);
      }
      out.push(t);
      prev2 = prev;
      prev = t;
    }
    return out;
  }
}

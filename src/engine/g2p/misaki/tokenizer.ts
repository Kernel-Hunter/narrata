// English tokenizer with the same rules as spaCy's (MIT, Copyright ExplosionAI GmbH), which misaki
// uses. The algorithm follows spaCy's Tokenizer: split on whitespace, peel prefixes and suffixes,
// keep special cases ("don't" -> "do" + "n't", "Dr.") and URLs whole, then split on infixes.
// The patterns and special cases are generated from spaCy (spacy-rules.ts).

import { INFIX, PREFIX, SPECIAL, SUFFIX, URL } from './spacy-rules';

export interface Token {
  text: string;
  /** Offset of the token in the input string (UTF-16 code units). */
  start: number;
  /** True when the token is followed by a single space that belongs to it. */
  space: boolean;
}

const prefixRe = new RegExp(PREFIX, 'u');
const suffixRe = new RegExp(SUFFIX, 'u');
const infixRe = new RegExp(INFIX, 'gu');
const urlRe = new RegExp(URL, 'u');
const specialCases = new Map<string, string[]>(Object.entries(SPECIAL).map(([k, v]) => [k, v === 1 ? [k] : v]));
const noSpecials = new Map<string, string[]>();

// Python's str.isspace().
const SPACE = /[\s\u001c-\u001f\u0085]/u;

function findPrefix(s: string): number {
  const m = prefixRe.exec(s);
  return m ? m[0].length : 0;
}

function findSuffix(s: string): number {
  const m = suffixRe.exec(s);
  return m ? m[0].length : 0;
}

/** Tokenize a run of non-space characters starting at `offset`. */
function tokenizeSpan(span: string, offset: number, out: Token[], specials = true): void {
  const special = specials ? specialCases : noSpecials;
  const hit = special.get(span);
  if (hit) {
    pushSpecial(hit, span, offset, out);
    return;
  }
  const prefixes: string[] = [];
  const suffixes: string[] = [];
  let s = span;
  let lastSize = -1;
  while (s && s.length !== lastSize) {
    if (special.has(s)) break;
    lastSize = s.length;
    const pre = findPrefix(s);
    if (pre) {
      const minusPre = s.slice(pre);
      if (minusPre && special.has(minusPre)) {
        prefixes.push(s.slice(0, pre));
        s = minusPre;
        break;
      }
    }
    const suf = findSuffix(s.slice(pre));
    if (suf) {
      const minusSuf = s.slice(0, s.length - suf);
      if (minusSuf && special.has(minusSuf)) {
        suffixes.push(s.slice(s.length - suf));
        s = minusSuf;
        break;
      }
    }
    if (pre && suf && pre + suf <= s.length) {
      prefixes.push(s.slice(0, pre));
      suffixes.push(s.slice(s.length - suf));
      s = s.slice(pre, s.length - suf);
    } else if (pre) {
      prefixes.push(s.slice(0, pre));
      s = s.slice(pre);
    } else if (suf) {
      suffixes.push(s.slice(s.length - suf));
      s = s.slice(0, s.length - suf);
    }
  }
  let pos = offset;
  const push = (text: string) => {
    out.push({ text, start: pos, space: false });
    pos += text.length;
  };
  for (const p of prefixes) push(p);
  if (s) {
    const sp = special.get(s);
    if (sp) {
      pushSpecial(sp, s, pos, out);
      pos += s.length;
    } else if (urlRe.test(s)) push(s);
    else {
      let start = 0;
      for (const m of s.matchAll(infixRe)) {
        const a = m.index!;
        const b = a + m[0].length;
        if (a === 0) continue;
        if (a !== start) push(s.slice(start, a));
        if (a !== b) push(s.slice(a, b));
        start = b;
      }
      if (start < s.length) push(s.slice(start));
    }
  }
  for (let i = suffixes.length - 1; i >= 0; i--) push(suffixes[i]);
}

/** Special cases may change the text ("ca" + "n't" for "can't" keeps the characters). */
function pushSpecial(parts: string[], text: string, offset: number, out: Token[]): void {
  let pos = offset;
  for (const p of parts) {
    const at = text.indexOf(p, pos - offset);
    const start = at >= 0 ? offset + at : pos;
    out.push({ text: p, start, space: false });
    pos = start + p.length;
  }
}

/**
 * Special cases that the affix rules split into several tokens ("Mr" + "." after a dash, "’" + "em"),
 * indexed by their first token. spaCy merges these back with a PhraseMatcher after tokenizing.
 */
let multiToken: Map<string, { key: string; parts: string[] }[]> | null = null;

function specialPatterns() {
  if (multiToken) return multiToken;
  multiToken = new Map();
  for (const key of specialCases.keys()) {
    const toks: Token[] = [];
    tokenizeSpan(key, 0, toks, false);
    if (toks.length < 2) continue;
    const parts = toks.map((t) => t.text);
    const list = multiToken.get(parts[0]) ?? [];
    list.push({ key, parts });
    multiToken.set(parts[0], list);
  }
  return multiToken;
}

/** spaCy's Tokenizer._apply_special_cases: longest matches first, no overlaps. */
function applySpecialCases(tokens: Token[]): Token[] {
  const patterns = specialPatterns();
  const found: { start: number; end: number; key: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const list = patterns.get(tokens[i].text);
    if (!list) continue;
    for (const { key, parts } of list) {
      if (i + parts.length > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < parts.length && ok; k++) {
        const t = tokens[i + k];
        ok = t.text === parts[k] && (k === parts.length - 1 || (!t.space && t.start + t.text.length === tokens[i + k + 1].start));
      }
      if (ok) found.push({ start: i, end: i + parts.length, key });
    }
  }
  if (!found.length) return tokens;
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || b.start - a.start);
  const seen = new Set<number>();
  const keep: typeof found = [];
  for (const f of found) {
    if (!seen.has(f.start) && !seen.has(f.end - 1)) keep.push(f);
    for (let k = f.start; k < f.end; k++) seen.add(k);
  }
  keep.sort((a, b) => a.start - b.start);
  const out: Token[] = [];
  let i = 0;
  for (const f of keep) {
    while (i < f.start) out.push(tokens[i++]);
    const first = tokens[f.start];
    const last = tokens[f.end - 1];
    const merged: Token[] = [];
    pushSpecial(specialCases.get(f.key)!, f.key, first.start, merged);
    merged[merged.length - 1].space = last.space;
    out.push(...merged);
    i = f.end;
  }
  while (i < tokens.length) out.push(tokens[i++]);
  return out;
}

/** spaCy's whitespace handling: a single space after a token belongs to it, other whitespace is a token. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  if (!text) return out;
  let inWs = SPACE.test(text[0]);
  let start = 0;
  let i = 0;
  for (; i < text.length; i++) {
    const ws = SPACE.test(text[i]);
    if (ws !== inWs) {
      if (start < i) tokenizeSpan(text.slice(start, i), start, out);
      if (text[i] === ' ') {
        if (out.length) out[out.length - 1].space = true;
        start = i + 1;
      } else start = i;
      inWs = !inWs;
    }
  }
  if (start < i) {
    tokenizeSpan(text.slice(start), start, out);
    out[out.length - 1].space = text[text.length - 1] === ' ' && !inWs;
  }
  return applySpecialCases(out);
}

"""Train the part-of-speech tagger used by Narrata's G2P (src/engine/g2p/misaki/tagger.ts).

misaki picks homograph pronunciations from spaCy's en_core_web_sm tags. Narrata cannot run spaCy,
so it uses an averaged perceptron (Matthew Honnibal's design) trained to reproduce spaCy's tags on
public-domain books from Project Gutenberg. Steps:

    python train_tagger.py download <dir>              # fetch the books listed below
    python train_tagger.py tag <dir> corpus.jsonl      # tag them with spaCy (needs spacy + en_core_web_sm 3.8)
    python train_tagger.py train corpus.jsonl model.json
    python train_tagger.py export model.json tagger.json   # prune, quantize; then run build-data.mjs

The feature extraction must stay identical to Tagger.tag in tagger.ts.
"""
import collections
import glob
import json
import os
import random
import re
import sys
import urllib.request

BOOKS = [
    1342, 84, 11, 1661, 2701, 98, 1952, 345, 174, 76, 74, 5200, 2554, 1400, 43, 215, 36, 35, 1260, 768, 1232, 2814,
    158, 205, 120, 244, 64317, 25344, 1228, 5001, 1404, 2591, 1727, 3600, 6130, 16389, 4217, 2148, 829, 1250, 160,
    2097, 3207, 41445, 10007, 514, 113, 55, 236, 45, 289, 1023, 12238, 71395, 13923, 14314, 23025, 26184, 42055, 863,
    1155, 8164, 543, 805, 62, 78, 2776, 35123, 39293, 26597,
]
WORDS_PER_BOOK = 70000
TAGDICT_MIN_COUNT = 20
TAGDICT_MIN_SHARE = 0.999
ITERATIONS = 5
PRUNE_BELOW = 3.0  # drop averaged weights smaller than this
QUANTIZE = 10  # weights are stored as round(w * QUANTIZE)


def download(dir):
    os.makedirs(dir, exist_ok=True)
    for b in BOOKS:
        path = os.path.join(dir, f'{b}.txt')
        if not os.path.exists(path):
            urllib.request.urlretrieve(f'https://www.gutenberg.org/cache/epub/{b}/pg{b}.txt', path)


def paragraphs(dir):
    random.seed(7)
    out = []
    for f in sorted(glob.glob(os.path.join(dir, '*.txt'))):
        t = open(f, encoding='utf-8', errors='replace').read()
        a = t.find('*** START OF')
        b = t.find('*** END OF')
        if a >= 0:
            t = t[t.find('\n', a) + 1:]
        if b >= 0:
            t = t[:b]
        ps = [re.sub(r'\s+', ' ', p).strip() for p in re.split(r'\n\s*\n', t)]
        ps = [p for p in ps if len(p) > 40 and sum(c.isalpha() for c in p) > 0.6 * len(p)]
        random.shuffle(ps)
        words = 0
        for p in ps:
            if words > WORDS_PER_BOOK:
                break
            out.append(p)
            words += p.count(' ') + 1
    return out


def tag(dir, path):
    import spacy
    nlp = spacy.load('en_core_web_sm', enable=['tok2vec', 'tagger'])
    paras = paragraphs(dir)
    with open(path, 'w') as out:
        for p, doc in zip(paras, nlp.pipe(paras, batch_size=256)):
            out.write(json.dumps({'text': p, 'tokens': [[t.text, t.tag_, t.whitespace_] for t in doc]}, ensure_ascii=False) + '\n')


# ---- features (keep in sync with tagger.ts) ----

def shape(w):
    if w.isdigit():
        return 'd'
    if w.isupper() and any(c.isalpha() for c in w):
        return 'X' if len(w) > 1 else 'X1'
    if w[:1].isupper():
        return 'Xx'
    if w.islower():
        return 'x'
    if any(c.isalpha() for c in w):
        return 'm'
    return 'p'


def normalize(w):
    if '-' in w and w[0] != '-':
        return '!HYPHEN'
    if w.isdigit() and len(w) == 4:
        return '!YEAR'
    if w[:1].isdigit():
        return '!DIGITS'
    return w.lower()


def features(i, ctx, prev, prev2, raw):
    word = ctx[i]
    return [
        'b', 's ' + word[-3:], 'p ' + word[:1], 't ' + prev, 'u ' + prev2, 'tu ' + prev + ' ' + prev2,
        'w ' + word, 'tw ' + prev + ' ' + word, 'pw ' + ctx[i - 1], 'ps ' + ctx[i - 1][-3:], 'ppw ' + ctx[i - 2],
        'nw ' + ctx[i + 1], 'ns ' + ctx[i + 1][-3:], 'nnw ' + ctx[i + 2],
        'h ' + shape(raw[i]), 'hp ' + shape(raw[i]) + ' ' + prev, 'hn ' + shape(raw[i + 1]),
    ]


class Perceptron:
    def __init__(self, classes):
        self.classes = classes
        self.w = {}
        self.totals = collections.defaultdict(float)
        self.stamps = collections.defaultdict(int)
        self.i = 0

    def predict(self, feats):
        scores = collections.defaultdict(float)
        for f in feats:
            for c, v in self.w.get(f, {}).items():
                scores[c] += v
        return max(self.classes, key=lambda c: (scores[c], c))

    def update(self, truth, guess, feats):
        self.i += 1
        if truth == guess:
            return
        for f in feats:
            ws = self.w.setdefault(f, {})
            for c, d in ((truth, 1.0), (guess, -1.0)):
                v = ws.get(c, 0.0)
                self.totals[(f, c)] += (self.i - self.stamps[(f, c)]) * v
                self.stamps[(f, c)] = self.i
                ws[c] = v + d

    def average(self):
        for f, ws in self.w.items():
            self.w[f] = {c: a for c, v in ws.items() if (a := (self.totals[(f, c)] + (self.i - self.stamps[(f, c)]) * v) / self.i)}


def tag_sentence(model, tagdict, words, gold=None):
    ctx = ['-S-', '-S2-'] + [normalize(w) for w in words] + ['-E-', '-E2-']
    raw = ['', ''] + words + ['', '']
    prev, prev2 = '-S-', '-S2-'
    out = []
    for i, w in enumerate(words):
        t = tagdict.get(w)
        if t is None:
            feats = features(i + 2, ctx, prev, prev2, raw)
            t = model.predict(feats)
            if gold is not None:
                model.update(gold[i], t, feats)
        out.append(t)
        prev2, prev = prev, (gold[i] if gold is not None else t)
    return out


def load(path):
    sents = []
    for line in open(path):
        d = json.loads(line)
        toks = [t for t in d['tokens'] if t[0].strip()]
        sents.append(([t[0] for t in toks], [t[1] for t in toks]))
    random.seed(1)
    random.shuffle(sents)
    n = len(sents) // 20
    return sents[n:], sents[:n]


def train(corpus, path):
    train_set, dev = load(corpus)
    counts = collections.defaultdict(collections.Counter)
    for words, tags in train_set:
        for w, t in zip(words, tags):
            counts[w][t] += 1
    tagdict = {}
    for w, c in counts.items():
        t, n = c.most_common(1)[0]
        if sum(c.values()) >= TAGDICT_MIN_COUNT and n / sum(c.values()) >= TAGDICT_MIN_SHARE:
            tagdict[w] = t
    model = Perceptron(sorted({t for _, ts in train_set for t in ts}))
    for it in range(ITERATIONS):
        for words, tags in train_set:
            tag_sentence(model, tagdict, words, tags)
        random.shuffle(train_set)
        print('iteration', it + 1, file=sys.stderr)
    model.average()
    json.dump({'classes': model.classes, 'tagdict': tagdict, 'weights': model.w}, open(path, 'w'))


def export(path, out, corpus=None):
    m = json.load(open(path))
    cls = {c: i for i, c in enumerate(m['classes'])}
    letter = lambda i: chr(65 + i) if i < 26 else chr(97 + i - 26)
    weights = {}
    for f, ws in m['weights'].items():
        q = {c: round(v * QUANTIZE) for c, v in ws.items() if abs(v) >= PRUNE_BELOW}
        q = {c: v for c, v in q.items() if v}
        if q:
            weights[f] = ''.join('%s%d' % (letter(cls[c]), v) for c, v in sorted(q.items(), key=lambda kv: cls[kv[0]]))
    json.dump({'classes': m['classes'], 'tagdict': m['tagdict'], 'weights': weights}, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print(len(weights), 'features', file=sys.stderr)


if __name__ == '__main__':
    cmd, *args = sys.argv[1:]
    {'download': download, 'tag': tag, 'train': train, 'export': export}[cmd](*args)

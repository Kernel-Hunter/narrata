"""Build the G2P evaluation inputs (tests/g2p-eval/cases.json, before references are added).

    python make_eval_set.py <misaki checkout> <books dir used by train_tagger.py> <held-out book>...

Inputs: the hand-written items in tests/g2p-eval/handwritten.json (homographs in context, numbers,
names, abbreviations, sentences, out-of-vocabulary words), plus words sampled from the corpus and
from misaki's lexicons, and sentences from public-domain books the tagger was not trained on
(Project Gutenberg 2852 and 3825).
"""
import collections
import json
import os
import random
import re
import sys

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..', '..')
sys.path.insert(0, here)
from train_tagger import paragraphs  # noqa: E402

misaki, books, *heldout = sys.argv[1:]
random.seed(2026)
hand = json.load(open(os.path.join(root, 'tests/g2p-eval/handwritten.json')))
data = os.path.join(misaki, 'misaki/data')
gold = json.load(open(os.path.join(data, 'us_gold.json')))
silver = json.load(open(os.path.join(data, 'us_silver.json')))
gbg = json.load(open(os.path.join(data, 'gb_gold.json')))
gbs = json.load(open(os.path.join(data, 'gb_silver.json')))
cases = []


def add(cat, text):
    cases.append({'id': len(cases), 'cat': cat, 'text': text})


for cat, items in hand.items():
    for t in items:
        add(cat, t)
freq = collections.Counter(w for p in paragraphs(books) for w in re.findall(r"[A-Za-z]+", p) if w.islower())
common = [w for w, _ in freq.most_common(2000)]
random.shuffle(common)
for w in sorted(common[:300]):
    add('word-common', w)
gk = sorted(k for k, v in gold.items() if isinstance(v, str) and k.isalpha() and k.islower() and len(k) > 2 and k in gbg)
sk = sorted(k for k, v in silver.items() if k.isalpha() and k.islower() and len(k) > 2 and k not in gold and k in gbs)
for w in random.sample(gk, 150):
    add('word-gold', w)
for w in random.sample(sk, 100):
    add('word-silver', w)
suf = [w for w, _ in freq.most_common(40000) if w not in gold and w not in silver and len(w) >= 5 and (w.endswith('ing') or w.endswith('ed') or w.endswith('s'))]
for w in sorted(random.sample(suf, min(80, len(suf)))):
    add('word-suffix', w)
sents = []
for f in heldout:
    t = open(f, encoding='utf-8').read()
    t = t[t.find('\n', t.find('*** START OF')) + 1:t.find('*** END OF')]
    for p in re.split(r'\n\s*\n', t):
        p = re.sub(r'\s+', ' ', p).strip()
        sents += [s for s in re.split(r'(?<=[.!?])\s+(?=[A-Z"])', p) if 40 <= len(s) <= 200 and not s.isupper()]
for s in random.sample(sents, 80):
    add('sentence-book', s)
json.dump(cases, open(os.path.join(root, 'tests/g2p-eval/cases.json'), 'w'), ensure_ascii=False, indent=0)
print(collections.Counter(c['cat'] for c in cases), len(cases))

"""Add misaki's own output to the G2P evaluation set (tests/g2p-eval/cases.json).

The references come from misaki 0.9.4 configured as the kokoro package configures it for Kokoro
v1.0: spaCy en_core_web_sm tags, eSpeak NG as the fallback for unknown words, unk=''. Run it in a
virtual environment with `pip install "misaki[en]==0.9.4" kokoro` and en_core_web_sm 3.8.0.
eSpeak is used only here, to produce reference data; Narrata does not ship it.
"""
import json
import os
import sys

import espeakng_loader

# espeakng-loader's data path can fail on macOS (quarantined files); a copy next to the venv works.
if os.environ.get('ESPEAK_DATA_COPY'):
    espeakng_loader.get_data_path = lambda: os.environ['ESPEAK_DATA_COPY']
from misaki import en, espeak  # noqa: E402

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '../../tests/g2p-eval/cases.json')
cases = json.load(open(path))
used = []


class Recording:
    """Records which tokens went to the fallback."""

    def __init__(self, fallback):
        self.fallback = fallback

    def __call__(self, token):
        used.append(token.text)
        return self.fallback(token)


for british, key in ((False, 'us'), (True, 'gb')):
    g2p = en.G2P(trf=False, british=british, fallback=Recording(espeak.EspeakFallback(british=british)), unk='')
    for c in cases:
        used.clear()
        c[key], _ = g2p(c['text'])
        c[key + '_fallback'] = sorted(set(used))
json.dump(cases, open(path, 'w'), ensure_ascii=False, indent=0)

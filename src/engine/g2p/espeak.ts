// eSpeak NG based G2P (via the `phonemizer` package, which bundles eSpeak NG compiled to
// WebAssembly; eSpeak NG is GPL-3.0-or-later, which is why Narrata is GPL-3.0-or-later).

import { phonemize } from 'phonemizer';
import { fixPhonemes, normalizeText, splitPunctuation } from './normalize';
import type { G2P, VoiceLang } from './types';

export class EspeakG2P implements G2P {
  readonly name = 'eSpeak NG';

  async phonemize(text: string, lang: VoiceLang): Promise<string> {
    const sections = splitPunctuation(normalizeText(text));
    const voice = lang === 'a' ? 'en-us' : 'en';
    const parts = await Promise.all(sections.map(async (s) => (s.punct ? s.text : (await phonemize(s.text, voice)).join(' '))));
    return fixPhonemes(parts.join(''), lang);
  }
}

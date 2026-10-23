// The default G2P: misaki's English pipeline ported to TypeScript (src/engine/g2p/misaki). The
// lexicons, the tagger and the fallback network are data files loaded on first use.

import { BartFallback } from './misaki/fallback';
import { loadFallback, loadLexicon, loadTagger, type DataLoader } from './misaki/data';
import { MisakiG2P } from './misaki/g2p';
import { Lexicon } from './misaki/lexicon';
import { makeFallback } from './misaki/oov';
import { Tagger } from './misaki/tagger';
import type { G2P, G2PResult, VoiceLang } from './types';

export class EnglishG2P implements G2P {
  readonly name = 'misaki';
  private readonly load: DataLoader;
  private tagger: Promise<Tagger> | null = null;
  private readonly engines = new Map<VoiceLang, Promise<MisakiG2P>>();

  constructor(load: DataLoader) {
    this.load = load;
  }

  private engine(lang: VoiceLang): Promise<MisakiG2P> {
    let e = this.engines.get(lang);
    if (!e) {
      const accent = lang === 'b' ? 'gb' : 'us';
      this.tagger ??= loadTagger(this.load).then((m) => new Tagger(m));
      e = Promise.all([this.tagger, loadLexicon(this.load, accent), loadFallback(this.load, accent)]).then(([tagger, lex, fb]) => {
        const lexicon = new Lexicon(lex.gold, lex.silver, accent === 'gb');
        return new MisakiG2P({ lexicon, tagger, fallback: makeFallback(lexicon, new BartFallback(fb.tensors, fb.config)) });
      });
      // A failed load (network) can be retried.
      e.catch(() => this.engines.delete(lang));
      this.engines.set(lang, e);
    }
    return e;
  }

  async prepare(lang: VoiceLang): Promise<void> {
    await this.engine(lang);
  }

  async phonemize(text: string, lang: VoiceLang): Promise<G2PResult> {
    const g = await this.engine(lang);
    const tokens = g.tokens(text).map((t) => ({ start: t.start, end: t.end, phonemes: t.phonemes, whitespace: t.whitespace }));
    return { phonemes: tokens.map((t) => t.phonemes + t.whitespace).join(''), tokens };
  }
}

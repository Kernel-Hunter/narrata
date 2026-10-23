/**
 * Grapheme-to-phoneme conversion. Kokoro takes phonemes, not text, so every voice goes through
 * a G2P. The default implementation uses eSpeak NG (GPL-3.0-or-later). Keeping this interface
 * small lets a permissive implementation (for example a port of misaki, Apache-2.0) replace it.
 */
export type VoiceLang = 'a' | 'b'; // a = American English, b = British English

export interface G2P {
  readonly name: string;
  /** Phonemes in Kokoro's symbol set, words separated by spaces, punctuation kept. */
  phonemize(text: string, lang: VoiceLang): Promise<string>;
}

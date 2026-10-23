/**
 * Grapheme-to-phoneme conversion. Kokoro takes phonemes, not text, so every voice goes through
 * a G2P. Narrata's is a TypeScript port of misaki, the G2P Kokoro was trained with.
 */
export type VoiceLang = 'a' | 'b'; // a = American English, b = British English

/** Phonemes for one token of the input text. */
export interface PhonemeToken {
  /** Offsets of the token in the input text. */
  start: number;
  end: number;
  /** Phonemes in Kokoro's symbol set (punctuation tokens keep their punctuation, may be empty). */
  phonemes: string;
  /** Whitespace that follows the token in the phoneme string ('' or ' '). */
  whitespace: string;
}

export interface G2PResult {
  /** The phoneme string: every token's phonemes followed by its whitespace. */
  phonemes: string;
  tokens: PhonemeToken[];
}

export interface G2P {
  readonly name: string;
  /** Load the data for a language ahead of the first call. */
  prepare(lang: VoiceLang): Promise<void>;
  phonemize(text: string, lang: VoiceLang): Promise<G2PResult>;
}

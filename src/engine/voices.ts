// The English voices of Kokoro-82M v1.0 with the grades published in the model card, and the
// faster Piper voices for computers that are too slow for Kokoro.

import type { VoiceLang } from './g2p/types';

export interface Voice {
  id: string;
  name: string;
  lang: VoiceLang;
  gender: 'Female' | 'Male';
  grade: string;
  engine: 'kokoro' | 'piper';
}

export interface PiperVoice extends Voice {
  engine: 'piper';
  /** Path of the model in the rhasspy/piper-voices repository (without .onnx). */
  path: string;
  bytes: number;
  configBytes: number;
}

const RAW: [string, string, string][] = [
  ['af_heart', 'Heart', 'A'],
  ['af_bella', 'Bella', 'A-'],
  ['af_nicole', 'Nicole', 'B-'],
  ['bf_emma', 'Emma', 'B-'],
  ['af_aoede', 'Aoede', 'C+'],
  ['af_kore', 'Kore', 'C+'],
  ['af_sarah', 'Sarah', 'C+'],
  ['am_fenrir', 'Fenrir', 'C+'],
  ['am_michael', 'Michael', 'C+'],
  ['am_puck', 'Puck', 'C+'],
  ['af_alloy', 'Alloy', 'C'],
  ['af_nova', 'Nova', 'C'],
  ['bf_isabella', 'Isabella', 'C'],
  ['bm_fable', 'Fable', 'C'],
  ['bm_george', 'George', 'C'],
  ['af_sky', 'Sky', 'C-'],
  ['bm_lewis', 'Lewis', 'D+'],
  ['af_jessica', 'Jessica', 'D'],
  ['af_river', 'River', 'D'],
  ['am_echo', 'Echo', 'D'],
  ['am_eric', 'Eric', 'D'],
  ['am_liam', 'Liam', 'D'],
  ['am_onyx', 'Onyx', 'D'],
  ['bf_alice', 'Alice', 'D'],
  ['bf_lily', 'Lily', 'D'],
  ['bm_daniel', 'Daniel', 'D'],
  ['am_santa', 'Santa', 'D-'],
  ['am_adam', 'Adam', 'F+'],
];

export const VOICES: Voice[] = RAW.map(([id, name, grade]) => ({
  id,
  name,
  grade,
  engine: 'kokoro',
  lang: id[0] === 'b' ? 'b' : 'a',
  gender: id[1] === 'f' ? 'Female' : 'Male',
}));

/**
 * Piper voices (rhasspy/piper-voices, MIT) made only from public-domain LibriVox recordings:
 * Kristin and Cori trained from scratch, John fine-tuned from Kristin. Most other Piper voices are
 * fine-tuned from the lessac voice, whose recordings are licensed for non-commercial research
 * only, or use non-commercial datasets. John was picked over Norman because a speech recognizer
 * understood it better on 60 test sentences (15% of words wrong against 20%).
 */
const PIPER_SIZE = 63_531_379;
export const PIPER_VOICES: PiperVoice[] = [
  { id: 'piper_kristin', name: 'Kristin', lang: 'a', gender: 'Female', grade: 'fast', engine: 'piper', path: 'en/en_US/kristin/medium/en_US-kristin-medium', bytes: PIPER_SIZE, configBytes: 4968 },
  { id: 'piper_john', name: 'John', lang: 'a', gender: 'Male', grade: 'fast', engine: 'piper', path: 'en/en_US/john/medium/en_US-john-medium', bytes: PIPER_SIZE, configBytes: 4965 },
  { id: 'piper_cori', name: 'Cori', lang: 'b', gender: 'Female', grade: 'fast', engine: 'piper', path: 'en/en_GB/cori/medium/en_GB-cori-medium', bytes: PIPER_SIZE, configBytes: 4966 },
];

export const DEFAULT_VOICE = 'af_heart';
export const DEFAULT_FAST_VOICE = 'piper_kristin';

export function voiceById(id: string): Voice {
  return VOICES.find((v) => v.id === id) ?? PIPER_VOICES.find((v) => v.id === id) ?? VOICES[0];
}

export function isPiper(v: Voice): v is PiperVoice {
  return v.engine === 'piper';
}

/** A fast voice with the same accent and, if possible, the same gender. */
export function fastVoiceFor(v: Voice): PiperVoice {
  return PIPER_VOICES.find((p) => p.lang === v.lang && p.gender === v.gender) ?? PIPER_VOICES.find((p) => p.lang === v.lang) ?? PIPER_VOICES[0];
}

export function accentLabel(v: Voice): string {
  return v.lang === 'a' ? 'American' : 'British';
}

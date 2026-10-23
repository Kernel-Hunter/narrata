// The English voices of Kokoro-82M v1.0 with the grades published in the model card.

import type { VoiceLang } from './g2p/types';

export interface Voice {
  id: string;
  name: string;
  lang: VoiceLang;
  gender: 'Female' | 'Male';
  grade: string;
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
  lang: id[0] === 'b' ? 'b' : 'a',
  gender: id[1] === 'f' ? 'Female' : 'Male',
}));

export const DEFAULT_VOICE = 'af_heart';

export function voiceById(id: string): Voice {
  return VOICES.find((v) => v.id === id) ?? VOICES[0];
}

export function accentLabel(v: Voice): string {
  return v.lang === 'a' ? 'American' : 'British';
}

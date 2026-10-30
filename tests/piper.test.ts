import { describe, expect, it } from 'vitest';
import { toEspeakIpa } from '../src/engine/piper/espeak-ipa';
import { addGraphOutput, findNodeOutput, graphOutputNames } from '../src/engine/piper/onnx-patch';
import { phonemeDurations, piperInput, resample } from '../src/engine/piper/piper';
import { PIPER_VOICES, VOICES, fastVoiceFor, isPiper, voiceById } from '../src/engine/voices';

describe('toEspeakIpa', () => {
  it('expands misaki diphthongs and affricates', () => {
    expect(toEspeakIpa('lˈIthˌWs', false)).toBe('lˈaɪthˌaʊs');
    expect(toEspeakIpa('ʧˈAnʤ', false)).toBe('tʃˈeɪndʒ');
    expect(toEspeakIpa('ˈOld', false)).toBe('ˈoʊld');
    expect(toEspeakIpa('ɪksplˈYt', false)).toBe('ɪksplˈɔɪt');
  });

  it('writes American r-coloured vowels, the flap and long vowels like eSpeak', () => {
    expect(toEspeakIpa('kˈipəɹ', false)).toBe('kˈiːpɚ');
    expect(toEspeakIpa('bˈɜɹd', false)).toBe('bˈɜːd');
    expect(toEspeakIpa('hˈɜɹi', false)).toBe('hˈɜːɹi');
    expect(toEspeakIpa('wˈɔTəɹ', false)).toBe('wˈɔːɾɚ');
    expect(toEspeakIpa('fˈɑðəɹ', false)).toBe('fˈɑːðɚ');
    // Unstressed vowels stay short.
    expect(toEspeakIpa('hˈæpi', false)).toBe('hˈæpi');
    expect(toEspeakIpa('ɹˈiəli', false)).toBe('ɹˈiəli');
  });

  it('keeps British length marks and maps its own symbols', () => {
    expect(toEspeakIpa('hˈQm', true)).toBe('hˈəʊm');
    expect(toEspeakIpa('stˈɛːz', true)).toBe('stˈeəz');
    expect(toEspeakIpa('fˈɑːðə', true)).toBe('fˈɑːðə');
  });

  it('passes punctuation through', () => {
    expect(toEspeakIpa(',', false)).toBe(',');
    expect(toEspeakIpa('?', false)).toBe('?');
  });
});

describe('piperInput', () => {
  const map: Record<string, number[]> = { _: [0], '^': [1], $: [2], ' ': [3], h: [4], ə: [5], l: [6], ˈ: [7], o: [8], ʊ: [9], ',': [10] };

  it('lays out ids like Piper and keeps the token of every phoneme', () => {
    const tokens = [
      { start: 0, end: 5, phonemes: 'həlˈO', whitespace: '' },
      { start: 5, end: 6, phonemes: ',', whitespace: ' ' },
      { start: 7, end: 9, phonemes: '—', whitespace: '' },
    ];
    const r = piperInput(tokens, false, map);
    expect(r.phonemes.join('')).toBe('həlˈoʊ,');
    expect(r.owner).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(r.ids).toEqual([1, 0, 4, 0, 5, 0, 6, 0, 7, 0, 8, 0, 9, 0, 10, 0, 2]);
  });
});

describe('phonemeDurations', () => {
  it('gives each phoneme the pad after it, plus the leading and trailing pads', () => {
    // ^ _ a _ b _ $
    expect(phonemeDurations([3, 1, 5, 1, 7, 2, 4], 2)).toEqual([4, 6, 9, 4]);
  });
});

describe('resample', () => {
  it('changes the length by the rate ratio and keeps a sine wave', () => {
    const from = 22050;
    const x = Float32Array.from({ length: from }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / from));
    const y = resample(x, from, 24000);
    expect(y.length).toBe(24000);
    let err = 0;
    for (let j = 100; j < 23900; j++) err = Math.max(err, Math.abs(y[j] - Math.sin((2 * Math.PI * 440 * j) / 24000)));
    expect(err).toBeLessThan(0.01);
  });

  it('returns the input when the rates match', () => {
    const x = new Float32Array([1, 2, 3]);
    expect(resample(x, 24000, 24000)).toBe(x);
  });
});

/** Minimal protobuf writer for a test model. */
function ld(no: number, payload: number[]): number[] {
  return [no * 8 + 2, payload.length, ...payload];
}
const str = (s: string) => [...new TextEncoder().encode(s)];

describe('onnx-patch', () => {
  // ModelProto { ir_version: 8, graph: { node: [Relu x->a, Ceil a->d, Mul d->y], output: [y] }, opset_import: {...} }
  const node = (input: string, output: string, op: string) => ld(1, [...ld(1, str(input)), ...ld(2, str(output)), ...ld(4, str(op))]);
  const graph = [...node('x', 'a', 'Relu'), ...node('a', 'd', 'Ceil'), ...node('d', 'y', 'Mul'), ...ld(2, str('g')), ...ld(12, ld(1, str('y')))];
  const model = new Uint8Array([8, 8, ...ld(7, graph), ...ld(8, [16, 15])]);

  it('finds the output of a node by op type', () => {
    expect(findNodeOutput(model, 'Ceil')).toBe('d');
    expect(findNodeOutput(model, 'Conv')).toBeNull();
  });

  it('adds a graph output and keeps the rest of the model', () => {
    const patched = addGraphOutput(model, 'd');
    expect(graphOutputNames(model)).toEqual(['y']);
    expect(graphOutputNames(patched)).toEqual(['y', 'd']);
    expect(findNodeOutput(patched, 'Mul')).toBe('y');
    // The field after the graph (opset_import) is still there.
    expect([...patched.slice(-4)]).toEqual([...model.slice(-4)]);
  });

  it('rewrites the graph length when it needs more varint bytes', () => {
    const big = new Uint8Array([...ld(7, [...ld(2, str('g'.repeat(120)))])]);
    // A 123-byte graph has a one-byte length; the patched one needs two.
    const patched = addGraphOutput(big, 'out');
    expect(graphOutputNames(patched)).toEqual(['out']);
  });
});

describe('voices', () => {
  it('lists fast voices separately and finds a matching one', () => {
    expect(PIPER_VOICES.every(isPiper)).toBe(true);
    expect(VOICES.some(isPiper)).toBe(false);
    expect(voiceById('piper_kristin').engine).toBe('piper');
    expect(fastVoiceFor(voiceById('bf_emma')).lang).toBe('b');
    expect(fastVoiceFor(voiceById('am_michael')).gender).toBe('Male');
    expect(fastVoiceFor(voiceById('af_heart')).id).toBe('piper_kristin');
  });
});

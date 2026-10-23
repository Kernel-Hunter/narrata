import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { EnglishG2P } from '../src/engine/g2p/english';
import { loadFallback, loadLexicon, loadTagger, type DataLoader } from '../src/engine/g2p/misaki/data';
import { BartFallback } from '../src/engine/g2p/misaki/fallback';
import { Lexicon } from '../src/engine/g2p/misaki/lexicon';
import { cardinalWords, decimalWords, ordinalWords, yearWords } from '../src/engine/g2p/misaki/numbers';
import { Tagger } from '../src/engine/g2p/misaki/tagger';
import { tokenize } from '../src/engine/g2p/misaki/tokenizer';

const dataDir = join(__dirname, '../src/engine/g2p/data');
const load: DataLoader = async (name) => {
  const b = readFileSync(join(dataDir, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** Kokoro v1.0's phoneme vocabulary (tokenizer.json of onnx-community/Kokoro-82M-v1.0-ONNX), without the "$" pad. */
const KOKORO_VOCAB = new Set(';:,.!?—…"()“” ̃ʣʥʦʨᵝꭧAIOQSTWYᵊabcdefhijklmnopqrstuvwxyzɑɐɒæβɔɕçɖðʤəɚɛɜɟɡɥɨɪʝɯɰŋɳɲɴøɸθœɹɾɻʁɽʂʃʈʧʊʋʌɣɤχʎʒʔˈˌːʰʲ↓→↗↘ᵻ');

const g2p = new EnglishG2P(load);
const us = async (text: string) => (await g2p.phonemize(text, 'a')).phonemes;
const gb = async (text: string) => (await g2p.phonemize(text, 'b')).phonemes;

describe('tokenizer', () => {
  it('splits like spaCy and keeps character offsets', () => {
    const text = "Don't stop, Mr. Smith!";
    const toks = tokenize(text);
    expect(toks.map((t) => t.text)).toEqual(['Do', "n't", 'stop', ',', 'Mr.', 'Smith', '!']);
    for (const t of toks) expect(text.slice(t.start, t.start + t.text.length)).toBe(t.text);
    expect(toks.map((t) => t.space)).toEqual([false, true, false, true, true, false, false]);
  });

  it('splits prefixes, suffixes and infixes', () => {
    expect(tokenize('("Hello")').map((t) => t.text)).toEqual(['(', '"', 'Hello', '"', ')']);
    expect(tokenize('$5.50, 10km and 3-4').map((t) => t.text)).toEqual(['$', '5.50', ',', '10', 'km', 'and', '3', '-', '4']);
    expect(tokenize('well-known').map((t) => t.text)).toEqual(['well', '-', 'known']);
  });
});

describe('tagger', () => {
  it('tags a plain sentence', async () => {
    const tagger = new Tagger(await loadTagger(load));
    expect(tagger.tag(['The', 'dog', 'ran', 'home', '.'])).toEqual(['DT', 'NN', 'VBD', 'NN', '.']);
    expect(tagger.tag(['I', 'will', 'read', 'it', '.'])).toEqual(['PRP', 'MD', 'VB', 'PRP', '.']);
  });
});

describe('lexicon', () => {
  let lex: Lexicon;
  beforeAll(async () => {
    const d = await loadLexicon(load, 'us');
    lex = new Lexicon(d.gold, d.silver, false);
  });
  const ctx = { futureVowel: null, futureTo: false };
  const word = (w: string, tag = 'NN') => lex.call(w, { tag, isHead: true, currency: null, numFlags: '', stress: null }, ctx)[0];

  it('looks words up in gold, then silver', () => {
    expect(lex.golds.has('keeper')).toBe(true);
    expect(word('keeper')).toBe('kˈipəɹ');
    // Capitalised and upper-case forms reach the same entry.
    expect(word('Keeper')).toBe('kˈipəɹ');
    expect(word('KEEPER')).toBe('kˈipəɹ');
    // Silver: less common words, checked after gold.
    expect(lex.golds.has('actionist')).toBe(false);
    expect(lex.silvers.has('actionist')).toBe(true);
    expect(word('actionist')).toBe(lex.silvers.get('actionist'));
  });

  it('picks homograph entries by tag', () => {
    expect(word('read', 'VBD')).toBe('ɹˈɛd');
    expect(word('read', 'VB')).toBe('ɹˈid');
    expect(word('object', 'NN')).toBe('ˈɑbʤəkt');
    expect(word('object', 'VB')).toBe('əbʤˈɛkt');
  });

  it('applies the -s, -ed and -ing rules to stems', () => {
    expect(word('walks', 'VBZ')).toBe('wˈɔks');
    expect(word('climbed', 'VBD')).toBe('klˈImd');
    expect(word('stopped', 'VBD')).toBe('stˈɑpt');
    expect(word('running', 'VBG')).toBe('ɹˈʌnɪŋ');
    expect(word("John's", 'NNP')).toBe('ʤˈɑnz');
  });

  it('spells acronyms and reads known ones as words', () => {
    expect(word('FBI', 'NNP')).toBe('ˌɛfbˌiˈI');
    expect(word('NASA', 'NNP')).toBe('nˈæsə');
  });

  it('returns null for unknown words', () => {
    expect(word('zyxqorbian')).toBeNull();
  });
});

describe('number words', () => {
  it('reads cardinals, ordinals, years and decimals', () => {
    expect(cardinalWords(0).join(' ')).toBe('zero');
    expect(cardinalWords(1234567).join(' ')).toBe('one million two hundred thirty four thousand five hundred sixty seven');
    expect(cardinalWords(-12).join(' ')).toBe('minus twelve');
    expect(ordinalWords(21).join(' ')).toBe('twenty first');
    expect(ordinalWords(12).join(' ')).toBe('twelfth');
    expect(ordinalWords(100).join(' ')).toBe('one hundredth');
    expect(yearWords(1987).join(' ')).toBe('nineteen eighty seven');
    expect(yearWords(1905).join(' ')).toBe('nineteen oh five');
    expect(yearWords(1900).join(' ')).toBe('nineteen hundred');
    expect(yearWords(2005).join(' ')).toBe('two thousand five');
    expect(decimalWords('3.14').join(' ')).toBe('three point one four');
    expect(decimalWords('2.0').join(' ')).toBe('two');
  });
});

describe('fallback network', () => {
  it('matches the PyTorch model on words outside the lexicon', async () => {
    const fb = await loadFallback(load, 'us');
    const bart = new BartFallback(fb.tensors, fb.config);
    expect(bart.run('Brimblewick')).toBe('bɹˈɪmbᵊlwˌɪk');
    expect(bart.run('Ardern')).toBe('ˈɑɹdəɹn');
    expect(bart.run('Acanthocephala')).toBe('əkˌænθəsˈɛfələ');
    const fbGb = await loadFallback(load, 'gb');
    expect(new BartFallback(fbGb.tensors, fbGb.config).run('Ardern')).toBe('ˈɑːdən');
  });
});

// Expected strings are misaki 0.9.4's output (en.G2P(trf=False), as the kokoro package configures it).
describe('English G2P', () => {
  it('matches misaki on sentences with homographs', async () => {
    expect(await us('I read the book yesterday.')).toBe('ˌI ɹˈɛd ðə bˈʊk jˈɛstəɹdˌA.');
    expect(await us('I will read it now.')).toBe('ˌI wɪl ɹˈid ɪt nˈW.');
    expect(await us('Lead the way to the lead mine.')).toBe('lˈid ðə wˈA tə ðə lˈid mˈIn.');
    expect(await us('Please close the door, I live close by.')).toBe('plˈiz klˈOz ðə dˈɔɹ, ˌI lˈɪv klˈOs bˈI.');
    expect(await us('We object to the object.')).toBe('wˌi əbʤˈɛkt tə ði ˈɑbʤəkt.');
    expect(await us('the apple')).toBe('ði ˈæpᵊl');
    expect(await us("the dog's bowl")).toBe('ðə dˈɔɡz bˈOl');
  });

  it('matches misaki on numbers, currency and percentages', async () => {
    expect(await us('I paid $5.50 for 3 apples.')).toBe('ˌI pˈAd fˈIv dˈɑləɹz ænd fˈɪfti sˈɛnts fɔɹ θɹˈi ˈæpᵊlz.');
    expect(await us('It rose 50% in 1987.')).toBe('ˌɪt ɹˈOz fˈɪfti pəɹsˈɛnt ɪn nˌIntˈin ˈATi sˈɛvən.');
    expect(await us('The 3rd and the 21st.')).toBe('ðə θˈɜɹd ænd ðə twˈɛnti fˈɜɹst.');
    expect(await us('pi is 3.14')).toBe('pˈI ɪz θɹˈi pYnt wˈʌn fˈɔɹ');
    expect(await us('She was born in 2005.')).toBe('ʃˌi wʌz bˈɔɹn ɪn tˈu θˈWzᵊnd fˈIv.');
    expect(await us('It costs £12 or €3.')).toBe('ˌɪt kˈɔsts twˈɛlv pˈWndz ɔɹ θɹˈi jˈʊɹOz.');
    expect(await us('There were 1,234,567 people.')).toBe(
      'ðˌɛɹ wɜɹ wˈʌn mˈɪljᵊn tˈu hˈʌndɹəd θˈɜɹTi fˈɔɹ θˈWzᵊnd fˈIv hˈʌndɹəd sˈɪksti sˈɛvən pˈipᵊl.',
    );
  });

  it('reads times, abbreviations, units and addresses that misaki leaves to eSpeak', async () => {
    expect(await us('Call me at 10:30.')).toBe('kˈɔl mˌi æt tˈɛn θˈɜɹTi.');
    expect(await us('At 9:00 or 7:05.')).toBe('ˌæt nˈIn əklˈɑk ɔɹ sˈɛvən ˈO fˈIv.');
    expect(await us('Dr. Smith lives on Main St.')).toBe('dˈɑktəɹ smˈɪθ lˈɪvz ˌɔn mˈAn stɹˈit.');
    expect(await us('Sgt. Pepper')).toBe('sˈɑɹʤənt pˈɛpəɹ');
    expect(await us('It weighs 5 kg.')).toBe('ˌɪt wˈAz fˈIv kˈɪləɡɹˌæmz.');
    expect(await us('Mail jane.doe@example.com today.')).toBe('mˈAl ʤˈAn dˈɑt dˈO æt ɪɡzˈæmpəl dˈɑt kˈɑm tədˈA.');
    expect(await us('Visit https://example.org/docs today.')).toBe('vˈɪzət ɪɡzˈæmpəl dˈɑt ˈɔɹɡ slˈæʃ dˈɑks tədˈA.');
  });

  it('uses the British lexicon for British voices', async () => {
    expect(await gb('The keeper read the paper.')).toBe('ðə kˈiːpə ɹˈɛd ðə pˈApə.');
  });

  it('gives every token its offsets in the input', async () => {
    const text = '  "Wait," she said. It cost $3.';
    const { phonemes, tokens } = await g2p.phonemize(text, 'a');
    expect(tokens.map((t) => text.slice(t.start, t.end))).toEqual(['"', 'Wait', ',', '"', 'she', 'said', '.', 'It', 'cost', '$', '3', '.']);
    expect(tokens.map((t) => t.phonemes + t.whitespace).join('')).toBe(phonemes);
    // The currency word goes with the number, after it.
    expect(tokens.slice(-3).map((t) => t.phonemes)).toEqual(['', 'θɹˈi dˈɑləɹz', '.']);
    expect(tokens[0]).toMatchObject({ start: 2, end: 3, phonemes: '“' });
  });

  it('produces only symbols in Kokoro’s vocabulary', async () => {
    const texts = [
      'Zyxqorbian flimflam, naïve café déjà vu!',
      'The CEO of IBM met Dr. Nguyen at 4:15 p.m. on Jan. 3rd, 2024 (or so).',
      'Prices: $1,000.99; ¥500; 3/4 cup; 2nd & 3rd; 100°F; #hashtag @user — wow… “quoted” ‘single’.',
      'αβγ 中文 emoji 😀 and tabs\tand\nnewlines',
    ];
    for (const t of texts)
      for (const lang of ['a', 'b'] as const) {
        const ps = (await g2p.phonemize(t, lang)).phonemes;
        const bad = [...ps].filter((c) => c !== ' ' && !KOKORO_VOCAB.has(c));
        expect(bad, `${t} -> ${ps}`).toEqual([]);
      }
  });
});

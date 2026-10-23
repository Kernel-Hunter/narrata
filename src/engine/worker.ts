/// <reference lib="webworker" />
// TTS worker: downloads and stores the model, picks a device that produces sane audio,
// generates chunks in priority order (preview > playback > export) and encodes exports.

import { env, StyleTextToSpeech2Model, Tensor } from '@huggingface/transformers';
import { tokenTimings, wordTimings, shiftTimings, type WordTiming } from '../core/align';
import { checkAudio, concatFloat32, encodeWav, shapeJoint } from '../core/audio';
import { splitLong, type ChunkEnd } from '../core/chunker';
import { tokenizeWords } from '../core/text';
import { fetchData } from './g2p/assets';
import { EnglishG2P } from './g2p/english';
import type { G2P, PhonemeToken } from './g2p/types';
import { HF_PREFIX, MODEL_FILES, MODEL_REPO, MODEL_REVISION, ModelStore, SUPPORT_FILES, VOICE_BYTES, downloadSize, voicePath, type Variant } from './model-store';
import { encodeM4a } from './export-m4a';
import type { Device, EngineStatus, ExportRequest, FromWorker, GenRequest, ModelChoice, ToWorker } from './protocol';
import { voiceById } from './voices';

declare const self: DedicatedWorkerGlobalScope;

const SAMPLE_RATE = 24000;
const MAX_TOKENS = 510;
const TEST_SENTENCE = 'Hello! This is a short test of the voice, to check that everything sounds right.';

const store = new ModelStore();
const g2p: G2P = new EnglishG2P(fetchData);
let model: StyleTextToSpeech2Model | null = null;
let device: Device = 'wasm';
let variant: Variant = 'q8';
let vocab: Map<string, number> | null = null;
const voices = new Map<string, Float32Array>();
let hasWebGPU = false;
let threads = 1;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

function planFor(choice: ModelChoice): { variant: Variant; device: Device } {
  if (choice === 'compact' || !hasWebGPU) return { variant: 'q8', device: 'wasm' };
  return { variant: 'fp32', device: 'webgpu' };
}

function status(choice: ModelChoice): EngineStatus {
  const plan = planFor(choice);
  const stored = (Object.keys(MODEL_FILES) as Variant[]).filter((v) => store.has(MODEL_FILES[v].path));
  const files = [MODEL_FILES[plan.variant], ...SUPPORT_FILES, { path: voicePath('af_heart'), bytes: VOICE_BYTES }];
  const missingBytes = files.filter((f) => !store.has(f.path)).reduce((s, f) => s + f.bytes, 0);
  return { hasWebGPU, stored, plan: { ...plan, bytes: downloadSize(plan.variant), missingBytes }, persistent: store.persistent, storedBytes: store.storedBytes() };
}

/** transformers.js reads model files through this cache, backed by our OPFS store. */
const opfsCache = {
  async match(request: string | Request): Promise<Response | undefined> {
    const url = typeof request === 'string' ? request : request.url;
    if (!url.startsWith(HF_PREFIX)) return undefined;
    const blob = await store.read(url.slice(HF_PREFIX.length));
    return blob ? new Response(blob, { headers: { 'content-length': String(blob.size) } }) : undefined;
  },
  async put(): Promise<void> {
    // Files are stored by ModelStore before loading.
  },
};

function configureRuntime(baseUrl: string) {
  env.allowLocalModels = false;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = opfsCache;
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
  if (onnx.wasm) {
    onnx.wasm.wasmPaths = new URL('ort/', baseUrl).href;
    threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)) : 1;
    onnx.wasm.numThreads = threads;
  }
}

async function loadVocab(): Promise<Map<string, number>> {
  const blob = await store.read('tokenizer.json');
  if (!blob) throw new Error('Tokenizer missing');
  const json = JSON.parse(await blob.text()) as { model: { vocab: Record<string, number> } };
  return new Map(Object.entries(json.model.vocab));
}

async function ensureVoice(id: string): Promise<Float32Array> {
  const cached = voices.get(id);
  if (cached) return cached;
  const path = voicePath(id);
  await store.ensure([{ path, bytes: VOICE_BYTES }]);
  const blob = await store.read(path);
  if (!blob) throw new Error(`Voice ${id} is not available`);
  const data = new Float32Array(await blob.arrayBuffer());
  voices.set(id, data);
  return data;
}

async function loadModel(v: Variant, d: Device): Promise<number> {
  const t0 = performance.now();
  if (model) {
    await model.dispose().catch(() => {});
    model = null;
  }
  post({ type: 'loading', stage: d === 'webgpu' ? 'Starting the voice on your graphics chip' : 'Starting the voice' });
  model = await StyleTextToSpeech2Model.from_pretrained(MODEL_REPO, {
    dtype: v === 'fp32' ? 'fp32' : 'q8',
    device: d,
    revision: MODEL_REVISION,
  });
  device = d;
  variant = v;
  return performance.now() - t0;
}

interface Synth {
  audio: Float32Array;
  timing: WordTiming;
}

async function runModel(phonemes: string[], voice: Float32Array): Promise<{ audio: Float32Array; durations: number[] | null }> {
  if (!model || !vocab) throw new Error('Model not loaded');
  const ids = new BigInt64Array(phonemes.length + 2);
  phonemes.forEach((c, i) => (ids[i + 1] = BigInt(vocab!.get(c)!)));
  const n = phonemes.length;
  const offset = 256 * Math.min(Math.max(n, 0), 509);
  const style = voice.slice(offset, offset + 256);
  const out = (await model({
    input_ids: new Tensor('int64', ids, [1, ids.length]),
    style: new Tensor('float32', style, [1, 256]),
    speed: new Tensor('float32', new Float32Array([1]), [1]),
  })) as { waveform: Tensor; durations?: Tensor };
  const audio = new Float32Array(out.waveform.data as Float32Array);
  const durations = out.durations ? Array.from(out.durations.data as ArrayLike<number | bigint>, Number) : null;
  return { audio, durations };
}

/**
 * Phoneme characters for the model, each with the index of the G2P token it came from (-1 for
 * the space between tokens). Symbols outside the model's vocabulary are dropped and counted.
 */
function modelPhonemes(tokens: PhonemeToken[]): { phonemes: string[]; owner: number[]; dropped: number } {
  const phonemes: string[] = [];
  const owner: number[] = [];
  let dropped = 0;
  const space = () => {
    if (phonemes.length && phonemes[phonemes.length - 1] !== ' ') {
      phonemes.push(' ');
      owner.push(-1);
    }
  };
  tokens.forEach((t, i) => {
    for (const c of t.phonemes) {
      if (c === ' ') space();
      else if (vocab!.has(c)) {
        phonemes.push(c);
        owner.push(i);
      } else dropped++;
    }
    if (t.whitespace) space();
  });
  while (phonemes[phonemes.length - 1] === ' ') {
    phonemes.pop();
    owner.pop();
  }
  return { phonemes, owner, dropped };
}

/** Phonemize and generate one piece of text, splitting it if it exceeds the token limit. */
async function synthesize(text: string, voiceId: string): Promise<Synth> {
  const v = voiceById(voiceId);
  const voice = await ensureVoice(v.id);
  const g = await g2p.phonemize(text, v.lang);
  const { phonemes, owner, dropped } = modelPhonemes(g.tokens);
  if (dropped) console.warn(`Narrata: ${dropped} phoneme symbols are not in the voice model's vocabulary`, g.phonemes);
  const textWords = tokenizeWords(text);
  const words = textWords.map((w) => text.slice(w.start, w.end));
  const timingFor = (durations: number[] | null, samples: number) =>
    tokenTimings({ words: textWords, tokens: g.tokens, phonemes, owner, durations, samples, sampleRate: SAMPLE_RATE }) ??
    wordTimings({ words, phonemes, durations, samples, sampleRate: SAMPLE_RATE });
  if (phonemes.length > MAX_TOKENS) {
    const parts = splitLong(text, { start: 0, end: text.length }, Math.max(20, Math.floor(text.length / 2)));
    const results: Synth[] = [];
    for (const p of parts) results.push(await synthesize(text.slice(p.start, p.end), voiceId));
    let offset = 0;
    const starts: number[] = [];
    const ends: number[] = [];
    for (const r of results) {
      starts.push(...r.timing.starts.map((s) => s + offset));
      ends.push(...r.timing.ends.map((s) => s + offset));
      offset += r.audio.length / SAMPLE_RATE;
    }
    return { audio: concatFloat32(results.map((r) => r.audio)), timing: { starts, ends, speechEnd: offset, method: results[0]?.timing.method ?? 'proportional' } };
  }
  let attempt = await runModel(phonemes, voice);
  let timing = timingFor(attempt.durations, attempt.audio.length);
  let sane = checkAudio(attempt.audio, SAMPLE_RATE, timing.speechEnd);
  if (!sane.ok && device === 'webgpu') {
    // The GPU path produced broken audio: switch to WebAssembly for good and redo this chunk.
    post({ type: 'fallback', from: 'webgpu', to: 'wasm', reason: sane.reason ?? 'bad audio' });
    await loadModel(variant, 'wasm');
    attempt = await runModel(phonemes, voice);
    timing = timingFor(attempt.durations, attempt.audio.length);
    sane = checkAudio(attempt.audio, SAMPLE_RATE, timing.speechEnd);
  }
  if (!sane.ok) throw new Error(`The voice produced unusable audio (${sane.reason}).`);
  return { audio: attempt.audio, timing };
}

/** Generate a chunk and shape the silence at its edges for a natural joint. */
async function generateChunk(text: string, voiceId: string, endsWith: ChunkEnd): Promise<Synth> {
  const raw = await synthesize(text, voiceId);
  const shaped = shapeJoint(raw.audio, SAMPLE_RATE, endsWith);
  const timing = shiftTimings(raw.timing, shaped.leadTrimmed);
  const total = shaped.audio.length / SAMPLE_RATE;
  return { audio: shaped.audio, timing: { ...timing, ends: timing.ends.map((e) => Math.min(e, total)) } };
}

async function prepare(choice: ModelChoice, voiceId: string): Promise<void> {
  const plan = planFor(choice);
  const files = [MODEL_FILES[plan.variant], ...SUPPORT_FILES, { path: voicePath(voiceId), bytes: VOICE_BYTES }];
  // The G2P data is bundled with the app: load it while the model downloads.
  const g2pReady = g2p.prepare(voiceById(voiceId).lang);
  g2pReady.catch(() => {});
  await store.ensure(files, (p) => post({ type: 'download', loaded: p.loaded, total: p.total }));
  await g2pReady;
  vocab ??= await loadVocab();
  await ensureVoice(voiceId);
  let loadMs = await loadModel(plan.variant, plan.device);
  // Self-test on one short sentence; fall back to WebAssembly if the GPU output is broken.
  post({ type: 'loading', stage: 'Checking the voice' });
  let t0 = performance.now();
  try {
    await synthesize(TEST_SENTENCE, voiceId);
  } catch (e) {
    if (device !== 'webgpu') throw e;
    post({ type: 'fallback', from: 'webgpu', to: 'wasm', reason: String((e as Error).message ?? e) });
    loadMs += await loadModel(plan.variant, 'wasm');
    t0 = performance.now();
    await synthesize(TEST_SENTENCE, voiceId);
  }
  post({ type: 'ready', device, variant, loadMs: Math.round(loadMs), testMs: Math.round(performance.now() - t0), threads });
}

// ---- job queue ----------------------------------------------------------

interface ExportJob extends ExportRequest {
  next: number;
  samples: number;
  pieces: Float32Array[];
  cancelled: boolean;
  encoder?: Awaited<ReturnType<typeof encodeM4a>>;
}

const genQueue: GenRequest[] = [];
const exportQueue: ExportJob[] = [];
let busy = false;
let playEpoch = 0;

function nextGen(): GenRequest | undefined {
  const i = genQueue.findIndex((j) => j.lane === 'preview');
  if (i >= 0) return genQueue.splice(i, 1)[0];
  return genQueue.shift();
}

async function pump(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const job = nextGen();
      if (job) {
        if (job.lane === 'play' && job.epoch < playEpoch) continue;
        const t0 = performance.now();
        try {
          const r = await generateChunk(job.text, job.voice, job.endsWith);
          post(
            { type: 'audio', id: job.id, epoch: job.epoch, lane: job.lane, audio: r.audio, sampleRate: SAMPLE_RATE, starts: r.timing.starts, ends: r.timing.ends, method: r.timing.method, computeMs: Math.round(performance.now() - t0) },
            [r.audio.buffer],
          );
        } catch (e) {
          post({ type: 'gen-error', id: job.id, epoch: job.epoch, message: String((e as Error)?.message ?? e) });
        }
        continue;
      }
      const ex = exportQueue[0];
      if (ex) {
        await exportStep(ex);
        continue;
      }
      break;
    }
  } finally {
    busy = false;
  }
}

async function exportStep(job: ExportJob): Promise<void> {
  const finish = () => exportQueue.shift();
  if (job.cancelled) {
    job.encoder?.abort();
    finish();
    return;
  }
  try {
    if (job.next === 0 && job.format === 'm4a' && !job.encoder) {
      job.encoder = await encodeM4a(SAMPLE_RATE).catch(() => undefined);
    }
    if (job.next < job.chunks.length) {
      const c = job.chunks[job.next];
      const r = await generateChunk(c.text, job.voice, c.endsWith);
      if (job.encoder) job.encoder.add(r.audio);
      else job.pieces.push(r.audio);
      job.samples += r.audio.length;
      job.next++;
      post({ type: 'export-progress', id: job.id, done: job.next, total: job.chunks.length, seconds: job.samples / SAMPLE_RATE });
      return;
    }
    const seconds = job.samples / SAMPLE_RATE;
    if (job.encoder) {
      const data = await job.encoder.finish();
      post({ type: 'export-done', id: job.id, data, mime: 'audio/mp4', ext: 'm4a', seconds }, [data]);
    } else {
      const data = encodeWav(concatFloat32(job.pieces), SAMPLE_RATE);
      post({ type: 'export-done', id: job.id, data, mime: 'audio/wav', ext: 'wav', seconds }, [data]);
    }
    finish();
  } catch (e) {
    job.encoder?.abort();
    finish();
    post({ type: 'export-error', id: job.id, message: String((e as Error)?.message ?? e) });
  }
}

let baseUrl = '';

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        baseUrl = m.baseUrl;
        configureRuntime(baseUrl);
        [hasWebGPU] = await Promise.all([detectWebGPU(), store.init()]);
        post({ type: 'status', status: status(m.choice) });
        break;
      }
      case 'prepare':
        await prepare(m.choice, m.voice);
        post({ type: 'status', status: status(m.choice) });
        break;
      case 'generate':
        genQueue.push(m);
        void pump();
        break;
      case 'cancel':
        playEpoch = Math.max(playEpoch, m.epoch);
        for (let i = genQueue.length - 1; i >= 0; i--) if (genQueue[i].lane === 'play' && genQueue[i].epoch < playEpoch) genQueue.splice(i, 1);
        break;
      case 'voice':
        await Promise.all([ensureVoice(m.voice), g2p.prepare(voiceById(m.voice).lang)]);
        post({ type: 'voice-ready', voice: m.voice });
        break;
      case 'export':
        exportQueue.push({ ...m, next: 0, samples: 0, pieces: [], cancelled: false });
        void pump();
        break;
      case 'export-cancel': {
        const job = exportQueue.find((j) => j.id === m.id);
        if (job) job.cancelled = true;
        break;
      }
      case 'clear':
        if (model) await model.dispose().catch(() => {});
        model = null;
        voices.clear();
        vocab = null;
        await store.clear();
        post({ type: 'status', status: status('auto') });
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};

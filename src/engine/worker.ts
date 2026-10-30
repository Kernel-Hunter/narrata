/// <reference lib="webworker" />
// TTS worker: downloads and stores the model, picks a device that produces sane audio,
// generates chunks in priority order (preview > playback > export) and encodes exports.

import { tokenTimings, wordTimings, shiftTimings, type WordTiming } from '../core/align';
import { checkAudio, concatFloat32, encodeWav, shapeJoint } from '../core/audio';
import { splitLong, type ChunkEnd } from '../core/chunker';
import { cpuVariant as pickCpuVariant, threadCount as pickThreads } from '../core/device';
import { tokenizeWords } from '../core/text';
import { fetchData } from './g2p/assets';
import { EnglishG2P } from './g2p/english';
import type { G2P, PhonemeToken } from './g2p/types';
import { MODEL_FILES, ModelStore, PIPER_SOURCE, SUPPORT_FILES, VOICE_BYTES, downloadSize, voicePath, type Variant } from './model-store';
import { PiperModel, phonemeDurations, piperInput, resample, type PiperConfig } from './piper/piper';
import { createSession, loadRuntime, type OrtModule, type Session } from './runtime';
import { encodeM4a } from './export-m4a';
import { probeDevice } from './probe';
import type { Device, EnginePlan, EngineStatus, ExportRequest, FromWorker, GenRequest, ModelChoice, ToWorker, Tuning } from './protocol';
import type { DeviceProbe } from '../core/device';
import { DEFAULT_VOICE, PIPER_VOICES, isPiper, voiceById, type PiperVoice } from './voices';

declare const self: DedicatedWorkerGlobalScope;

const SAMPLE_RATE = 24000;
const MAX_TOKENS = 510;
const TEST_SENTENCE = 'Hello! This is a short test of the voice, to check that everything sounds right.';

const store = new ModelStore();
const piperStore = new ModelStore(PIPER_SOURCE);
const g2p: G2P = new EnglishG2P(fetchData);
let model: Session | null = null;
/** The Kokoro model to load when a Kokoro voice is used (set by prepare). */
let kokoroPlan: { variant: Variant; device: Device } | null = null;
let piper: { id: string; model: PiperModel } | null = null;
let ort: OrtModule | null = null;
let device: Device = 'wasm';
let variant: Variant = 'q8';
let vocab: Map<string, number> | null = null;
const voices = new Map<string, Float32Array>();
let hasWebGPU = false;
let threads = 1;
let tuning: Tuning = {};
let lastChoice: ModelChoice = 'auto';
/** The voice the app has selected: status reports what it needs. */
let selected = DEFAULT_VOICE;
let probe: DeviceProbe | undefined;

const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, transfer);

async function detectWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return !!(gpu && (await gpu.requestAdapter()));
  } catch {
    return false;
  }
}

/**
 * The processor uses the 8-bit model with static quantization (uint8, 178 MB): in ONNX Runtime Web
 * it generates about twice as fast as the dynamically quantized q8 export (93 MB) and as fast as
 * full precision (326 MB), with about the same quality as q8. See cpuVariant in core/device.ts.
 */
function cpuVariant(): Variant {
  return tuning.variant ?? pickCpuVariant(store.has(MODEL_FILES.q8.path), store.has(MODEL_FILES.uint8.path));
}

function planFor(choice: ModelChoice): { variant: Variant; device: Device } {
  if (choice === 'compact' || !hasWebGPU) return { variant: cpuVariant(), device: 'wasm' };
  return { variant: 'fp32', device: 'webgpu' };
}

/** Files of the natural voice: the model for this device, the tokenizer and config, one voice. */
function kokoroFiles(variant: Variant, voiceId: string) {
  return [MODEL_FILES[variant], ...SUPPORT_FILES, { path: voicePath(voiceId), bytes: VOICE_BYTES }];
}

function kokoroStatus(choice: ModelChoice, voiceId: string): EnginePlan {
  const plan = planFor(choice);
  const missingBytes = kokoroFiles(plan.variant, voiceId).filter((f) => !store.has(f.path)).reduce((s, f) => s + f.bytes, 0);
  return { engine: 'kokoro', ...plan, bytes: downloadSize(plan.variant), missingBytes };
}

function piperStatus(v: PiperVoice): EnginePlan {
  const files = piperFiles(v);
  const missingBytes = files.filter((f) => !piperStore.has(f.path)).reduce((s, f) => s + f.bytes, 0);
  return { engine: 'piper', variant: 'uint8', device: 'wasm', bytes: files.reduce((s, f) => s + f.bytes, 0), missingBytes };
}

function status(choice: ModelChoice): EngineStatus {
  const v = voiceById(selected);
  const kokoro = kokoroStatus(choice, isPiper(v) ? DEFAULT_VOICE : v.id);
  const stored = (Object.keys(MODEL_FILES) as Variant[]).filter((x) => store.has(MODEL_FILES[x].path));
  const fastVoices = PIPER_VOICES.filter((p) => piperFiles(p).every((f) => piperStore.has(f.path))).map((p) => p.id);
  return {
    hasWebGPU,
    stored,
    fastVoices,
    plan: isPiper(v) ? piperStatus(v) : kokoro,
    kokoro,
    persistent: store.persistent,
    storedBytes: store.storedBytes() + piperStore.storedBytes(),
    probe,
  };
}

/**
 * Nothing downloaded yet: run the device check that the first-run choice is based on, then report
 * it. It waits a moment first: while the page is still loading, the benchmark measured a third of
 * the speed it measures a second later (on an M5 laptop, 250 against 750), as the worker competes
 * with the page's start-up work. The choice is shown at once and the suggestion follows.
 */
const PROBE_DELAY_MS = 1000;
let probeTimer = 0;
function probeIfFirstRun() {
  probe = undefined;
  clearTimeout(probeTimer);
  if (store.storedBytes() + piperStore.storedBytes() > 0) return;
  probeTimer = self.setTimeout(() => {
    if (store.storedBytes() + piperStore.storedBytes() > 0 || kokoroPlan) return;
    probe = probeDevice(hasWebGPU, true, threadCount());
    post({ type: 'status', status: status(lastChoice) });
  }, PROBE_DELAY_MS);
}

let baseUrl = '';

function threadCount(): number {
  if (!self.crossOriginIsolated) return 1;
  return tuning.threads ?? pickThreads(navigator.hardwareConcurrency, true);
}

async function loadVocab(): Promise<Map<string, number>> {
  const blob = await store.read('tokenizer.json');
  if (!blob) throw new Error('Tokenizer missing');
  const json = JSON.parse(await blob.text()) as { model: { vocab: Record<string, number> } };
  return new Map(Object.entries(json.model.vocab));
}

function piperFiles(v: PiperVoice) {
  return [
    { path: `${v.path}.onnx`, bytes: v.bytes },
    { path: `${v.path}.onnx.json`, bytes: v.configBytes },
  ];
}

/**
 * Download (with progress) and load a Piper voice; one is kept in memory at a time. Progress is
 * reported as the main download when this is the voice being prepared, as a voice download when
 * switching voices.
 */
async function ensurePiper(v: PiperVoice, main = false): Promise<PiperModel> {
  if (piper?.id === v.id) return piper.model;
  const files = piperFiles(v);
  await piperStore.ensure(files, (p) => post(main ? { type: 'download', loaded: p.loaded, total: p.total } : { type: 'voice-download', voice: v.id, loaded: p.loaded, total: p.total }));
  const [modelBlob, configBlob] = await Promise.all(files.map((f) => piperStore.read(f.path)));
  if (!modelBlob || !configBlob) throw new Error(`Voice ${v.name} is not available`);
  if (piper) await piper.model.release().catch(() => {});
  piper = null;
  if (!ort) {
    threads = threadCount();
    ort = await loadRuntime('wasm', { wasmBase: new URL('ort/', baseUrl).href, threads, build: tuning.build });
  }
  const config = JSON.parse(await configBlob.text()) as PiperConfig;
  piper = { id: v.id, model: await PiperModel.load(ort, new Uint8Array(await modelBlob.arrayBuffer()), config) };
  return piper.model;
}

/**
 * Load the Kokoro model when a Kokoro voice is used after starting with a Piper voice. The model is
 * downloaded first if needed (only Piper may have been downloaded), with progress reported as a
 * download of that voice, since the Piper voice keeps reading meanwhile.
 */
let kokoroLoading: Promise<void> | null = null;
function ensureKokoro(voiceId: string): Promise<void> {
  if (model) return Promise.resolve();
  const plan = kokoroPlan;
  if (!plan) return Promise.reject(new Error('Model not loaded'));
  kokoroLoading ??= (async () => {
    await store.ensure(kokoroFiles(plan.variant, voiceId), (p) => post({ type: 'voice-download', voice: voiceId, loaded: p.loaded, total: p.total }));
    post({ type: 'status', status: status(lastChoice) });
    vocab ??= await loadVocab();
    await startKokoro(plan, voiceId);
  })().finally(() => {
    kokoroLoading = null;
  });
  return kokoroLoading;
}

/**
 * Load the Kokoro model on the planned device and check it on a test sentence, which also measures
 * the speed so playback does not start from a guess. If the graphics chip fails to load the model,
 * throws on the test or produces bad audio (the per-chunk check in synthesizeKokoro), Kokoro moves
 * to the processor for good. Used for the first start and when switching from a Piper voice.
 */
async function startKokoro(plan: { variant: Variant; device: Device }, voiceId: string): Promise<void> {
  let loadMs = 0;
  const attempt = async (d: Device) => {
    loadMs += await loadModel(plan.variant, d);
    post({ type: 'loading', stage: 'Checking the voice' });
    const t0 = performance.now();
    const test = await synthesizeKokoro(TEST_SENTENCE, voiceId);
    return { test, testMs: performance.now() - t0 };
  };
  let r: Awaited<ReturnType<typeof attempt>>;
  try {
    r = await attempt(plan.device);
  } catch (e) {
    // Rethrow if the processor was already tried (synthesizeKokoro moves there on bad audio).
    if (plan.device !== 'webgpu' || (device === 'wasm' && model)) throw e;
    post({ type: 'fallback', from: 'webgpu', to: 'wasm', reason: String((e as Error)?.message ?? e) });
    r = await attempt('wasm');
  }
  post({ type: 'ready', device, variant, engine: 'kokoro', loadMs: Math.round(loadMs), testMs: Math.round(r.testMs), testRtf: +(r.test.audio.length / SAMPLE_RATE / (r.testMs / 1000)).toFixed(3), threads });
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
    await model.release().catch(() => {});
    model = null;
  }
  post({ type: 'loading', stage: d === 'webgpu' ? 'Starting the voice on your graphics chip' : 'Starting the voice' });
  threads = threadCount();
  ort = await loadRuntime(d, { wasmBase: new URL('ort/', baseUrl).href, threads, build: tuning.build });
  const blob = await store.read(MODEL_FILES[v].path);
  if (!blob) throw new Error('The voice model is missing. Download it again.');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  model = await createSession(ort, bytes, d, tuning.session);
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
  const out = await model.run({
    input_ids: new ort!.Tensor('int64', ids, [1, ids.length]),
    style: new ort!.Tensor('float32', style, [1, 256]),
    speed: new ort!.Tensor('float32', new Float32Array([1]), [1]),
  });
  const audio = new Float32Array(out.waveform.data as Float32Array);
  const durations = out.durations ? Array.from(out.durations.data as ArrayLike<number | bigint>, Number) : null;
  for (const t of Object.values(out)) t.dispose();
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

/** Generate one piece of text with a Piper voice (resampled to the app's sample rate). */
async function synthesizePiper(text: string, v: PiperVoice): Promise<Synth> {
  const pm = await ensurePiper(v);
  const g = await g2p.phonemize(text, v.lang);
  const input = piperInput(g.tokens, v.lang === 'b', pm.config.phoneme_id_map);
  const textWords = tokenizeWords(text);
  if (!input.phonemes.length) return { audio: new Float32Array(Math.round(SAMPLE_RATE * 0.1)), timing: { starts: textWords.map(() => 0), ends: textWords.map(() => 0), speechEnd: 0, method: 'proportional' } };
  const out = await pm.run(input.ids);
  const audio = resample(out.audio, pm.sampleRate, SAMPLE_RATE);
  const durations = phonemeDurations(out.frames, input.phonemes.length);
  const timing =
    tokenTimings({ words: textWords, tokens: g.tokens, phonemes: input.phonemes, owner: input.owner, durations, samples: audio.length, sampleRate: SAMPLE_RATE }) ??
    wordTimings({ words: textWords.map((w) => text.slice(w.start, w.end)), phonemes: input.phonemes, durations, samples: audio.length, sampleRate: SAMPLE_RATE });
  const sane = checkAudio(audio, SAMPLE_RATE, timing.speechEnd);
  if (!sane.ok) throw new Error(`The voice produced unusable audio (${sane.reason}).`);
  return { audio, timing };
}

/** Phonemize and generate one piece of text, splitting it if it exceeds the token limit. */
async function synthesize(text: string, voiceId: string): Promise<Synth> {
  const v = voiceById(voiceId);
  if (isPiper(v)) return synthesizePiper(text, v);
  await ensureKokoro(v.id);
  return synthesizeKokoro(text, voiceId);
}

async function synthesizeKokoro(text: string, voiceId: string): Promise<Synth> {
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
  if (device === 'webgpu' && tuning.failGpu) sane = { ...sane, ok: false, reason: 'nan' };
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
  // Kept for later: with a Piper voice selected, Kokoro is downloaded and loaded only when a
  // Kokoro voice is used.
  kokoroPlan = plan;
  selected = voiceId;
  const v = voiceById(voiceId);
  // The G2P data is bundled with the app: load it while the model downloads.
  const tStart = performance.now();
  const g2pReady = g2p.prepare(v.lang).then(() => performance.now() - tStart);
  g2pReady.catch(() => {});
  if (isPiper(v)) {
    await ensurePiper(v, true);
    await g2pReady;
    post({ type: 'loading', stage: 'Checking the voice' });
    const t0 = performance.now();
    const test = await synthesize(TEST_SENTENCE, voiceId);
    const testMs = performance.now() - t0;
    post({ type: 'ready', device: 'wasm', variant: plan.variant, engine: 'piper', loadMs: Math.round(t0 - tStart), testMs: Math.round(testMs), testRtf: +(test.audio.length / SAMPLE_RATE / (testMs / 1000)).toFixed(3), threads });
    return;
  }
  await store.ensure(kokoroFiles(plan.variant, voiceId), (p) => post({ type: 'download', loaded: p.loaded, total: p.total }));
  const tFiles = performance.now() - tStart;
  const g2pMs = await g2pReady;
  vocab ??= await loadVocab();
  await ensureVoice(voiceId);
  const t1 = performance.now();
  await startKokoro(plan, voiceId);
  console.info(`Narrata engine: files ${Math.round(tFiles)} ms, G2P data ${Math.round(g2pMs)} ms, model and test ${Math.round(performance.now() - t1)} ms`);
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

// Messages that arrive while 'init' is still running (it awaits storage) wait for it.
let initDone: Promise<void> = Promise.resolve();

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type !== 'init') await initDone;
    switch (m.type) {
      case 'init': {
        baseUrl = m.baseUrl;
        tuning = m.tuning ?? {};
        lastChoice = m.choice;
        selected = m.voice;
        const ready = Promise.all([detectWebGPU(), store.init(), piperStore.init()]).then(([gpu]) => {
          hasWebGPU = gpu;
          probeIfFirstRun();
        });
        initDone = ready.catch(() => {});
        await ready;
        post({ type: 'status', status: status(m.choice) });
        break;
      }
      case 'select':
        lastChoice = m.choice;
        selected = m.voice;
        post({ type: 'status', status: status(m.choice) });
        break;
      case 'prepare':
        lastChoice = m.choice;
        try {
          await prepare(m.choice, m.voice);
        } finally {
          // Also after a failed download, so the sizes shown are up to date.
          post({ type: 'status', status: status(m.choice) });
        }
        break;
      case 'generate':
        genQueue.push(m);
        void pump();
        break;
      case 'cancel':
        playEpoch = Math.max(playEpoch, m.epoch);
        for (let i = genQueue.length - 1; i >= 0; i--) if (genQueue[i].lane === 'play' && genQueue[i].epoch < playEpoch) genQueue.splice(i, 1);
        break;
      case 'voice': {
        const v = voiceById(m.voice);
        selected = m.voice;
        try {
          await Promise.all([isPiper(v) ? ensurePiper(v) : model || !kokoroPlan ? ensureVoice(v.id) : ensureKokoro(v.id).then(() => ensureVoice(v.id)), g2p.prepare(v.lang)]);
          post({ type: 'voice-ready', voice: m.voice });
        } catch (err) {
          post({ type: 'voice-error', voice: m.voice, message: String((err as Error)?.message ?? err) });
        }
        post({ type: 'status', status: status(lastChoice) });
        break;
      }
      case 'export':
        exportQueue.push({ ...m, next: 0, samples: 0, pieces: [], cancelled: false });
        void pump();
        break;
      case 'export-cancel': {
        const job = exportQueue.find((j) => j.id === m.id);
        if (job) job.cancelled = true;
        break;
      }
      case 'probe': {
        const p = probeDevice(hasWebGPU, true, threadCount());
        post({ type: 'probe', probe: p });
        // On the first run this replaces the check made at start (the tab may have been hidden).
        if (store.storedBytes() + piperStore.storedBytes() === 0) {
          probe = p;
          post({ type: 'status', status: status(lastChoice) });
        }
        break;
      }
      case 'clear':
        if (model) await model.release().catch(() => {});
        if (piper) await piper.model.release().catch(() => {});
        model = null;
        piper = null;
        kokoroPlan = null;
        voices.clear();
        vocab = null;
        // Both stores: without OPFS the Piper files live in memory and would survive otherwise.
        await ModelStore.removeAll();
        await store.clear();
        await piperStore.clear();
        probeIfFirstRun();
        post({ type: 'status', status: status(lastChoice) });
        break;
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) });
  }
};

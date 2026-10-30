// Main-thread side of the TTS worker.

import type { ChunkEnd } from '../core/chunker';
import type { DeviceProbe } from '../core/device';
import type { Device, EngineStatus, FromWorker, GenResult, ModelChoice, ToWorker, Tuning } from './protocol';
import type { Variant } from './model-store';

export type EngineState = 'starting' | 'needs-download' | 'downloading' | 'loading' | 'ready' | 'error';

export interface EngineInfo {
  state: EngineState;
  status?: EngineStatus;
  download?: { loaded: number; total: number; startedAt: number };
  stage?: string;
  device?: Device;
  variant?: Variant;
  loadMs?: number;
  /** Duration of the start-up self-test (one short sentence), a rough speed indicator. */
  testMs?: number;
  /** Generation speed in the self-test: seconds of audio per second. */
  testRtf?: number;
  threads?: number;
  /** Which model the ready voice uses. */
  engine?: 'kokoro' | 'piper';
  /** Download of a fast voice in progress. */
  voiceDownload?: { voice: string; loaded: number; total: number };
  error?: string;
  fallback?: string;
}

type Listener = (info: EngineInfo) => void;

interface Pending {
  resolve: (r: GenResult) => void;
  reject: (e: Error) => void;
}

export class TtsClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<Listener>();
  private exports = new Map<number, { onProgress: (done: number, total: number, seconds: number) => void; resolve: (r: { data: ArrayBuffer; mime: string; ext: string; seconds: number }) => void; reject: (e: Error) => void }>();
  private voiceWaiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }[]>();
  info: EngineInfo = { state: 'starting' };
  private readyWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private statusWaiters: ((info: EngineInfo) => void)[] = [];
  private probeWaiters: ((p: DeviceProbe) => void)[] = [];

  constructor(choice: ModelChoice, voice: string, tuning?: Tuning) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'narrata-tts' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.update({ state: 'error', error: e.message || 'The voice engine failed to start.' });
    this.send({ type: 'init', baseUrl: new URL('./', document.baseURI).href, choice, voice, tuning });
  }

  private send(m: ToWorker, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer);
  }

  private update(patch: Partial<EngineInfo>) {
    this.info = { ...this.info, ...patch };
    for (const l of this.listeners) l(this.info);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.info);
    return () => this.listeners.delete(l);
  }

  private onMessage(m: FromWorker) {
    switch (m.type) {
      case 'status': {
        const state: EngineState = this.info.state === 'ready' ? 'ready' : m.status.plan.missingBytes > 0 ? 'needs-download' : 'loading';
        this.update({ status: m.status, state: this.info.state === 'downloading' || this.info.state === 'loading' ? this.info.state : state });
        this.statusWaiters.splice(0).forEach((w) => w(this.info));
        break;
      }
      case 'download':
        this.update({ state: 'downloading', download: { loaded: m.loaded, total: m.total, startedAt: this.info.download?.startedAt ?? performance.now() } });
        break;
      case 'loading':
        this.update({ state: 'loading', stage: m.stage });
        break;
      case 'ready':
        this.update({ state: 'ready', device: m.device, variant: m.variant, engine: m.engine, loadMs: m.loadMs, testMs: m.testMs, testRtf: m.testRtf, threads: m.threads, stage: undefined, error: undefined, voiceDownload: undefined });
        this.readyWaiters.splice(0).forEach((w) => w.resolve());
        void navigator.storage?.persist?.().catch(() => false);
        break;
      case 'fallback':
        this.update({ fallback: `Switched from ${m.from === 'webgpu' ? 'graphics chip' : m.from} to processor (${m.reason}).` });
        break;
      case 'audio': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.resolve(m);
        break;
      }
      case 'gen-error': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        p?.reject(new Error(m.message));
        break;
      }
      case 'voice-ready':
        this.voiceWaiters.get(m.voice)?.forEach((w) => w.resolve());
        this.voiceWaiters.delete(m.voice);
        if (this.info.voiceDownload?.voice === m.voice) this.update({ voiceDownload: undefined });
        break;
      case 'voice-error':
        this.voiceWaiters.get(m.voice)?.forEach((w) => w.reject(new Error(m.message)));
        this.voiceWaiters.delete(m.voice);
        if (this.info.voiceDownload?.voice === m.voice) this.update({ voiceDownload: undefined });
        break;
      case 'voice-download':
        this.update({ voiceDownload: { voice: m.voice, loaded: m.loaded, total: m.total } });
        break;
      case 'export-progress':
        this.exports.get(m.id)?.onProgress(m.done, m.total, m.seconds);
        break;
      case 'export-done': {
        const x = this.exports.get(m.id);
        this.exports.delete(m.id);
        x?.resolve({ data: m.data, mime: m.mime, ext: m.ext, seconds: m.seconds });
        break;
      }
      case 'export-error': {
        const x = this.exports.get(m.id);
        this.exports.delete(m.id);
        x?.reject(new Error(m.message));
        break;
      }
      case 'probe':
        this.probeWaiters.splice(0).forEach((w) => w(m.probe));
        break;
      case 'error':
        this.update({ state: this.info.state === 'ready' ? 'ready' : 'error', error: m.message, voiceDownload: undefined });
        this.readyWaiters.splice(0).forEach((w) => w.reject(new Error(m.message)));
        break;
    }
  }

  /** Download what is missing (if anything), load the model and run the self-test. */
  prepare(choice: ModelChoice, voice: string): Promise<void> {
    if (this.info.state === 'ready') return Promise.resolve();
    const p = new Promise<void>((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
    if (this.readyWaiters.length === 1) {
      this.update({ state: this.info.status?.plan.missingBytes ? 'downloading' : 'loading', error: undefined, download: undefined });
      this.send({ type: 'prepare', choice, voice });
    }
    return p;
  }

  /**
   * Change the selected voice before the engine is ready, without downloading anything: the worker
   * reports what that voice needs (a fast voice needs only its own files). Resolves with the info
   * once the new status has arrived.
   */
  select(choice: ModelChoice, voice: string): Promise<EngineInfo> {
    const p = new Promise<EngineInfo>((resolve) => this.statusWaiters.push(resolve));
    this.send({ type: 'select', choice, voice });
    return p;
  }

  /** Run the device check in the worker (for measurements). */
  probe(): Promise<DeviceProbe> {
    const p = new Promise<DeviceProbe>((resolve) => this.probeWaiters.push(resolve));
    this.send({ type: 'probe' });
    return p;
  }

  get ready(): boolean {
    return this.info.state === 'ready';
  }

  generate(text: string, voice: string, endsWith: ChunkEnd, epoch: number, lane: 'play' | 'preview' = 'play'): Promise<GenResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: 'generate', id, epoch, lane, text, voice, endsWith });
    });
  }

  cancel(epoch: number) {
    this.send({ type: 'cancel', epoch });
  }

  /** Make a voice ready (fast voices are downloaded the first time). */
  ensureVoice(voice: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const list = this.voiceWaiters.get(voice) ?? [];
      list.push({ resolve, reject });
      this.voiceWaiters.set(voice, list);
      if (list.length === 1) this.send({ type: 'voice', voice });
    });
  }

  exportAudio(
    chunks: { text: string; endsWith: ChunkEnd }[],
    voice: string,
    title: string,
    format: 'm4a' | 'wav',
    onProgress: (done: number, total: number, seconds: number) => void,
  ): { promise: Promise<{ data: ArrayBuffer; mime: string; ext: string; seconds: number }>; cancel: () => void } {
    const id = this.nextId++;
    const promise = new Promise<{ data: ArrayBuffer; mime: string; ext: string; seconds: number }>((resolve, reject) => {
      this.exports.set(id, { onProgress, resolve, reject });
    });
    this.send({ type: 'export', id, chunks, voice, title, format });
    return {
      promise,
      cancel: () => {
        this.send({ type: 'export-cancel', id });
        const x = this.exports.get(id);
        this.exports.delete(id);
        x?.reject(new Error('cancelled'));
      },
    };
  }

  clearModels() {
    this.update({ state: 'starting', device: undefined, variant: undefined });
    this.send({ type: 'clear' });
  }
}

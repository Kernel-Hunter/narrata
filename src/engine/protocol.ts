import type { ChunkEnd } from '../core/chunker';
import type { DeviceProbe } from '../core/device';
import type { Variant } from './model-store';
import type { SessionTuning } from './runtime';

export type Device = 'webgpu' | 'wasm';
export type ModelChoice = 'auto' | 'compact';

/** Overrides for measurements (set from URL parameters in debug mode only). */
export interface Tuning {
  threads?: number;
  variant?: Variant;
  build?: 'wasm' | 'webgpu';
  session?: SessionTuning;
  /** Treat every graphics chip result as bad audio, to exercise the fallback to the processor. */
  failGpu?: boolean;
}

/** What a voice needs before it can read: the model files, and how many of them are missing. */
export interface EnginePlan {
  engine: 'kokoro' | 'piper';
  variant: Variant;
  device: Device;
  bytes: number;
  missingBytes: number;
}

export interface EngineStatus {
  hasWebGPU: boolean;
  /** Variants whose files are fully stored. */
  stored: Variant[];
  /** Fast (Piper) voices whose files are stored. */
  fastVoices: string[];
  /** What the selected voice needs. */
  plan: EnginePlan;
  /** What the natural (Kokoro) voices need, also while a fast voice is selected. */
  kokoro: EnginePlan;
  persistent: boolean;
  storedBytes: number;
  /** The device check, made on the first run (when nothing is stored yet). */
  probe?: DeviceProbe;
}

export interface GenRequest {
  type: 'generate';
  id: number;
  epoch: number;
  lane: 'play' | 'preview';
  text: string;
  voice: string;
  endsWith: ChunkEnd;
}

export interface ExportRequest {
  type: 'export';
  id: number;
  voice: string;
  title: string;
  format: 'm4a' | 'wav';
  chunks: { text: string; endsWith: ChunkEnd }[];
}

export type ToWorker =
  | { type: 'init'; baseUrl: string; choice: ModelChoice; voice: string; tuning?: Tuning }
  | { type: 'prepare'; choice: ModelChoice; voice: string }
  /** The selected voice changed before anything was loaded: report what it needs, download nothing. */
  | { type: 'select'; choice: ModelChoice; voice: string }
  | GenRequest
  | { type: 'cancel'; epoch: number }
  | { type: 'voice'; voice: string }
  | ExportRequest
  | { type: 'export-cancel'; id: number }
  | { type: 'clear' }
  /** Run the device check again (on the first run it replaces the one made at start). */
  | { type: 'probe' };

export interface GenResult {
  type: 'audio';
  id: number;
  epoch: number;
  lane: 'play' | 'preview';
  audio: Float32Array;
  sampleRate: number;
  /** Word start/end times in seconds, one per spoken word of the chunk text. */
  starts: number[];
  ends: number[];
  method: string;
  computeMs: number;
}

export type FromWorker =
  | { type: 'status'; status: EngineStatus }
  | { type: 'download'; loaded: number; total: number }
  | { type: 'loading'; stage: string }
  | { type: 'ready'; device: Device; variant: Variant; engine: 'kokoro' | 'piper'; loadMs: number; testMs: number; testRtf: number; threads: number }
  | { type: 'fallback'; from: Device; to: Device; reason: string }
  | GenResult
  | { type: 'gen-error'; id: number; epoch: number; message: string }
  | { type: 'voice-ready'; voice: string }
  | { type: 'voice-download'; voice: string; loaded: number; total: number }
  | { type: 'voice-error'; voice: string; message: string }
  | { type: 'export-progress'; id: number; done: number; total: number; seconds: number }
  | { type: 'export-done'; id: number; data: ArrayBuffer; mime: string; ext: string; seconds: number }
  | { type: 'export-error'; id: number; message: string }
  | { type: 'probe'; probe: DeviceProbe }
  | { type: 'error'; message: string };

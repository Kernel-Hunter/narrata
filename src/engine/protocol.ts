import type { ChunkEnd } from '../core/chunker';
import type { Variant } from './model-store';

export type Device = 'webgpu' | 'wasm';
export type ModelChoice = 'auto' | 'compact';

export interface EngineStatus {
  hasWebGPU: boolean;
  /** Variants whose files are fully stored. */
  stored: Variant[];
  plan: { variant: Variant; device: Device; bytes: number; missingBytes: number };
  persistent: boolean;
  storedBytes: number;
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
  | { type: 'init'; baseUrl: string; choice: ModelChoice }
  | { type: 'prepare'; choice: ModelChoice; voice: string }
  | GenRequest
  | { type: 'cancel'; epoch: number }
  | { type: 'voice'; voice: string }
  | ExportRequest
  | { type: 'export-cancel'; id: number }
  | { type: 'clear' };

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
  | { type: 'ready'; device: Device; variant: Variant; loadMs: number; testMs: number; threads: number }
  | { type: 'fallback'; from: Device; to: Device; reason: string }
  | GenResult
  | { type: 'gen-error'; id: number; epoch: number; message: string }
  | { type: 'voice-ready'; voice: string }
  | { type: 'export-progress'; id: number; done: number; total: number; seconds: number }
  | { type: 'export-done'; id: number; data: ArrayBuffer; mime: string; ext: string; seconds: number }
  | { type: 'export-error'; id: number; message: string }
  | { type: 'error'; message: string };

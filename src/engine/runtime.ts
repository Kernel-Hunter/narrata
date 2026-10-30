// ONNX Runtime Web, used directly. The processor path loads the WebAssembly-only build, the
// graphics chip path the WebGPU build (which also runs on the processor, for the fallback).

import type { Device } from './protocol';

export interface Tensor {
  readonly data: unknown;
  readonly dims: readonly number[];
  dispose(): void;
}

export interface Session {
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  release(): Promise<void>;
}

/** The parts of the onnxruntime-web module the engine uses. */
export interface OrtModule {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean }; webgpu: { powerPreference?: string } };
  Tensor: new (type: 'int64' | 'float32', data: BigInt64Array | Float32Array, dims: readonly number[]) => Tensor;
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<Session> };
}

export interface RuntimeOptions {
  /** URL of the directory with the ONNX Runtime .wasm and .mjs files. */
  wasmBase: string;
  threads: number;
  /** Force a build (for measurements): 'webgpu' is the JSEP build, 'wasm' the plain one. */
  build?: 'wasm' | 'webgpu';
}

const modules = new Map<string, Promise<OrtModule>>();

export function loadRuntime(device: Device, opts: RuntimeOptions): Promise<OrtModule> {
  const build = opts.build ?? (device === 'webgpu' ? 'webgpu' : 'wasm');
  let p = modules.get(build);
  if (!p) {
    p = (build === 'webgpu' ? import('onnxruntime-web/webgpu') : import('onnxruntime-web/wasm')).then((m) => {
      const ort = m as unknown as OrtModule;
      ort.env.wasm.wasmPaths = opts.wasmBase;
      ort.env.wasm.numThreads = opts.threads;
      ort.env.wasm.proxy = false;
      if (build === 'webgpu') ort.env.webgpu.powerPreference = 'high-performance';
      return ort;
    });
    modules.set(build, p);
  }
  return p;
}

export interface SessionTuning {
  graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
  executionMode?: 'sequential' | 'parallel';
  /** Extra session config entries, e.g. { session: { intra_op: { allow_spinning: '0' } } }. */
  extra?: Record<string, unknown>;
}

export async function createSession(ort: OrtModule, model: Uint8Array, device: Device, tuning: SessionTuning = {}): Promise<Session> {
  return ort.InferenceSession.create(model, {
    executionProviders: [device],
    graphOptimizationLevel: tuning.graphOptimizationLevel ?? 'all',
    executionMode: tuning.executionMode ?? 'sequential',
    ...(tuning.extra ? { extra: tuning.extra } : {}),
  });
}

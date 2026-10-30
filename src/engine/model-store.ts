// Model files live in the Origin Private File System. The Cache API fails for entries above
// about 250 MB (measured in the spike), and the full-precision model is 326 MB.
// Runs inside the TTS worker (synchronous access handles are worker-only).

export const MODEL_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
/** Pinned revision so every install loads the same files. */
export const MODEL_REVISION = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';

/**
 * Model files of the export. The app uses fp32 on the graphics chip and uint8 on the processor
 * (q8 for installs that stored it before); the others are only reachable with ?debug&variant= for
 * measurements.
 */
export type Variant = 'fp32' | 'q8' | 'q8f16' | 'uint8' | 'uint8f16' | 'q4' | 'q4f16' | 'fp16';

export const MODEL_FILES: Record<Variant, { path: string; bytes: number }> = {
  fp32: { path: 'onnx/model.onnx', bytes: 325_532_171 },
  q8: { path: 'onnx/model_quantized.onnx', bytes: 92_361_055 },
  q8f16: { path: 'onnx/model_q8f16.onnx', bytes: 86_072_942 },
  uint8: { path: 'onnx/model_uint8.onnx', bytes: 177_464_571 },
  uint8f16: { path: 'onnx/model_uint8f16.onnx', bytes: 114_182_909 },
  q4: { path: 'onnx/model_q4.onnx', bytes: 305_215_905 },
  q4f16: { path: 'onnx/model_q4f16.onnx', bytes: 154_584_426 },
  fp16: { path: 'onnx/model_fp16.onnx', bytes: 163_232_776 },
};

export const SUPPORT_FILES = [
  { path: 'config.json', bytes: 44 },
  { path: 'tokenizer.json', bytes: 3_497 },
  { path: 'tokenizer_config.json', bytes: 113 },
];

export const VOICE_BYTES = 522_240;

export const HF_PREFIX = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}/`;

/** Where a store's files come from and the OPFS directory they are kept in. */
export interface StoreSource {
  urlPrefix: string;
  dirName: string;
}

export const KOKORO_SOURCE: StoreSource = { urlPrefix: HF_PREFIX, dirName: `kokoro-${MODEL_REVISION.slice(0, 12)}` };

/** Piper voices (rhasspy/piper-voices), pinned like the Kokoro export. */
export const PIPER_REVISION = '5041a7a49ae5b3a0f30e6837769eb03fdbb231bd';
export const PIPER_SOURCE: StoreSource = { urlPrefix: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_REVISION}/`, dirName: `piper-${PIPER_REVISION.slice(0, 12)}` };

export function voicePath(id: string): string {
  return `voices/${id}.bin`;
}

export function downloadSize(variant: Variant, voices = 1): number {
  return MODEL_FILES[variant].bytes + SUPPORT_FILES.reduce((s, f) => s + f.bytes, 0) + voices * VOICE_BYTES;
}

const fileName = (path: string) => path.replace(/\//g, '__');

type Manifest = Record<string, number>;

export interface Progress {
  loaded: number;
  total: number;
  file: string;
}

/** OPFS-backed store with an in-memory fallback when OPFS is unavailable. */
export class ModelStore {
  constructor(private readonly source: StoreSource = KOKORO_SOURCE) {}

  private dir: FileSystemDirectoryHandle | null = null;
  private manifest: Manifest = {};
  private memory = new Map<string, Uint8Array>();
  persistent = false;

  async init(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory();
      const models = await root.getDirectoryHandle('models', { create: true });
      this.dir = await models.getDirectoryHandle(this.source.dirName, { create: true });
      this.manifest = await this.readManifest();
      this.persistent = true;
    } catch {
      this.dir = null;
    }
  }

  private async readManifest(): Promise<Manifest> {
    try {
      const fh = await this.dir!.getFileHandle('manifest.json');
      return JSON.parse(await (await fh.getFile()).text()) as Manifest;
    } catch {
      return {};
    }
  }

  private async writeManifest(): Promise<void> {
    if (!this.dir) return;
    const fh = await this.dir.getFileHandle('manifest.json', { create: true });
    const h = await fh.createSyncAccessHandle();
    const data = new TextEncoder().encode(JSON.stringify(this.manifest));
    h.truncate(0);
    h.write(data, { at: 0 });
    h.flush();
    h.close();
  }

  has(path: string): boolean {
    return this.memory.has(path) || this.manifest[path] !== undefined;
  }

  /** Read a stored file (as a Blob, so large models are not copied twice). */
  async read(path: string): Promise<Blob | null> {
    const mem = this.memory.get(path);
    if (mem) return new Blob([mem as BlobPart]);
    if (!this.dir || this.manifest[path] === undefined) return null;
    try {
      const fh = await this.dir.getFileHandle(fileName(path));
      const f = await fh.getFile();
      if (f.size !== this.manifest[path]) return null;
      return f;
    } catch {
      return null;
    }
  }

  /**
   * Download files that are missing. Resumes partial downloads with HTTP range requests.
   * Progress covers all requested files together.
   */
  async ensure(files: { path: string; bytes: number }[], onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
    const missing = files.filter((f) => !this.has(f.path));
    const total = missing.reduce((s, f) => s + f.bytes, 0);
    let before = 0;
    for (const f of missing) {
      await this.download(f.path, f.bytes, (n) => onProgress?.({ loaded: before + n, total, file: f.path }), signal);
      before += f.bytes;
      onProgress?.({ loaded: before, total, file: f.path });
    }
  }

  private async download(path: string, expected: number, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
    if (!this.dir) {
      const res = await fetch(this.source.urlPrefix + path, { signal });
      if (!res.ok) throw new Error(`Download failed (${res.status}) for ${path}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      this.memory.set(path, buf);
      onBytes(buf.length);
      return;
    }
    const fh = await this.dir.getFileHandle(fileName(path), { create: true });
    const h = await fh.createSyncAccessHandle();
    try {
      let offset = h.getSize();
      if (offset > expected) {
        h.truncate(0);
        offset = 0;
      }
      const headers: HeadersInit = offset > 0 ? { Range: `bytes=${offset}-` } : {};
      let res = await fetch(this.source.urlPrefix + path, { headers, signal });
      if (offset > 0 && res.status !== 206) {
        // Server ignored the range: start over.
        h.truncate(0);
        offset = 0;
        if (!res.ok) res = await fetch(this.source.urlPrefix + path, { signal });
      }
      if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${path}`);
      onBytes(offset);
      const reader = res.body.getReader();
      let sinceFlush = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        h.write(value, { at: offset });
        offset += value.byteLength;
        sinceFlush += value.byteLength;
        if (sinceFlush > 16 * 1024 * 1024) {
          h.flush();
          sinceFlush = 0;
        }
        onBytes(offset);
      }
      h.flush();
      const size = h.getSize();
      if (size !== expected) throw new Error(`Downloaded ${path} is ${size} bytes, expected ${expected}. Try again.`);
    } finally {
      h.close();
    }
    this.manifest[path] = expected;
    await this.writeManifest();
  }

  /**
   * Delete this store's files (used by "Remove voice data"), from memory as well: without OPFS the
   * files live only there.
   */
  async clear(): Promise<void> {
    this.memory.clear();
    this.manifest = {};
    if (!this.dir) return;
    try {
      const models = await (await navigator.storage.getDirectory()).getDirectoryHandle('models');
      await models.removeEntry(this.source.dirName, { recursive: true });
    } catch {
      // Already gone.
    }
    await this.init();
  }

  /** Remove every stored model directory, including those of earlier revisions. */
  static async removeAll(): Promise<void> {
    try {
      await (await navigator.storage.getDirectory()).removeEntry('models', { recursive: true });
    } catch {
      // No OPFS, or nothing stored.
    }
  }

  storedBytes(): number {
    return Object.values(this.manifest).reduce((a, b) => a + b, 0) + [...this.memory.values()].reduce((a, b) => a + b.length, 0);
  }
}

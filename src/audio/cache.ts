// Bounded in-memory cache of generated chunk audio (least recently used goes first).

export interface ChunkAudio {
  audio: Float32Array;
  starts: number[];
  ends: number[];
}

export class AudioCache {
  private map = new Map<string, ChunkAudio>();
  private samples = 0;

  constructor(readonly maxSamples: number) {}

  static key(voice: string, text: string, endsWith: string): string {
    return `${voice}\u0001${endsWith}\u0001${text}`;
  }

  get(key: string): ChunkAudio | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: ChunkAudio): void {
    const old = this.map.get(key);
    if (old) {
      this.samples -= old.audio.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.samples += value.audio.length;
    for (const [k, v] of this.map) {
      if (this.samples <= this.maxSamples || this.map.size <= 1) break;
      this.map.delete(k);
      this.samples -= v.audio.length;
    }
  }

  get size(): number {
    return this.map.size;
  }

  get totalSamples(): number {
    return this.samples;
  }

  clear(): void {
    this.map.clear();
    this.samples = 0;
  }
}

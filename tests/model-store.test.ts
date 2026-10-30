import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelStore, PIPER_SOURCE } from '../src/engine/model-store';
import { runBench } from '../src/engine/probe';

describe('ModelStore without OPFS', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps downloads in memory and clears them', async () => {
    // Node has no navigator.storage, like a browser that refuses OPFS: files stay in memory.
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(1000)));
    const store = new ModelStore(PIPER_SOURCE);
    await store.init();
    expect(store.persistent).toBe(false);
    const files = [{ path: 'voice.onnx', bytes: 1000 }, { path: 'voice.onnx.json', bytes: 1000 }];
    const progress: number[] = [];
    await store.ensure(files, (p) => progress.push(p.loaded));
    expect(store.has('voice.onnx')).toBe(true);
    expect(store.storedBytes()).toBe(2000);
    expect(progress.at(-1)).toBe(2000);
    expect((await store.read('voice.onnx'))?.size).toBe(1000);
    await store.clear();
    expect(store.has('voice.onnx')).toBe(false);
    expect(store.storedBytes()).toBe(0);
    expect(await store.read('voice.onnx')).toBeNull();
  });
});

describe('runBench', () => {
  it('measures a positive score within the time budget', () => {
    const r = runBench();
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThan(0);
    expect(r!.ms).toBeLessThan(300);
  });
});

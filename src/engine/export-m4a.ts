// AAC in an MP4 container (.m4a) with WebCodecs and mp4-muxer (MIT). Runs in the worker.

import { ArrayBufferTarget, Muxer } from 'mp4-muxer';

export interface M4aEncoder {
  add(samples: Float32Array): void;
  finish(): Promise<ArrayBuffer>;
  abort(): void;
}

const BITRATE = 96_000;

async function supported(sampleRate: number): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const r = await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 1, bitrate: BITRATE });
    return !!r.supported;
  } catch {
    return false;
  }
}

/** 2x upsampling with a windowed-sinc low-pass (for encoders that only take 48 kHz). */
export function upsample2x(input: Float32Array, carry: { tail: Float32Array }): Float32Array {
  const taps = 32; // half-length of the interpolation filter
  const src = new Float32Array(carry.tail.length + input.length);
  src.set(carry.tail);
  src.set(input, carry.tail.length);
  const usable = src.length - taps;
  const out = new Float32Array(Math.max(0, usable - taps) * 2);
  const h: number[] = [];
  for (let k = -taps + 1; k <= taps; k++) {
    const x = k - 0.5;
    const w = 0.5 * (1 + Math.cos((Math.PI * x) / taps));
    h.push((Math.sin(Math.PI * x) / (Math.PI * x)) * w);
  }
  let o = 0;
  for (let n = taps; n < usable; n++) {
    out[o++] = src[n];
    let acc = 0;
    for (let k = -taps + 1, i = 0; k <= taps; k++, i++) acc += src[n + k] * h[i];
    out[o++] = acc;
  }
  carry.tail = src.slice(usable - taps);
  return out.subarray(0, o);
}

export async function encodeM4a(inputRate: number): Promise<M4aEncoder> {
  let rate = inputRate;
  let up = false;
  if (!(await supported(rate))) {
    if (await supported(inputRate * 2)) {
      rate = inputRate * 2;
      up = true;
    } else throw new Error('AAC encoding is not available in this browser');
  }
  const muxer = new Muxer({ target: new ArrayBufferTarget(), audio: { codec: 'aac', sampleRate: rate, numberOfChannels: 1 }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  let error: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => (error = e),
  });
  encoder.configure({ codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: 1, bitrate: BITRATE });
  let written = 0;
  const carry = { tail: new Float32Array(32) };
  const push = (samples: Float32Array) => {
    if (error) throw error;
    const frame = 4096;
    for (let i = 0; i < samples.length; i += frame) {
      const part = samples.slice(i, Math.min(samples.length, i + frame));
      const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((written / rate) * 1e6), data: part });
      encoder.encode(data);
      data.close();
      written += part.length;
    }
  };
  return {
    add(samples) {
      push(up ? upsample2x(samples, carry) : samples);
    },
    async finish() {
      if (up) push(upsample2x(new Float32Array(64), carry));
      await encoder.flush();
      if (error) throw error;
      encoder.close();
      muxer.finalize();
      return muxer.target.buffer;
    },
    abort() {
      try {
        encoder.close();
      } catch {
        // already closed
      }
    },
  };
}

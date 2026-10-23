// Measurement helpers used to verify playback (available as window.narrata.debug in development
// or with ?debug in the URL). They record the real audio output and compare it with the timeline.

import { speechBounds } from './core/audio';
import type { Placed, Segment } from './core/timeline';
import type { App } from './ui/app';

interface Recording {
  samples: Float32Array;
  sampleRate: number;
  /** AudioContext time of the first recorded sample. */
  t0: number;
}

function outputAtInput(segments: Segment[], input: number): number | null {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s.active || s.rate <= 0) continue;
    const next = segments[i + 1];
    const end = next ? s.input + (next.output - s.output) * s.rate : Infinity;
    if (input >= s.input - 1e-9 && input <= end + 1e-9) return s.output + (input - s.input) / s.rate;
  }
  return null;
}

function envelope(a: Float32Array, sr: number, frameMs = 5) {
  const f = Math.max(1, Math.round((sr * frameMs) / 1000));
  const env = new Float32Array(Math.ceil(a.length / f));
  for (let i = 0; i < env.length; i++) {
    let m = 0;
    for (let k = i * f; k < Math.min(a.length, (i + 1) * f); k++) m = Math.max(m, Math.abs(a[k]));
    env[i] = m;
  }
  return { env, frameSec: f / sr };
}

export function installDebug(app: App): void {
  const player = app.player;
  const placedAudio: { p: Placed; audio: Float32Array }[] = [];
  player.onPlaced = (p, audio) => placedAudio.push({ p, audio });
  let rec: { node: ScriptProcessorNode; parts: Float32Array[]; t0: number } | null = null;

  const debug = {
    placedAudio,
    startCapture() {
      const ctx = player.ctx!;
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const parts: Float32Array[] = [];
      const state = { node, parts, t0: -1 };
      node.onaudioprocess = (e) => {
        if (state.t0 < 0) state.t0 = e.playbackTime;
        parts.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      player.outputNode!.connect(node);
      node.connect(ctx.destination);
      rec = state;
    },
    stopCapture(): Recording {
      if (!rec) throw new Error('not capturing');
      rec.node.disconnect();
      player.outputNode!.disconnect(rec.node);
      const n = rec.parts.reduce((s, p) => s + p.length, 0);
      const out = new Float32Array(n);
      let k = 0;
      for (const p of rec.parts) {
        out.set(p, k);
        k += p.length;
      }
      const r = { samples: out, sampleRate: player.ctx!.sampleRate, t0: rec.t0 };
      rec = null;
      return r;
    },
    /** Play the open document from the start at `rate`, record it, and analyse joints and word onsets. */
    async measure(rate = 1, maxSeconds = 120) {
      const doc = app.current;
      if (!doc) throw new Error('open a document first');
      placedAudio.length = 0;
      player.wordLog = [];
      app.player.setRate(rate);
      await player.ensureAudio();
      debug.startCapture();
      const tClick = performance.now();
      await player.playFrom(0);
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (player.state === 'ended' || performance.now() - tClick > maxSeconds * 1000) {
            clearInterval(t);
            resolve();
          }
        }, 100);
      });
      await new Promise((r) => setTimeout(r, 400));
      const recd = debug.stopCapture();
      const snap = player.debugSnapshot();
      const segs = snap.segments as Segment[];
      const { env, frameSec } = envelope(recd.samples, recd.sampleRate);
      let peak = 0;
      for (const x of env) peak = Math.max(peak, x);
      const thr = peak * 0.02;
      const silentRunAt = (t: number) => {
        let i = Math.round((t - recd.t0) / frameSec);
        if (i < 0 || i >= env.length) return null;
        // Search nearby for the silent run that contains the joint.
        let best = -1;
        for (let d = 0; d < 40 && best < 0; d++) for (const j of [i - d, i + d]) if (j >= 0 && j < env.length && env[j] < thr) { best = j; break; }
        if (best < 0) return 0;
        let a = best;
        let b = best;
        while (a > 0 && env[a - 1] < thr) a--;
        while (b < env.length - 1 && env[b + 1] < thr) b++;
        return (b - a + 1) * frameSec * 1000;
      };
      const joints = [];
      for (let i = 1; i < placedAudio.length; i++) {
        const prev = placedAudio[i - 1];
        const cur = placedAudio[i];
        const contiguity = Math.round((cur.p.inputStart - (prev.p.inputStart + prev.p.duration)) * recd.sampleRate);
        const t = outputAtInput(segs, cur.p.inputStart);
        const [, lastPrev] = speechBounds(prev.audio, recd.sampleRate);
        const [firstCur] = speechBounds(cur.audio, recd.sampleRate);
        const inherentMs = (((prev.audio.length - lastPrev) + firstCur) / recd.sampleRate / rate) * 1000;
        joints.push({ joint: i, bufferGapSamples: contiguity, measuredSilenceMs: t === null ? null : Math.round(silentRunAt(t) ?? -1), sourceSilenceMs: Math.round(inherentMs) });
      }
      // Longest silences anywhere in the output (to catch underruns).
      const runs: number[] = [];
      let run = 0;
      const tStart = outputAtInput(segs, 0) ?? recd.t0;
      const startIdx = Math.max(0, Math.round((tStart - recd.t0) / frameSec) + 10);
      const tEnd = outputAtInput(segs, snap.bufferedEnd - 0.05) ?? recd.t0 + env.length * frameSec;
      const endIdx = Math.min(env.length, Math.round((tEnd - recd.t0) / frameSec));
      for (let i = startIdx; i < endIdx; i++) {
        if (env[i] < thr) run++;
        else {
          if (run) runs.push(run * frameSec * 1000);
          run = 0;
        }
      }
      runs.sort((a, b) => b - a);
      // Highlight check: word starts that follow punctuation begin right after a pause, so the
      // speech onset in the recording is a ground truth for when that word starts.
      const words = doc.pdoc.words;
      const text = doc.loaded.doc.text;
      const onsetErrors: { word: string; errorMs: number }[] = [];
      for (const { p } of placedAudio) {
        p.starts.forEach((s, k) => {
          const w = words[p.firstWord + k];
          const before = text.slice(Math.max(0, w.start - 2), w.start);
          if (k > 0 && !/[,.;:!?]\s$/.test(before)) return;
          const t = outputAtInput(segs, p.inputStart + s);
          if (t === null) return;
          // Nearest onset: first loud frame after a silent stretch, within 300 ms.
          const i0 = Math.round((t - recd.t0) / frameSec);
          let best = Infinity;
          for (let j = Math.max(3, i0 - 60); j < Math.min(env.length, i0 + 60); j++) {
            if (env[j] >= thr && env[j - 1] < thr && env[j - 2] < thr && env[j - 3] < thr) {
              const err = (j - i0) * frameSec * 1000;
              if (Math.abs(err) < Math.abs(best)) best = err;
            }
          }
          if (isFinite(best)) onsetErrors.push({ word: text.slice(w.start, w.end), errorMs: Math.round(best) });
        });
      }
      const abs = onsetErrors.map((e) => Math.abs(e.errorMs)).sort((a, b) => a - b);
      // Word log: emitted highlight vs the timing model (rAF granularity).
      const log = player.wordLog ?? [];
      const lagMs: number[] = [];
      for (const e of log) {
        const pl = placedAudio.find(({ p }) => e.word >= p.firstWord && e.word < p.firstWord + p.starts.length);
        if (!pl) continue;
        const startInput = pl.p.inputStart + pl.p.starts[e.word - pl.p.firstWord];
        lagMs.push(((e.input - startInput) / rate) * 1000);
      }
      player.wordLog = null;
      lagMs.sort((a, b) => a - b);
      return {
        rate,
        ttfaMs: player.stats.ttfaMs,
        underruns: player.stats.underruns,
        chunks: placedAudio.length,
        audioSeconds: +snap.bufferedEnd.toFixed(2),
        wallSeconds: +((performance.now() - tClick) / 1000).toFixed(2),
        joints,
        maxBufferGapSamples: Math.max(0, ...joints.map((j) => Math.abs(j.bufferGapSamples))),
        longestSilencesMs: runs.slice(0, 5).map(Math.round),
        onsetCheck: { n: abs.length, medianMs: abs[Math.floor(abs.length / 2)] ?? null, maxMs: abs[abs.length - 1] ?? null, samples: onsetErrors.slice(0, 12) },
        highlightLagMs: { n: lagMs.length, median: Math.round(lagMs[Math.floor(lagMs.length / 2)] ?? 0), max: Math.round(lagMs[lagMs.length - 1] ?? 0) },
      };
    },
    /** Export the open document and decode it back to check the duration. */
    async exportCheck(format: 'm4a' | 'wav' = 'm4a') {
      const t0 = performance.now();
      const job = app.exportDocument(() => {}, format);
      const r = await job.promise;
      const ctx = new OfflineAudioContext(1, 1, 48000);
      const decoded = await ctx.decodeAudioData(r.data.slice(0));
      return { ext: r.ext, mime: r.mime, bytes: r.data.byteLength, encodedSeconds: +r.seconds.toFixed(2), decodedSeconds: +decoded.duration.toFixed(2), decodedRate: decoded.sampleRate, ms: Math.round(performance.now() - t0) };
    },
  };
  (window as unknown as { narrata: Record<string, unknown> }).narrata.debug = debug;
}

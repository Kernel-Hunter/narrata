// Measures the voice on the processor (WebAssembly) path under emulated slower computers.
//
//   node scripts/bench/cpu-bench.mjs [--levels 1,2,4,6] [--threads 4] [--configs "variant=q8;variant=fp32"] [--runs 1] [--out file.json]
//
// Each config is a set of the app's debug URL parameters (see tuningFromUrl in src/ui/app.ts).
//
// For each configuration it opens the app in Playwright's Chromium (headless, WebGPU unused),
// slows the page's renderer process down, loads the model, generates the sample text (three
// paragraphs, about a minute of speech) and records when each chunk was ready. Playback at 1x and
// 1.5x is then simulated from that timeline with the player's start policy (src/core/buffering.ts).
//
// Slowing down: Chrome's CPU throttling (CDP Emulation.setCPUThrottlingRate) does not apply to
// workers, where the model runs. Instead the renderer is moved to the efficiency cores with macOS
// background priority (about 3.4x slower than a performance core on an M5) and, for further
// slowdown, stopped and continued in a duty cycle (throttle.mjs). The effective slowdown is
// measured and reported next to each level. macOS only.
//
// It measures a production build (in .bench-dist/), so source files can change while it runs.
// The first run downloads the models into .bench-profile/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build, preview } from 'vite';
import { simulate } from '../../src/core/buffering.ts';
import { launchBrowser } from './browser.mjs';
import { throttle } from './throttle.mjs';

const root = join(import.meta.dirname, '..', '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const levels = arg('levels', '1,2,4,6').split(',');
const maxChunks = Number(arg('chunks', '1000'));
const threadsList = arg('threads', '4').split(',').map(Number);
const configs = arg('configs', 'variant=q8').split(';');
const runs = Number(arg('runs', '1'));
const outFile = arg('out', null);
const PORT = 5340;

/** How each level is emulated: background priority (efficiency cores) and a duty cycle. */
const EMULATION = {
  1: { background: false, duty: 1 },
  2: { background: false, duty: 2 },
  4: { background: true, duty: 1.2 },
  6: { background: true, duty: 2.2 },
};

// A production build (no hot reload while files change), served with the isolation headers.
const outDir = join(root, '.bench-dist');
await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir, emptyOutDir: true } });
const server = await preview({
  root,
  configFile: join(root, 'vite.config.ts'),
  logLevel: 'warn',
  build: { outDir },
  preview: { port: PORT, strictPort: true, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
const { context, pid } = await launchBrowser(join(root, '.bench-profile'), { headless: true });


function renderers() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  const rows = out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const kids = new Map();
  for (const [, p, pp] of rows) kids.set(Number(pp), [...(kids.get(Number(pp)) ?? []), Number(p)]);
  const cmd = new Map(rows.map(([, p, , c]) => [Number(p), c]));
  const found = [];
  const walk = (p) => (kids.get(p) ?? []).forEach((k) => (cmd.get(k).includes('--type=renderer') && found.push(k), walk(k)));
  walk(pid);
  return found;
}

/** The voice of a config (voice=piper_kristin), af_heart by default. */
const voiceOf = (config) => new URLSearchParams(config).get('voice') ?? 'af_heart';

async function openApp(threads, config) {
  const page = await context.newPage();
  // The processor model (so the app never starts the WebGPU path on its own) and the voice.
  await page.addInitScript((voice) => localStorage.setItem('narrata.settings', JSON.stringify({ model: 'compact', voice })), voiceOf(config));
  page.on('console', (m) => (process.env.BENCH_VERBOSE || m.type() === 'error' || m.text().startsWith('Narrata engine')) && console.error('  [page]', m.text()));
  await page.goto(`http://localhost:${PORT}/?debug&threads=${threads}&${config}#sample`);
  await page.waitForFunction(() => window.narrata?.debug && window.narrata.app.current, null, { timeout: 60000 });
  // Vite may reload the page once after optimizing new dependencies.
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => window.narrata?.debug && window.narrata.app.current, null, { timeout: 60000 });
  return page;
}

// Make sure the model files are stored before measuring (unthrottled).
const prepare = (page, config) =>
  page.evaluate((voice) => {
    window.narrata.player.voice = voice;
    return window.narrata.tts.prepare('compact', voice);
  }, voiceOf(config));

for (const config of configs) {
  const page = await openApp(4, config);
  const t0 = Date.now();
  await prepare(page, config);
  console.log(`${config}: ready in ${Date.now() - t0} ms`);
  await page.close();
}

const results = [];
for (const config of configs) {
  for (const threads of threadsList) {
    for (const level of levels) {
      for (let run = 0; run < runs; run++) {
        const page = await openApp(threads, config);
        // A level is 1, 2, 4 or 6, or a raw emulation: "bg1.3" (background + duty) or "p2".
        const raw = /^(bg|p)([\d.]+)$/.exec(level);
        const emu = raw ? { background: raw[1] === 'bg', duty: Number(raw[2]) } : EMULATION[level];
        const procs = renderers();
        if (emu.background) for (const p of procs) execFileSync('taskpolicy', ['-b', '-p', String(p)]);
        const th = throttle(pid, emu.duty);
        const t0 = Date.now();
        await prepare(page, config);
        const loadMs = Date.now() - t0;
        const tl = await page.evaluate((n) => window.narrata.debug.genTimeline(n), maxChunks);
        await th.stop();
        for (const p of procs) {
          try {
            execFileSync('taskpolicy', ['-B', '-p', String(p)]);
          } catch {}
        }
        await page.close();
        if (tl.device !== 'wasm') throw new Error(`ran on ${tl.device}`);
        const row = { config, variant: tl.variant, threads: tl.threads, level, loadMs, modelLoadMs: tl.modelLoadMs, testRtf: tl.testRtf, testMs: tl.testMs, rtf: tl.rtf, audioSec: tl.audioSec, chunks: tl.chunks };
        for (const rate of [1, 1.5]) {
          row[`base_${rate}`] = simulate(tl.chunks, rate, { kind: 'immediate' });
          row[`policy_${rate}`] = simulate(tl.chunks, rate, { kind: 'buffered' }, tl.testRtf);
        }
        results.push(row);
        const f = (s) => `${s.ttfa.toFixed(1)}s/${s.stalls}x${s.stallSec.toFixed(1)}s`;
        console.log(`${config} ${tl.threads}t ${level}x: load ${(loadMs / 1000).toFixed(1)}s (model ${(tl.modelLoadMs / 1000).toFixed(1)}s) test RTF ${tl.testRtf} RTF ${tl.rtf} | now 1x ${f(row.base_1)} 1.5x ${f(row['base_1.5'])} | buffered 1x ${f(row.policy_1)} 1.5x ${f(row['policy_1.5'])}`);
      }
    }
  }
}

if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(results, null, 1));
}
await context.close();
await server.close();
process.exit(0);

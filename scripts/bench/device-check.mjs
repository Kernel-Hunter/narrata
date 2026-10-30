// Calibrates the first-run device check (src/engine/probe.ts, recommendVoice in src/core/device.ts).
//
//   node scripts/bench/device-check.mjs [--levels 1,2,4,6] [--chunks 10] [--out file.json]
//
// For each emulated computer (the levels of cpu-bench.mjs: background priority and a duty cycle,
// macOS only) it runs the WebAssembly benchmark in the TTS worker three times, then measures the
// natural voice on the processor (uint8, 4 threads) on the first chunks of the sample text. It
// prints the benchmark score, the measured speed and the speed recommendVoice estimates from the
// score, so REF_SCORE and REF_RTF can be checked or updated.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { build, preview } from 'vite';
import { launchBrowser } from './browser.mjs';
import { throttle } from './throttle.mjs';

const root = join(import.meta.dirname, '..', '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const levels = arg('levels', '1,2,4,6').split(',');
const maxChunks = Number(arg('chunks', '10'));
const outFile = arg('out', null);
const PORT = 5340;
const EMULATION = {
  1: { background: false, duty: 1 },
  2: { background: false, duty: 2 },
  4: { background: true, duty: 1.2 },
  6: { background: true, duty: 2.2 },
};

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

async function openApp() {
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('narrata.settings', JSON.stringify({ model: 'compact', voice: 'af_heart' })));
  await page.goto(`http://localhost:${PORT}/?debug&threads=4&variant=uint8#sample`);
  await page.waitForFunction(() => window.narrata?.debug && window.narrata.app.current, null, { timeout: 60000 });
  return page;
}

const results = [];
for (const level of levels) {
  const page = await openApp();
  const emu = EMULATION[level];
  const procs = renderers();
  if (emu.background) for (const p of procs) execFileSync('taskpolicy', ['-b', '-p', String(p)]);
  const th = throttle(pid, emu.duty);
  const probes = [];
  for (let i = 0; i < 3; i++) probes.push(await page.evaluate(() => window.narrata.debug.deviceCheck()));
  await page.evaluate(() => window.narrata.tts.prepare('compact', 'af_heart'));
  const tl = await page.evaluate((n) => window.narrata.debug.genTimeline(n), maxChunks);
  await th.stop();
  for (const p of procs) {
    try {
      execFileSync('taskpolicy', ['-B', '-p', String(p)]);
    } catch {}
  }
  await page.close();
  // The middle of three runs, with the estimate the page computed for it (4 threads).
  const mid = [...probes].sort((a, b) => a.benchScore - b.benchScore)[1];
  const scores = probes.map((p) => p.benchScore);
  const row = { level, scores, benchMs: probes.map((p) => p.benchMs), rtf: tl.rtf, threads: tl.threads, estimate: mid.estimate4, pick: mid.advice.pick };
  results.push(row);
  console.log(`${level}: score ${scores.join('/')} (${row.benchMs.join('/')} ms) | measured RTF ${tl.rtf} (${tl.threads} threads) | estimated ${row.estimate} | pick on this device: ${row.pick}`);
}

if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(results, null, 1));
}
await context.close();
await server.close();
process.exit(0);

// Does generation keep its speed when the tab is in the background?
//
//   node scripts/bench/background-check.mjs [--variant uint8] [--chunks 8]
//
// Opens the app in a visible Chromium window (with Chrome's normal background throttling, which
// Playwright turns off by default), generates part of the sample text with the tab in front,
// then again with another tab in front, and prints the speed of each. With --play it also starts
// playback in the background tab (the player keeps the process at foreground priority while it
// waits for audio).
import { join } from 'node:path';
import { build, preview } from 'vite';
import { launchBrowser } from './browser.mjs';

const root = join(import.meta.dirname, '..', '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const variant = arg('variant', 'uint8');
const chunks = Number(arg('chunks', '8'));
const PORT = 5341;

const outDir = join(root, '.bench-dist');
if (!process.argv.includes('--no-build')) await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir, emptyOutDir: true } });
const server = await preview({
  root,
  configFile: join(root, 'vite.config.ts'),
  logLevel: 'warn',
  build: { outDir },
  preview: { port: PORT, strictPort: true, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
const { context } = await launchBrowser(join(root, '.bench-profile'), {
  headless: false,
  // Keep Chrome's real behaviour for hidden tabs.
  ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
});
await context.addInitScript(() => localStorage.setItem('narrata.settings', JSON.stringify({ model: 'compact' })));
const page = await context.newPage();
await page.goto(`http://localhost:${PORT}/?debug&variant=${variant}#sample`);
await page.waitForFunction(() => window.narrata?.debug && window.narrata.app.current, null, { timeout: 60000 });
await page.evaluate(() => window.narrata.tts.prepare('compact', 'af_heart'));

const measure = async (label) => {
  const r = await page.evaluate((n) => window.narrata.debug.genTimeline(n), chunks);
  const visibility = await page.evaluate(() => document.visibilityState);
  console.log(`${label} (${visibility}): RTF ${r.rtf}, ${r.audioSec} s of audio`);
  return r.rtf;
};

await page.bringToFront();
const front = await measure('tab in front');
const other = await context.newPage();
await other.goto('about:blank');
await other.bringToFront();
await page.waitForTimeout(1500);
const back = await measure('tab in background');
const backRepeat = await measure('tab in background, second run');
const kept = {};
for (const level of process.argv.includes('--keepalive') ? [0, 0.001] : []) {
  // What the player does while it waits for audio in a hidden tab (level 0: a silent stream).
  await page.evaluate(async (l) => {
    const p = window.narrata.player;
    await p.ensureAudio();
    p.keepAliveLevel = l;
    p.setKeepAlive(true);
  }, level);
  await page.waitForTimeout(2500);
  kept[level] = await measure(`tab in background, keep-alive level ${level}`);
  await page.evaluate(() => window.narrata.player.setKeepAlive(false));
  await page.waitForTimeout(3000);
}
const back2 = await measure('tab in background again');
console.log(JSON.stringify({ variant, front, back, backRepeat, back2, kept }));
await context.close();
await server.close();
process.exit(0);

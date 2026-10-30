// Records the demo GIF for the README (docs/demo.gif): the sample PDF read aloud with the word
// highlight, in a production build, using the models already stored in .bench-profile/.
//
//   node scripts/bench/record-demo.mjs [--seconds 14] [--width 960] [--height 600] [--out docs/demo.gif]
//
// Frames come from Chrome's screencast (CDP), at their real timestamps; ffmpeg turns them into a
// GIF with a palette made for this clip. Needs ffmpeg on the PATH.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview } from 'vite';
import { launchBrowser } from './browser.mjs';

const root = join(import.meta.dirname, '..', '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const seconds = Number(arg('seconds', '14'));
const width = Number(arg('width', '960'));
const height = Number(arg('height', '620'));
const fps = Number(arg('fps', '12'));
const out = join(root, arg('out', 'docs/demo.gif'));
const file = join(root, arg('file', 'tests/fixtures/harbor.pdf'));
const voice = arg('voice', 'af_heart');
const PORT = 5340;

const outDir = join(root, '.bench-dist');
await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir, emptyOutDir: true } });
const server = await preview({
  root,
  configFile: join(root, 'vite.config.ts'),
  logLevel: 'warn',
  build: { outDir },
  preview: { port: PORT, strictPort: true, headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
const { context } = await launchBrowser(join(root, '.bench-profile'), { headless: true });
const page = await context.newPage();
await page.setViewportSize({ width, height });
await page.addInitScript((v) => {
  localStorage.setItem('narrata.settings', JSON.stringify({ model: 'compact', voice: v, theme: 'light', fontSize: 20 }));
  localStorage.removeItem('narrata.lastDoc');
}, voice);
await page.goto(`http://localhost:${PORT}/`);
await page.waitForFunction(() => window.narrata?.tts);
await page.evaluate((v) => window.narrata.tts.prepare('compact', v), voice);
await page.setInputFiles('input[type=file]', file);
await page.waitForFunction(() => window.narrata.app.current);
await page.waitForTimeout(1500);

const frames = mkdtempSync(join(tmpdir(), 'narrata-demo-'));
const cdp = await context.newCDPSession(page);
const shots = [];
cdp.on('Page.screencastFrame', async (f) => {
  shots.push({ t: f.metadata.timestamp, data: f.data });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
// Start from the first word, as a click on the play button would, and record once audio plays,
// with a moment before the first word so the clip starts on a still page.
await page.click('button[aria-label="Play"]');
await page.waitForFunction(() => window.narrata.player.state === 'playing' && window.narrata.player.currentWord() >= 0);
await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
await page.waitForTimeout(seconds * 1000);
await cdp.send('Page.stopScreencast');
await context.close();
await server.close();

// Resample to a constant frame rate from the frames' own timestamps.
const t0 = shots[0].t;
let k = 0;
for (let i = 0; i < Math.round((shots.at(-1).t - t0) * fps); i++) {
  const t = t0 + i / fps;
  while (k + 1 < shots.length && shots[k + 1].t <= t) k++;
  writeFileSync(join(frames, `f${String(i).padStart(4, '0')}.png`), Buffer.from(shots[k].data, 'base64'));
}
mkdirSync(join(out, '..'), { recursive: true });
const palette = join(frames, 'palette.png');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-i', join(frames, 'f%04d.png'), '-vf', `scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=128`, palette]);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(fps), '-i', join(frames, 'f%04d.png'), '-i', palette, '-lavfi', `scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', out]);
rmSync(frames, { recursive: true, force: true });
console.log(`${out}: ${(statSync(out).size / 1e6).toFixed(2)} MB, ${shots.length} screencast frames, ${seconds} s at ${fps} fps`);
process.exit(0);

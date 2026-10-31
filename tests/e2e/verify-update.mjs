// End-to-end check of the update notice in the web app, the way GitHub Pages serves it.
//
//   node tests/e2e/verify-update.mjs [--headed] [--profile DIR] [--port 5350] [--shots DIR]
//
// Builds version A into a folder served under /narrata/ without isolation headers (like Pages,
// with its max-age=600), opens it and waits for the service worker to isolate the page. Opens the
// sample, starts reading, then builds version B into the same folder while it plays. Checks that
// the notice appears, that nothing reloads while audio plays, and that Reload brings version B,
// still isolated, on the same document and position, with the stored voice untouched.
//
// The voice is downloaded into the profile the first time (about 180 MB); later runs reuse it.
// Writes update-notice.png and update-notice-close.png to docs/screenshots/ (or --shots).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'vite';
import { root, sleep, waitFor } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const headless = !args.includes('--headed');
const profile = arg('--profile', join(root, '.e2e-profile-update'));
const port = Number(arg('--port', '5350'));
const served = join(root, '.e2e-update-site');
const shots = arg('--shots', join(root, 'docs', 'screenshots'));
mkdirSync(shots, { recursive: true });

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
}

/** Builds the app into the served folder. Version B also marks itself so the test can tell. */
async function buildVersion(label) {
  const plugins =
    label === 'B'
      ? [{ name: 'mark-b', transform: (code, id) => (id.endsWith('/src/main.ts') ? `${code}\n;window.narrataTestBuild = 'B';\n` : null) }]
      : [];
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'warn', plugins, build: { outDir: served, emptyOutDir: true } });
  return JSON.parse(readFileSync(join(served, 'version.json'), 'utf8')).build;
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

/** Static files under /narrata/ with GitHub Pages' caching and no COOP/COEP headers. */
function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/narrata/')) return res.writeHead(404).end();
    let rel = decodeURIComponent(url.pathname.slice('/narrata/'.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = normalize(join(served, rel));
    if (!file.startsWith(served) || !existsSync(file) || statSync(file).isDirectory()) return res.writeHead(404).end('not found');
    const data = readFileSync(file);
    const etag = `"${createHash('sha1').update(data).digest('hex').slice(0, 16)}"`;
    const headers = { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'max-age=600', etag };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    res.writeHead(200, headers).end(data);
  });
  server.listen(port, 'localhost');
  return server;
}

const buildA = await buildVersion('A');
const server = serve();
const base = `http://localhost:${port}/narrata/`;

// A worker kept from an earlier run would serve its own cached build.
rmSync(join(profile, 'Default', 'Service Worker'), { recursive: true, force: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless,
  viewport: { width: 1100, height: 760 },
  deviceScaleFactor: 2,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = context.pages()[0] ?? (await context.newPage());
page.on('pageerror', (e) => console.log('page error:', e.message));
let navigations = 0;
page.on('framenavigated', (f) => f === page.mainFrame() && navigations++);

const ready = () => page.waitForFunction(() => self.crossOriginIsolated && window.narrata?.app, null, { timeout: 90_000 });
const pageBuild = () => page.evaluate(() => document.querySelector('meta[name="narrata-build"]')?.content ?? null);
const notice = page.locator('.update-notice');
/** Model files in the Origin Private File System, with their sizes. */
const storedModels = () =>
  page.evaluate(async () => {
    const out = {};
    try {
      const models = await (await navigator.storage.getDirectory()).getDirectoryHandle('models');
      for await (const [name, dir] of models.entries()) {
        if (dir.kind !== 'directory') continue;
        for await (const [file, h] of dir.entries()) if (h.kind === 'file') out[`${name}/${file}`] = (await h.getFile()).size;
      }
    } catch {}
    return out;
  });

// 1. Version A, first visit: the worker installs, the page reloads once and is isolated.
await page.goto(base);
await ready();
check('version A loads and is cross-origin isolated after the first visit', (await pageBuild()) === buildA, { build: buildA, navigations });
check('no update notice on the current version', (await notice.count()) === 0);

// 2. Open the sample (no #sample in the address, so a reload must reopen it from the library).
await page.evaluate(async () => {
  localStorage.setItem('narrata.settings', JSON.stringify({ ...JSON.parse(localStorage.getItem('narrata.settings') || '{}'), model: 'compact' }));
});
await page.evaluate(() => window.narrata.app.openSample());
await page.waitForFunction(() => document.title.startsWith('The Lighthouse Keeper'));
console.log('preparing the voice (downloads it the first time)…');
await page.evaluate(() => window.narrata.tts.prepare('compact', window.narrata.app.settings.voice));
await waitFor(() => page.evaluate(() => window.narrata.tts.info.state === 'ready'), { timeout: 600_000, label: 'voice ready' });
const modelsBefore = await storedModels();
check('the voice is stored in the Origin Private File System', Object.keys(modelsBefore).some((f) => f.endsWith('.onnx')), modelsBefore);

await page.locator('.play-btn').click();
await waitFor(() => page.evaluate(() => window.narrata.player.state === 'playing'), { timeout: 120_000, label: 'playback' });
await sleep(1500);
const wordBefore = await page.evaluate(() => window.narrata.player.currentWord());
await page.evaluate(() => (window.notReloaded = true));
const navBefore = navigations;

// 3. Deploy version B while it reads, and let the page check (as when the tab is shown again).
const buildB = await buildVersion('B');
check('version B has another build id', buildB !== buildA, { buildA, buildB });
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await notice.waitFor({ timeout: 30_000 });
check('the notice appears', (await notice.textContent()).includes('Narrata was updated. Reload to get the new version.'));
await sleep(6000);
const during = await page.evaluate(() => ({ state: window.narrata.player.state, word: window.narrata.player.currentWord(), marker: window.notReloaded === true }));
check('no reload while audio plays', during.marker && navigations === navBefore && during.state === 'playing' && during.word > wordBefore, { ...during, wordBefore, navigations: navigations - navBefore });
await page.screenshot({ path: join(shots, 'update-notice.png') });
await notice.screenshot({ path: join(shots, 'update-notice-close.png') });

// 4. Reload: playback pauses, the position is saved, and version B opens.
await notice.getByRole('button', { name: 'Reload' }).click();
await page.waitForFunction(() => !window.notReloaded, null, { timeout: 30_000 }).catch(() => {});
await ready();
await page.waitForFunction(() => document.title.startsWith('The Lighthouse Keeper'), null, { timeout: 30_000 });
const after = await page.evaluate(async () => {
  const meta = (await window.narrata.library.list())[0];
  return { testBuild: window.narrataTestBuild ?? null, isolated: self.crossOriginIsolated, saved: meta?.position ?? null, at: window.narrata.player.currentOffset(), title: document.title };
});
const wordAt = await page.evaluate(() => window.narrata.player.currentWord());
check('Reload gives version B', (await pageBuild()) === buildB && after.testBuild === 'B', { build: await pageBuild(), testBuild: after.testBuild });
check('still cross-origin isolated', after.isolated === true);
check('the same document is open', after.title.startsWith('The Lighthouse Keeper'), after.title);
check('the reading position is kept', after.saved > 0 && after.at === after.saved && wordAt >= during.word, { saved: after.saved, at: after.at, wordAt, wordAtNotice: during.word });
check('no notice after updating', (await notice.count()) === 0);
const modelsAfter = await storedModels();
check('the stored voice is untouched', JSON.stringify(modelsAfter) === JSON.stringify(modelsBefore), { files: Object.keys(modelsAfter).length });
const caches = await page.evaluate(() => caches.keys());
check('the app cache moved to version B', caches.includes(`narrata-${buildB}`), caches);

await context.close();
server.close();
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);

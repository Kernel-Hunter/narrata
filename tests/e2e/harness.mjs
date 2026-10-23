// Shared helpers for driving the unpacked extension in Playwright's Chromium.
import { createServer } from 'node:http';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// The test build (pnpm build:ext:test) keeps the hooks these checks use.
export const extPath = join(root, 'dist-ext-test');
const pagesDir = join(root, 'tests', 'pages');

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

/** Serve tests/pages on two ports (the second one makes frames cross-origin). */
export function servePages(port = 5480) {
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = join(pagesDir, url.pathname);
    if (url.pathname.startsWith('/spa')) file = join(pagesDir, 'spa.html');
    if (!existsSync(file) || !file.startsWith(pagesDir)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  };
  const a = createServer(handler).listen(port, '127.0.0.1');
  const b = createServer(handler).listen(port + 1, '127.0.0.1');
  return { base: `http://127.0.0.1:${port}`, close: () => (a.close(), b.close()) };
}

export async function launch({ userDataDir, headless = false, extraArgs = [] }) {
  // Chrome keeps the extension's service worker script in the profile and may run that copy
  // instead of the rebuilt one. Drop it; the stored model (OPFS) is elsewhere and stays.
  rmSync(join(userDataDir, 'Default', 'Service Worker'), { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`, '--enable-unsafe-extension-debugging', ...extraArgs],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  const browserCdp = await context.browser()?.newBrowserCDPSession?.().catch(() => null);
  return { context, sw, extId, browserCdp };
}

/**
 * Tab id of a page. Without the "tabs" permission the extension cannot see tab URLs, so the page
 * is brought to the front and the active tab is used.
 */
export async function tabIdOf(sw, page) {
  await page.bringToFront();
  return sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null);
}

/** Snapshot of the offscreen engine and player (asked through the service worker). */
export function engineDebug(sw) {
  return sw.evaluate(() => self.narrataTest.offscreen({ type: 'debug' }));
}

/** Evaluator for the content script's isolated world in a page. */
export async function isolatedWorld(context, page, extId) {
  const cdp = await context.newCDPSession(page);
  const contexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context: c }) => {
    if (c.origin?.includes(extId) || c.name === 'Narrata') contexts.set(c.auxData?.frameId ?? c.id, c.id);
  });
  cdp.on('Runtime.executionContextsCleared', () => contexts.clear());
  await cdp.send('Runtime.enable');
  const frameId = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  return {
    cdp,
    async eval(expression) {
      for (let i = 0; i < 50 && !contexts.get(frameId); i++) await new Promise((r) => setTimeout(r, 100));
      const id = contexts.get(frameId);
      if (!id) throw new Error('content script world not found');
      const r = await cdp.send('Runtime.evaluate', { expression, contextId: id, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
  };
}

/** Press the toolbar button (opens the popup and grants activeTab, like a user click). */
export async function pressAction(browserCdp, extId, page) {
  const { targetInfos } = await browserCdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.type === 'tab' && t.url === page.url());
  if (!tab) throw new Error('tab target not found');
  await browserCdp.send('Extensions.triggerAction', { id: extId, targetId: tab.targetId });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 30000, interval = 100, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(interval);
  }
}

// End-to-end check of the unpacked extension in Playwright's Chromium.
//
//   pnpm build:ext && node tests/e2e/verify-ext.mjs [--headed] [--profile DIR] [--phase first|reuse|compact|all]
//
// Serves tests/pages locally, drives the extension through its own entry points (toolbar button
// via CDP, the service worker's menu and shortcut handlers, the player's buttons) and checks that
// the highlight painted on the page matches the word the engine is speaking. Writes screenshots
// to docs/screenshots/ext-*.png and a JSON report next to the profile.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineDebug, isolatedWorld, launch, pressAction, root, servePages, sleep, tabIdOf, waitFor } from './harness.mjs';

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const headless = !args.includes('--headed');
const profile = arg('--profile', join(root, '.e2e-profile'));
const phase = arg('--phase', 'all');
const shots = join(root, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });
const report = { headless, startedAt: new Date().toISOString(), checks: [], numbers: {} };

function check(name, ok, detail = {}) {
  report.checks.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${Object.keys(detail).length ? '  ' + JSON.stringify(detail) : ''}`);
}

const norm = (s) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

const openContexts = new Set();
async function session() {
  const s = await launch({ userDataDir: profile, headless });
  openContexts.add(s.context);
  s.context.on('close', () => openContexts.delete(s.context));
  return s;
}

/** The popup, opened as a page for a given tab (a real popup cannot be screenshotted headless). */
async function popupFor(ctx, tabId) {
  const popup = await ctx.context.newPage();
  await popup.setViewportSize({ width: 340, height: 560 });
  await popup.goto(`chrome-extension://${ctx.extId}/popup.html?tab=${tabId}`);
  await popup.waitForFunction(() => !/Checking/.test(document.querySelector('#page')?.textContent ?? 'Checking') && !/Checking/.test(document.querySelector('#engine')?.textContent ?? 'Checking'), null, { timeout: 15000 }).catch(() => {});
  await sleep(300);
  return popup;
}

/** Open a test page and press the toolbar button on it (grants activeTab like a click would). */
async function openPage(ctx, url) {
  const { context, browserCdp, extId, sw } = ctx;
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForLoadState('load');
  await pressAction(browserCdp, extId, page);
  await sleep(400);
  // The popup opened by the button: close it so it does not cover the page.
  for (const p of context.pages()) if (p.url().endsWith('/popup.html')) await p.close();
  const tabId = await tabIdOf(sw, page);
  return { page, tabId };
}

const hostState = (page) => page.evaluate(() => document.querySelector('[data-narrata-host]')?.dataset.state ?? null);

async function highlightNow(page) {
  return page.evaluate(() => {
    const get = (name) => {
      const h = CSS.highlights.get(name);
      const r = h && [...h][0];
      if (!r) return null;
      const el = r.startContainer.parentElement;
      const rect = r.getBoundingClientRect();
      return { text: r.toString(), tag: el?.tagName, inArticle: !!el?.closest('article, #bodyContent, main, #app, #report'), top: rect.top, bottom: rect.bottom };
    };
    return { word: get('narrata-word'), sentence: get('narrata-sentence') };
  });
}

/** Sample the page highlight against the engine's current word. */
async function sampleAccuracy(ctx, page, iso, seconds, label) {
  const t0 = Date.now();
  let samples = 0;
  let textMatch = 0;
  let indexMatch = 0;
  let inArticle = 0;
  const misses = [];
  while (Date.now() - t0 < seconds * 1000) {
    const e1 = await engineDebug(ctx.sw);
    const h = await highlightNow(page);
    const c = await iso.eval('__narrataDebug.reading?.word ?? -1');
    const e2 = await engineDebug(ctx.sw);
    if (e1.state === 'playing' && h.word) {
      samples++;
      const ok = norm(h.word.text) === norm(e1.wordText) || norm(h.word.text) === norm(e2.wordText);
      if (ok) textMatch++;
      else misses.push({ page: h.word.text, engine: [e1.wordText, e2.wordText] });
      if (c === e1.word || c === e2.word) indexMatch++;
      if (h.word.inArticle) inArticle++;
    }
    await sleep(180);
  }
  const r = { samples, textMatch, indexMatch, inArticle, misses: misses.slice(0, 5) };
  check(`${label}: highlight matches the spoken word`, samples > 5 && textMatch / samples >= 0.9, r);
  return r;
}

/** Playback speed measured from the engine's input clock (seconds of 1x audio per wall second). */
async function measureRate(sw, ms = 3000) {
  const a = await engineDebug(sw);
  await sleep(ms);
  const b = await engineDebug(sw);
  if (!a.snapshot || !b.snapshot) return null;
  return (b.snapshot.input - a.snapshot.input) / ((b.wallMs - a.wallMs) / 1000);
}

async function clickInPlayer(page, selector) {
  await page.locator(`[data-narrata-host] ${selector}`).first().click();
}

async function waitState(page, states, timeout = 60000) {
  const want = Array.isArray(states) ? states : [states];
  return waitFor(async () => want.includes(await hostState(page)), { timeout, label: `player state ${want.join('/')}` });
}

// ---------------------------------------------------------------------------------------------

async function firstRun(srv) {
  const ctx = await session();
  const { sw } = ctx;
  const { page, tabId } = await openPage(ctx, `${srv.base}/article.html`);
  const iso0 = Date.now();
  await sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
  const iso = await isolatedWorld(ctx.context, page, ctx.extId);
  const first = await waitFor(async () => {
    const s = await hostState(page);
    return s === 'needs-download' || s === 'playing' ? s : null;
  }, { timeout: 30000, label: 'download prompt or playback' });
  const t = await iso.eval('__narrataDebug.timings');
  report.numbers.articleExtractMs = t.extractMs;
  const x = await iso.eval('({ method: __narrataDebug.reading.x.method, words: __narrataDebug.reading.x.words.length, coverage: __narrataDebug.reading.x.mapping.coverage, title: __narrataDebug.reading.x.title })');
  report.numbers.article = x;
  check('article: Readability finds the article and maps it to the page', x.method === 'readability' && x.coverage > 0.95, x);
  check('article: highlight API used (no DOM changes)', await iso.eval('__narrataDebug.highlightApi'));

  if (first === 'needs-download') {
    const prompt = await page.locator('[data-narrata-host] .dl').innerText();
    check('download: size shown before downloading', /\d+ MB/.test(prompt), { prompt: prompt.replace(/\s+/g, ' ').slice(0, 160) });
    await sleep(800);
    await page.screenshot({ path: join(shots, 'ext-download.png') });
    const dl0 = Date.now();
    await clickInPlayer(page, '.dl .btn');
    let maxLoaded = 0;
    let progressEvents = 0;
    await waitFor(async () => {
      const e = await engineDebug(sw);
      if (e.engine?.download?.loaded > maxLoaded) {
        maxLoaded = e.engine.download.loaded;
        progressEvents++;
      }
      return e.engine?.state === 'ready';
    }, { timeout: 20 * 60000, interval: 500, label: 'model download and load' });
    const dlMs = Date.now() - dl0;
    const e = await engineDebug(sw);
    report.numbers.download = { ms: dlMs, bytes: e.engine.status?.storedBytes, mbPerSec: e.engine.status?.storedBytes / 1e6 / (dlMs / 1000), progressSamples: progressEvents };
    check('download: progress reported and model stored', progressEvents >= 2 && e.engine.status?.plan.missingBytes === 0, report.numbers.download);
  }
  await waitState(page, 'playing', 120000);
  const e = await engineDebug(sw);
  report.numbers.engineFirstRun = { device: e.engine.device, variant: e.engine.variant, threads: e.engine.threads, loadMs: e.engine.loadMs, testMs: e.engine.testMs, crossOriginIsolated: e.crossOriginIsolated, ttfaMs: e.stats.ttfaMs };
  check('engine: offscreen document is cross-origin isolated', e.crossOriginIsolated, report.numbers.engineFirstRun);
  console.log('first audio after', Date.now() - iso0, 'ms (including any download)');

  await sampleAccuracy(ctx, page, iso, 15, 'article 1x');

  // Speed.
  const r1 = await measureRate(sw);
  await clickInPlayer(page, '.speed');
  await clickInPlayer(page, '[data-rate="2"]');
  await sleep(800);
  const r2 = await measureRate(sw);
  await sampleAccuracy(ctx, page, iso, 6, 'article 2x');
  await clickInPlayer(page, '[data-rate="3"]');
  await sleep(800);
  const r3 = await measureRate(sw);
  await clickInPlayer(page, '[data-rate="1"]');
  await clickInPlayer(page, '.speed');
  report.numbers.rates = { at1x: r1, at2x: r2, at3x: r3 };
  check('speed: playback follows the chosen speed', Math.abs(r1 - 1) < 0.12 && Math.abs(r2 - 2) < 0.2 && Math.abs(r3 - 3) < 0.35, report.numbers.rates);
  const prefs = await sw.evaluate(async () => (await chrome.storage.local.get('prefs')).prefs);
  check('speed: choice saved', prefs?.rate === 1, { prefs });

  // Pause and play from the player.
  await clickInPlayer(page, '.play');
  await waitState(page, 'paused', 5000);
  await sleep(600); // the pause is scheduled a fraction of a second ahead, after the fade
  const paused = await measureRate(sw, 1200);
  check('controls: pause stops the audio clock', paused !== null && Math.abs(paused) < 0.02, { rate: paused });
  await clickInPlayer(page, '.play');
  await waitState(page, ['playing'], 15000);
  check('controls: play resumes', true);

  // Sentence skipping.
  const sentence = () => iso.eval(`(() => { const r = __narrataDebug.reading; const w = r.x.words[r.word]; return r.sentences.findIndex((s) => w.start >= s.start && w.start < s.end); })()`);
  const s0 = await sentence();
  await clickInPlayer(page, '.next');
  await sleep(1500);
  const s1 = await sentence();
  await clickInPlayer(page, '.next');
  await sleep(1500);
  const s2 = await sentence();
  await clickInPlayer(page, '.prev');
  await sleep(300);
  await clickInPlayer(page, '.prev');
  await sleep(1500);
  const s3 = await sentence();
  check('controls: next and previous sentence', s1 === s0 + 1 && s2 === s0 + 2 && s3 <= s2 - 1, { s0, s1, s2, s3 });

  // Keyboard: Space only acts when the player has focus.
  await page.locator('[data-narrata-host] .np').focus();
  await page.keyboard.press('Space');
  await waitState(page, 'paused', 5000);
  await page.keyboard.press('Space');
  await waitState(page, 'playing', 15000);
  // Move focus to the page without clicking a word (a click on a word would jump there).
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page.keyboard.press('Space');
  await sleep(700);
  check('keyboard: Space toggles only with the player focused', (await hostState(page)) === 'playing');

  // Voice change.
  await clickInPlayer(page, '.voice-btn');
  await page.locator('[data-narrata-host] select').selectOption('am_michael');
  await waitFor(async () => (await engineDebug(sw)).voice === 'am_michael' && (await hostState(page)) === 'playing', { timeout: 20000, label: 'voice change' });
  check('controls: voice change keeps reading', true);
  await page.locator('[data-narrata-host] select').selectOption('af_heart');
  await clickInPlayer(page, '.voice-btn');
  await waitState(page, 'playing', 20000);

  // Follow, user scroll, back to current.
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 1800);
  await sleep(600);
  const following = await iso.eval('__narrataDebug.following');
  const backVisible = await page.locator('[data-narrata-host] .back').isVisible();
  check('scroll: following stops when the user scrolls, Back to current appears', following === false && backVisible);
  await clickInPlayer(page, '.back');
  await sleep(1500);
  const h = await highlightNow(page);
  const vh = await page.evaluate(() => innerHeight);
  check('scroll: Back to current brings the word into view', (await iso.eval('__narrataDebug.following')) && h.word && h.word.top > 0 && h.word.bottom < vh, { top: h.word?.top, vh, h, state: await hostState(page), word: await iso.eval('__narrataDebug.reading.word'), engine: (await engineDebug(sw)).wordText });

  // Click a word on the page to jump there.
  const target = await page.evaluate(() => {
    const p = [...document.querySelectorAll('article p')].find((e) => e.textContent.startsWith('The obstacle now is not demand'));
    p.scrollIntoView({ block: 'center' });
    const t = p.firstChild;
    const i = t.data.indexOf('equipment');
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + 'equipment'.length);
    const b = r.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await sleep(300);
  await page.mouse.click(target.x, target.y);
  await waitFor(async () => norm((await engineDebug(sw)).wordText) === 'equipment' || ['equipment', 'new', 'sleeper', 'carriages'].includes(norm((await engineDebug(sw)).wordText)), { timeout: 15000, label: 'jump to clicked word' }).catch(() => null);
  const afterClick = await engineDebug(sw);
  const firstAfter = await iso.eval(`__narrataDebug.reading.x.doc.text.slice(__narrataDebug.reading.x.words[__narrataDebug.reading.word].start, __narrataDebug.reading.x.words[__narrataDebug.reading.word].end)`);
  check('click: clicking a word jumps there', ['equipment', 'new', 'sleeper', 'carriages', 'take'].includes(norm(afterClick.wordText)), { engineWord: afterClick.wordText, pageWord: firstAfter });

  // Hero screenshot: let the highlight settle mid-paragraph.
  await page.click('.cookie button:last-child');
  await page.evaluate(() => scrollTo({ top: 0 }));
  const lead = await page.evaluate(() => {
    const p = [...document.querySelectorAll('article p')].find((e) => e.textContent.startsWith('The night train to the coast'));
    const t = p.firstChild;
    const i = t.data.indexOf('nobody on this platform');
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + 6);
    p.scrollIntoView({ block: 'center' });
    const b = r.getBoundingClientRect();
    return { x: b.left + 4, y: b.top + b.height / 2 };
  });
  await sleep(500);
  await page.mouse.click(lead.x, lead.y);
  await waitState(page, 'playing', 15000);
  await sleep(1900);
  await page.mouse.move(1270, 10);
  await page.screenshot({ path: join(shots, 'ext-reading.png') });
  const shotWord = await highlightNow(page);
  check('screenshot: reading view captured with a highlighted word', !!shotWord.word, { word: shotWord.word?.text });

  // Popup while reading.
  const popup = await popupFor(ctx, tabId);
  await popup.locator('body').screenshot({ path: join(shots, 'ext-popup.png') });
  const popupText = await popup.locator('body').innerText();
  check('popup: shows the page status and privacy note', /Reading|Paused/.test(popupText) && /Hugging Face/.test(popupText), { text: popupText.replace(/\s+/g, ' ').slice(0, 200) });
  await popup.close();

  // Read selection (shortcut handler).
  await clickInPlayer(page, '.play');
  await waitState(page, 'paused', 5000);
  const selText = await page.evaluate(() => {
    const p = [...document.querySelectorAll('article p')].find((e) => e.textContent.startsWith('Other lessons are new'));
    p.scrollIntoView({ block: 'center' });
    const t = p.firstChild;
    const r = document.createRange();
    r.setStart(t, t.data.indexOf('Families wanted'));
    r.setEnd(t, t.data.indexOf(' Travellers with'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return r.toString();
  });
  await sw.evaluate((t) => self.narrataTest.command('read-selection', t), tabId);
  await waitState(page, 'playing', 20000);
  const sel = await iso.eval('({ method: __narrataDebug.reading.x.method, text: __narrataDebug.reading.x.doc.text })');
  await sleep(1200);
  const hs = await highlightNow(page);
  check('selection: reads exactly the selection with highlight inside it', sel.method === 'selection' && sel.text === selText.trim() && hs.word && selText.includes(hs.word.text), { read: sel.text, highlight: hs.word?.text });
  await page.screenshot({ path: join(shots, 'ext-selection.png') });
  await page.evaluate(() => getSelection().removeAllRanges());

  // Start reading from here (context menu handler, after a right-click on the page).
  const here = await page.evaluate(() => {
    const p = [...document.querySelectorAll('article p')].find((e) => e.textContent.startsWith('Some of what the new operators'));
    p.scrollIntoView({ block: 'center' });
    const t = p.firstChild;
    const i = t.data.indexOf('timetables now include');
    const r = document.createRange();
    r.setStart(t, i);
    r.setEnd(t, i + 4);
    const b = r.getBoundingClientRect();
    return { x: b.left + 3, y: b.top + b.height / 2 };
  });
  await sleep(300);
  await page.mouse.click(here.x, here.y, { button: 'right' });
  await page.keyboard.press('Escape').catch(() => {});
  await sw.evaluate((t) => self.narrataTest.menu('narrata-read-here', t), tabId);
  await waitState(page, ['playing', 'loading'], 20000);
  const startWord = await iso.eval(`(() => { const r = __narrataDebug.reading; const w = r.x.words[r.word]; return { method: r.x.method, word: r.x.doc.text.slice(w.start, w.end), next: r.x.doc.text.slice(w.start, w.start + 40) }; })()`);
  check('start from here: reading starts at the right-clicked word', startWord.word === 'timetables' && startWord.method === 'readability', startWord);
  await waitState(page, 'playing', 20000);
  await sleep(800);
  const e2 = await engineDebug(sw);
  check('start from here: audio starts there', ['timetables', 'now', 'include', 'long'].includes(norm(e2.wordText)), { engineWord: e2.wordText });

  await ctx.context.close();
}

async function otherPages(srv) {
  const ctx = await session();
  const { sw } = ctx;

  // Wiki page with tables and footnotes.
  {
    const { page, tabId } = await openPage(ctx, `${srv.base}/wiki.html`);
    await sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
    const iso = await isolatedWorld(ctx.context, page, ctx.extId);
    await waitState(page, 'playing', 60000);
    const x = await iso.eval('({ method: __narrataDebug.reading.x.method, coverage: __narrataDebug.reading.x.mapping.coverage, text: __narrataDebug.reading.x.doc.text })');
    check('wiki: reads the article without footnote markers or navigation', !x.text.includes('[1]') && !x.text.includes('Random article') && x.text.includes('A lighthouse is a tower'), { method: x.method, coverage: x.coverage });
    await sampleAccuracy(ctx, page, iso, 6, 'wiki 1x');
    // Jump into the table and check the highlight lands in a cell.
    const cell = await page.evaluate(() => {
      const td = [...document.querySelectorAll('.wikitable td')].find((e) => e.textContent === 'Light shorter than dark');
      const b = td.getBoundingClientRect();
      td.scrollIntoView({ block: 'center' });
      const r = document.createRange();
      r.selectNodeContents(td.firstChild);
      const c = r.getBoundingClientRect();
      return { x: c.left + 8, y: c.top + c.height / 2, b };
    });
    await page.mouse.click(cell.x, cell.y);
    await sleep(1500);
    const h = await highlightNow(page);
    check('wiki: highlight lands inside the table cell', h.word?.tag === 'TD' || h.sentence?.tag === 'TD', { word: h.word?.text, tag: h.word?.tag });
    await page.screenshot({ path: join(shots, 'ext-wiki.png') });
    await page.close();
  }

  // Single-page app: content changes without a page load.
  {
    const { page, tabId } = await openPage(ctx, `${srv.base}/spa/one`);
    await page.waitForSelector('#app h1');
    await sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
    const iso = await isolatedWorld(ctx.context, page, ctx.extId);
    await waitState(page, 'playing', 60000);
    const before = await iso.eval('__narrataDebug.reading.x.doc.text');
    await page.click('[data-route="/spa/two"]');
    await sleep(1600);
    const st = await hostState(page);
    const msg = await page.locator('[data-narrata-host] .msg').innerText();
    check('spa: route change pauses and says the page changed', st === 'paused' && /changed/.test(msg), { state: st, msg });
    await sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
    await waitState(page, 'playing', 30000);
    const after = await iso.eval('__narrataDebug.reading.x.doc.text');
    check('spa: reading again picks up the new content', before.includes('river') && after.includes('glacier') && !after.includes('meander'), { before: before.slice(0, 40), after: after.slice(0, 40) });
    await sampleAccuracy(ctx, page, iso, 4, 'spa');
    await page.close();
  }

  // Frames: the top frame is read; a selection inside a frame is read as plain text.
  {
    const { page, tabId } = await openPage(ctx, `${srv.base}/frames.html`);
    await page.waitForTimeout(500);
    await sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
    const iso = await isolatedWorld(ctx.context, page, ctx.extId);
    await waitState(page, 'playing', 60000);
    const top = await iso.eval('__narrataDebug.reading.x.doc.text');
    check('frames: reads the top frame only', top.includes('fishing boats came in early') && !top.includes('Wind from the west'));
    const frame = page.frames().find((f) => f.url().endsWith('frame-inner.html') && f.url().startsWith(srv.base));
    await frame.evaluate(() => {
      const p = document.querySelector('p');
      const r = document.createRange();
      r.selectNodeContents(p);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await sw.evaluate((t) => self.narrataTest.command('read-selection', t), tabId);
    await waitState(page, 'playing', 30000);
    const fx = await iso.eval('({ method: __narrataDebug.reading.x.method, text: __narrataDebug.reading.x.doc.text })');
    const fmsg = await page.locator('[data-narrata-host] .msg').innerText();
    check('frames: selection in a same-origin frame is read as text', fx.method === 'text' && fx.text.startsWith('Wind from the west') && /frame/.test(fmsg), { method: fx.method, msg: fmsg });
    // Cross-origin frame: the context menu passes the selected text.
    await sw.evaluate((t) => self.narrataTest.menu('narrata-read-selection', t, { frameId: 99, selectionText: 'Light rain at times.' }), tabId);
    await waitState(page, ['playing', 'loading'], 30000);
    const cx = await iso.eval('__narrataDebug.reading.x.doc.text');
    check('frames: selection from a cross-origin frame (menu) is read', cx === 'Light rain at times.');
    await page.close();
  }

  // A long page: extraction stays quick and reading starts fast.
  {
    const { page, tabId } = await openPage(ctx, `${srv.base}/long.html`);
    const t0 = Date.now();
    await sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
    const iso = await isolatedWorld(ctx.context, page, ctx.extId);
    await waitState(page, 'playing', 60000);
    const ms = Date.now() - t0;
    const info = await iso.eval('({ words: __narrataDebug.reading.x.words.length, extractMs: __narrataDebug.timings.extractMs, coverage: __narrataDebug.reading.x.mapping.coverage, method: __narrataDebug.reading.x.method })');
    const e = await engineDebug(sw);
    report.numbers.longPage = { ...info, commandToAudioMs: ms, chunksPlanned: e.snapshot?.plan, chunksAppended: e.snapshot?.nextAppend };
    check('long page: extraction and first audio stay quick', info.words > 50000 && info.extractMs < 4000 && ms < 8000, report.numbers.longPage);
    check('long page: audio is generated a few chunks ahead, not all at once', e.snapshot && e.snapshot.nextAppend < 10, { appended: e.snapshot?.nextAppend, planned: e.snapshot?.plan });
    await sampleAccuracy(ctx, page, iso, 4, 'long page');
    await page.close();
  }

  // Restricted page.
  {
    const page = await ctx.context.newPage();
    await page.goto('chrome://version');
    const tabId = await tabIdOf(sw, page);
    const r = await sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
    const badge = await sw.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tabId);
    check('restricted: chrome:// page gives a clear message and a badge', /Chrome does not let extensions/.test(r ?? '') && badge === '!', { message: r, badge });
    // Popup on the restricted page.
    const popup = await popupFor(ctx, tabId);
    if (popup) {
      await popup.locator('body').screenshot({ path: join(shots, 'ext-restricted.png') });
      const text = await popup.locator('#page').innerText();
      check('restricted: popup explains it', /Chrome does not let extensions/.test(text), { text });
      await popup.close();
    } else check('restricted: popup explains it', false, { reason: 'popup did not open on chrome:// page' });
    await page.close();
  }
  await ctx.context.close();
}

async function reuseRun(srv) {
  // Fresh browser on the same profile: the stored model is reused, nothing is downloaded.
  const t0 = Date.now();
  const ctx = await session();
  const { page, tabId } = await openPage(ctx, `${srv.base}/article.html`);
  const tCmd = Date.now();
  await ctx.sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
  const iso = await isolatedWorld(ctx.context, page, ctx.extId);
  const states = new Set();
  await waitFor(async () => {
    const s = await hostState(page);
    states.add(s);
    return s === 'playing';
  }, { timeout: 60000, interval: 25, label: 'playing' });
  const coldMs = Date.now() - tCmd;
  const e = await engineDebug(ctx.sw);
  check('reuse: stored model is used, no download prompt', !states.has('needs-download') && !states.has('downloading'), { states: [...states] });
  // Warm start: engine already loaded.
  await clickInPlayer(page, '.close');
  await sleep(500);
  const tWarm = Date.now();
  await ctx.sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
  await waitFor(async () => (await hostState(page)) === 'playing', { timeout: 30000, interval: 20, label: 'playing warm' });
  const warmMs = Date.now() - tWarm;
  const e2 = await engineDebug(ctx.sw);
  report.numbers.timeToFirstAudio = {
    coldMs,
    coldEngineLoadMs: e.engine.loadMs,
    coldSelfTestMs: e.engine.testMs,
    warmMs,
    warmPlayerTtfaMs: e2.stats.ttfaMs,
    browserLaunchMs: tCmd - t0,
  };
  check('reuse: time to first audio measured', true, report.numbers.timeToFirstAudio);
  await sampleAccuracy(ctx, page, iso, 25, 'article after restart');
  const e3 = await engineDebug(ctx.sw);
  report.numbers.generation = {
    device: e3.engine.device,
    variant: e3.engine.variant,
    threads: e3.engine.threads,
    audioSecondsPerComputeSecond: e3.stats.generatedSeconds / e3.stats.computeSeconds,
    underruns: e3.stats.underruns,
  };
  check('generation: speed measured', true, report.numbers.generation);

  // Offscreen lifetime while paused.
  await clickInPlayer(page, '.play');
  await waitState(page, 'paused', 5000);
  await sleep(40000);
  const alive = await ctx.sw.evaluate(async () => (await chrome.runtime.getContexts({})).some((c) => c.contextType === 'OFFSCREEN_DOCUMENT'));
  report.numbers.offscreenAliveAfter40sPaused = alive;
  await clickInPlayer(page, '.play');
  await waitState(page, 'playing', 60000);
  check('resume after a 40 s pause works', true, { offscreenStillAlive: alive });
  await ctx.context.close();
}

async function compactRun(srv) {
  // The smaller model on the processor (WebAssembly, q8), the path used without WebGPU.
  const ctx = await session();
  await ctx.sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get('prefs')).prefs ?? {};
    await chrome.storage.local.set({ prefs: { ...cur, model: 'compact' } });
  });
  const { page, tabId } = await openPage(ctx, `${srv.base}/article.html`);
  await ctx.sw.evaluate((t) => self.narrataTest.command('read-page', t), tabId);
  const iso = await isolatedWorld(ctx.context, page, ctx.extId);
  const s = await waitFor(async () => {
    const st = await hostState(page);
    return st === 'needs-download' || st === 'playing' ? st : null;
  }, { timeout: 60000, label: 'prompt' });
  if (s === 'needs-download') {
    const t0 = Date.now();
    await clickInPlayer(page, '.dl .btn');
    await waitFor(async () => (await engineDebug(ctx.sw)).engine?.state === 'ready', { timeout: 10 * 60000, interval: 500, label: 'compact model' });
    report.numbers.compactDownloadMs = Date.now() - t0;
  }
  await waitState(page, 'playing', 120000);
  await sampleAccuracy(ctx, page, iso, 30, 'compact model');
  const e = await engineDebug(ctx.sw);
  report.numbers.compact = {
    device: e.engine.device,
    variant: e.engine.variant,
    threads: e.engine.threads,
    crossOriginIsolated: e.crossOriginIsolated,
    loadMs: e.engine.loadMs,
    selfTestMs: e.engine.testMs,
    ttfaMs: e.stats.ttfaMs,
    audioSecondsPerComputeSecond: e.stats.generatedSeconds / e.stats.computeSeconds,
    underruns: e.stats.underruns,
  };
  check('compact: WebAssembly path runs with threads', e.engine.device === 'wasm' && e.engine.threads >= 2, report.numbers.compact);
  await ctx.sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get('prefs')).prefs ?? {};
    await chrome.storage.local.set({ prefs: { ...cur, model: 'auto' } });
  });
  await ctx.context.close();
}

const srv = servePages();
try {
  if (phase === 'first' || phase === 'all') await firstRun(srv);
  if (phase === 'pages' || phase === 'all') await otherPages(srv);
  if (phase === 'reuse' || phase === 'all') await reuseRun(srv);
  if (phase === 'compact' || phase === 'all') await compactRun(srv);
} catch (e) {
  check('run completed', false, { error: String(e?.stack ?? e).slice(0, 600) });
} finally {
  for (const c of openContexts) await c.close().catch(() => {});
  srv.close();
  const out = join(profile, '..', `narrata-e2e-${phase}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2));
  const failed = report.checks.filter((c) => !c.ok);
  console.log(`\n${report.checks.length - failed.length}/${report.checks.length} checks passed. Report: ${out}`);
  console.log(JSON.stringify(report.numbers, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

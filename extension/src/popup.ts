// Toolbar popup: what is happening on this page, the voice download, shortcuts and privacy.

import type { EngineInfo } from '../../src/engine/client';
import { downloadSize } from '../../src/engine/model-store';
import { icons, logo } from '../../src/ui/icons';
import { choiceHtml, isFirstRun } from './choice';
import { WEB_APP_URL } from './config';
import { type PopupEvent, type PopupRequest, type PopupStatus, envelope, isEnvelope } from './protocol';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

let tabId = -1;
let last: PopupStatus | null = null;

function ask<T>(req: PopupRequest): Promise<T> {
  return chrome.runtime.sendMessage(envelope('background', req)) as Promise<T>;
}

function renderPage(s: PopupStatus) {
  const box = $('#page');
  if (s.page.restricted) {
    box.innerHTML = `<div class="notice">${icons.lock}<p>${s.page.restricted}</p></div>${
      /PDF/.test(s.page.restricted) ? `<a class="btn quiet" href="${WEB_APP_URL}" target="_blank" rel="noopener">Open the web app</a>` : ''
    }`;
    return;
  }
  const t = s.tab;
  if (t?.reading) {
    const playing = t.state === 'playing' || t.state === 'loading' || t.state === 'buffering';
    const label = t.state === 'needs-download' ? 'Waiting for the voice download' : t.state === 'ended' ? 'Finished' : playing ? 'Reading' : 'Paused';
    box.innerHTML = `<div class="now"><div class="title"></div><div class="sub">${label} · ${Math.round(t.progress * 100)}%</div>
<div class="bar"><span style="width:${(t.progress * 100).toFixed(1)}%"></span></div></div>
<div class="actions"><button class="btn" id="toggle">${playing ? icons.pause : icons.play}<span>${playing ? 'Pause' : 'Play'}</span></button><button class="btn quiet" id="stop">${icons.stop}<span>Stop</span></button></div>`;
    box.querySelector('.title')!.textContent = t.title;
    $('#toggle').onclick = () => command('toggle');
    $('#stop').onclick = () => command('stop');
    return;
  }
  const elsewhere = s.readingTab !== null && s.readingTab !== tabId;
  box.innerHTML = `<p class="muted">${elsewhere ? 'Narrata is reading in another tab. Starting here pauses it.' : 'Narrata is not reading this page.'}</p>
<div class="actions"><button class="btn" id="read-page">${icons.play}<span>Read this page</span></button><button class="btn quiet" id="read-selection">${icons.text}<span>Read selection</span></button></div>`;
  $('#read-page').onclick = () => command('read-page');
  $('#read-selection').onclick = () => command('read-selection');
}

async function renderEngine(info: EngineInfo | null) {
  const box = $('#engine');
  if (!info) {
    box.innerHTML = `<p class="muted">Checking the voice…</p>`;
    return;
  }
  const st = info.status;
  if (info.state === 'downloading') {
    const d = info.download;
    const frac = d && d.total ? d.loaded / d.total : 0;
    box.innerHTML = `<p>Downloading the voice: ${d ? `${mb(d.loaded)} of ${mb(d.total)}` : 'starting'}</p><div class="progress"><span style="width:${(frac * 100).toFixed(1)}%"></span></div>`;
    return;
  }
  if (info.state === 'error') {
    box.innerHTML = `<p class="error"></p>`;
    box.querySelector('.error')!.textContent = info.error ?? 'The voice engine stopped.';
    return;
  }
  if (st && isFirstRun(st) && info.state === 'needs-download') {
    const prefs = ((await chrome.storage.local.get('prefs')).prefs ?? {}) as { voice?: string };
    box.innerHTML = choiceHtml(st, prefs.voice ?? 'af_heart');
    box.querySelectorAll<HTMLButtonElement>('[data-voice]').forEach((b) => (b.onclick = () => download('auto', b.dataset.voice)));
    return;
  }
  if (st && st.plan.missingBytes > 0 && info.state !== 'ready' && info.state !== 'loading') {
    box.innerHTML = `<p>The voice is not downloaded yet. One-time download: <strong>${mb(st.plan.missingBytes)}</strong>${st.hasWebGPU ? ' (runs on your graphics chip)' : ''}.</p>
<div class="actions"><button class="btn" id="dl-auto">${icons.download}<span>Download ${mb(st.plan.missingBytes)}</span></button>${st.hasWebGPU && st.plan.engine === 'kokoro' ? `<button class="btn quiet" id="dl-compact">Smaller, ${mb(downloadSize('uint8'))}</button>` : ''}</div>`;
    $('#dl-auto').onclick = () => download('auto');
    const c = document.getElementById('dl-compact');
    if (c) c.onclick = () => download('compact');
    return;
  }
  const where = info.device ? (info.device === 'webgpu' ? 'graphics chip' : `processor, ${info.threads ?? 1} thread${info.threads === 1 ? '' : 's'}`) : st?.plan.device === 'webgpu' ? 'graphics chip' : 'processor';
  const size = st ? mb(st.storedBytes) : '';
  const label = info.state === 'ready' ? 'Voice ready' : 'Voice downloaded';
  box.innerHTML = `<p class="ok">${icons.check}<span>${label} on this computer${size ? ` · ${size}` : ''} · ${where}</span></p>`;
}

async function download(model: 'auto' | 'compact', voice?: string) {
  await ask({ type: 'prefs', prefs: voice ? { model, voice } : { model } });
  const info = await ask<EngineInfo>({ type: 'download', model, voice });
  void renderEngine(info);
}

async function command(c: 'read-page' | 'read-selection' | 'toggle' | 'stop') {
  const r = await ask<{ ok: boolean; error?: string | null }>({ type: 'command', tabId, command: c });
  if (r && !r.ok && r.error) {
    $('#page').innerHTML = `<div class="notice">${icons.info}<p></p></div>`;
    $('#page p').textContent = r.error;
    return;
  }
  setTimeout(refresh, 150);
}

async function refresh() {
  const s = await ask<PopupStatus>({ type: 'status', tabId }).catch(() => null);
  if (!s) return;
  last = s;
  renderPage(s);
  void renderEngine(s.engine);
}

async function shortcuts() {
  const list = await chrome.commands.getAll();
  const names: Record<string, string> = { 'read-page': 'Read this page', 'read-selection': 'Read selection', 'toggle-reading': 'Play or pause' };
  $('#keys').innerHTML = list
    .filter((c) => names[c.name ?? ''])
    .map((c) => `<li><span>${names[c.name!]}</span><kbd>${c.shortcut || 'not set'}</kbd></li>`)
    .join('');
}

chrome.runtime.onMessage.addListener((raw: unknown) => {
  if (!isEnvelope(raw) || raw.to !== 'popup') return false;
  const ev = raw.msg as PopupEvent;
  if (ev.type === 'engine') {
    void renderEngine(ev.info);
    if (ev.info.state === 'ready' && last?.engine?.state !== 'ready') void refresh();
  } else if (ev.type === 'session') void refresh();
  return false;
});

async function init() {
  $('#logo').innerHTML = logo;
  $('#webapp').setAttribute('href', WEB_APP_URL);
  $('#shortcuts-link').onclick = (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  };
  // ?tab=<id> shows the status of a given tab (used when the popup is opened as a page in tests).
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = forced ? [] : await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = forced || (tab?.id ?? -1);
  await Promise.all([refresh(), shortcuts()]);
  setInterval(refresh, 1500);
}

void init();

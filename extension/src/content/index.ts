// Content script, injected into the top frame on demand (activeTab). It decides what to read,
// shows the player, and paints the word being spoken on the original page.

import type { PlayerState } from '../../../src/audio/player';
import { type Sentence, documentSentences } from '../../../src/core/chunker';
import { lastAtOrBefore, wordIndexAt } from '../../../src/core/text';
import type { EngineInfo } from '../../../src/engine/client';
import type { ModelChoice } from '../../../src/engine/protocol';
import { DEFAULT_VOICE } from '../../../src/engine/voices';
import { caretAt } from '../../../src/ui/highlight';
import { type Envelope, type ReadingPrefs, type TabCommand, type TabEvent, type TabRequest, type TabStatus, envelope, isEnvelope } from '../protocol';
import { type Extracted, extractFrom, extractPage, extractSelection, extractText } from './extract';
import { Follower } from './follow';
import { PageHighlighter } from './highlighter';
import { MiniPlayer, type UiState } from './mini-player';
import { domToFlat } from './textmap';

interface Reading {
  session: number;
  x: Extracted;
  sentences: Sentence[];
  word: number;
  url: string;
  /** The engine dropped this session (another tab took over, or it restarted). */
  detached: boolean;
}

const g = globalThis as unknown as { __narrata?: boolean; __narrataDebug?: object };

if (!g.__narrata) {
  g.__narrata = true;
  main();
}

function main() {
  let reading: Reading | null = null;
  let prefs: ReadingPrefs = { voice: DEFAULT_VOICE, rate: 1, model: 'auto' };
  let engineInfo: EngineInfo | null = null;
  let lastContext: { node: Node; offset: number } | null = null;
  let urlTimer = 0;
  /** A note about the current reading that stays while it plays (errors are cleared on play). */
  let note: string | null = null;
  /** Timings of the last start (ms, performance.now()), for automated checks. */
  const timings = { requested: 0, extracted: 0, playing: 0, extractMs: 0 };

  const prefsLoaded = chrome.storage.local.get('prefs').then((r) => {
    prefs = { ...prefs, ...((r.prefs ?? {}) as Partial<ReadingPrefs>) };
  });
  const savePrefs = () => void chrome.storage.local.set({ prefs });

  const exclude = (el: Element) => el.hasAttribute('data-narrata-host');

  const send = (msg: TabRequest): Promise<{ ok?: boolean; reason?: string; needsDownload?: boolean; info?: EngineInfo } | undefined> =>
    chrome.runtime.sendMessage(envelope('background', msg)).catch((e: Error) => {
      ui.message(`Narrata lost contact with its engine (${e.message}). Reload the page and try again.`);
      return undefined;
    });

  /** Send a control; if the engine forgot this session (restarted), reopen it at the current word. */
  async function control(make: (session: number) => TabRequest, resumePlaying: boolean) {
    if (!reading) return;
    if (reading.detached) return reopen(resumePlaying);
    const r = await send(make(reading.session));
    if (r && r.ok === false && r.reason === 'no-session') await reopen(resumePlaying);
  }

  const ui = new MiniPlayer({
    toggle: () => {
      const s = ui.getState();
      void control((session) => ({ type: 'toggle', session }), !(s === 'playing' || s === 'loading' || s === 'buffering'));
    },
    skip: (delta) => void control((session) => ({ type: 'skip', session, delta }), true),
    rate: (rate) => {
      prefs.rate = rate;
      savePrefs();
      void control((session) => ({ type: 'rate', session, rate }), false);
    },
    voice: (voice) => {
      prefs.voice = voice;
      savePrefs();
      void control((session) => ({ type: 'voice', session, voice }), false);
    },
    close: () => close(),
    backToCurrent: () => {
      follower.set(true);
      const r = reading?.x.mapping?.nearestRange(reading.word);
      if (r) follower.follow(r, true);
    },
    download: (model: ModelChoice) => {
      prefs.model = model;
      savePrefs();
      if (reading) void send({ type: 'download', session: reading.session, model });
      ui.setState('downloading');
    },
  });
  const hl = new PageHighlighter(ui.layer);
  const follower = new Follower(
    (t) => ui.contains(t),
    (f) => ui.setFollowing(f),
    () => ui.height,
  );

  // Remember where the page was right-clicked, for "Start reading from here".
  document.addEventListener('contextmenu', (e) => {
    if (ui.contains(e.target)) return;
    const c = caretAt(e.clientX, e.clientY);
    if (c) lastContext = c;
  }, true);

  // Click a word on the page while reading to jump there.
  document.addEventListener('click', (e) => {
    if (!reading?.x.mapping || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (ui.contains(e.target)) return;
    const t = e.target as Element | null;
    if (t?.closest?.('a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [role="link"]')) return;
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed) return;
    const c = caretAt(e.clientX, e.clientY);
    if (!c) return;
    const i = readingWordAt(reading.x, c.node, c.offset);
    if (i < 0) return;
    seekTo(i);
  }, true);

  function readingWordAt(x: Extracted, node: Node, offset: number): number {
    const m = x.mapping;
    if (!m) return -1;
    const flat = domToFlat(m.index, node, offset);
    if (flat < 0) return -1;
    const j = m.pageWordAt(flat);
    const span = m.pageSpan;
    if (j < 0 || !span || j < span[0] || j > span[1]) return -1;
    return m.readingWordForPageWord(j);
  }

  function seekTo(i: number) {
    if (!reading) return;
    const offset = reading.x.words[i].start;
    showWord(i);
    follower.set(true);
    void control((session) => ({ type: 'seek', session, offset }), true);
  }

  function statusText(s: UiState): string {
    switch (s) {
      case 'playing':
        return 'Reading';
      case 'paused':
        return 'Paused';
      case 'loading':
        return 'Starting';
      case 'buffering':
        return 'Waiting for the voice';
      case 'ended':
        return 'Finished';
      case 'needs-download':
        return 'Voice not downloaded yet';
      case 'downloading':
        return 'Downloading the voice';
      case 'preparing':
        return engineInfo?.stage ?? 'Starting the voice';
      default:
        return '';
    }
  }

  function setUiState(s: UiState) {
    ui.setState(s);
    const pct = reading ? Math.round((100 * Math.max(0, reading.word)) / Math.max(1, reading.x.words.length)) : 0;
    ui.setStatus(s === 'playing' || s === 'paused' ? `${statusText(s)} · ${pct}%` : statusText(s));
  }

  function showWord(i: number) {
    if (!reading) return;
    reading.word = i;
    const { x, sentences } = reading;
    ui.setProgress(i / Math.max(1, x.words.length));
    if (!x.mapping) return;
    if (!x.mapping.isLive()) {
      hl.clear();
      ui.message('This page changed while reading. Choose Read this page again to follow along.');
      return;
    }
    const w = x.words[i];
    const si = Math.max(0, lastAtOrBefore(sentences, w.start, (s) => s.start));
    const s = sentences[si];
    const first = wordIndexAt(x.words, s.start);
    const last = Math.max(first, lastAtOrBefore(x.words, s.end - 1, (ww) => ww.start));
    const wr = x.mapping.rangeForWord(i);
    hl.show(wr, x.mapping.rangeForWords(first, last));
    const near = wr ?? x.mapping.nearestRange(i);
    if (near) follower.follow(near);
  }

  function onEngine(info: EngineInfo) {
    engineInfo = info;
    ui.showEngine(info);
    if (info.state === 'needs-download') setUiState('needs-download');
    else if (info.state === 'downloading') setUiState('downloading');
    else if (info.state === 'loading' || info.state === 'starting') {
      if (ui.getState() !== 'playing') setUiState('preparing');
    } else if (info.state === 'error') {
      setUiState('paused');
      ui.message(info.error ?? 'The voice engine stopped.');
    }
  }

  function onEvent(ev: TabEvent) {
    if (!reading || ev.session !== reading.session) return;
    switch (ev.type) {
      case 'word':
        showWord(ev.word);
        break;
      case 'state':
        setUiState(ev.state);
        if (ev.state === 'playing') {
          ui.message(note);
          if (!timings.playing) timings.playing = performance.now();
        }
        break;
      case 'engine':
        onEngine(ev.info);
        break;
      case 'error':
        ui.message(ev.message);
        break;
      case 'ended':
        reading.detached = true;
        hl.clear();
        setUiState('paused');
        ui.setStatus(ev.reason === 'other-tab' ? 'Paused: reading in another tab' : 'Stopped');
        break;
    }
  }

  function newSession(): number {
    return (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
  }

  async function reopen(play: boolean) {
    if (!reading) return;
    reading.session = newSession();
    reading.detached = false;
    await openSession(reading.x.words[Math.max(0, reading.word)]?.start ?? 0, play);
  }

  async function openSession(offset: number, play: boolean) {
    if (!reading) return;
    await prefsLoaded;
    const { x } = reading;
    setUiState('loading');
    const r = await send({
      type: 'open',
      session: reading.session,
      doc: { text: x.doc.text, blocks: x.doc.blocks, title: x.title, url: location.href },
      offset,
      prefs,
      play,
    });
    if (r?.info) onEngine(r.info);
  }

  function hoverPoint(): { node: Node; offset: number } | null {
    const hovered = document.querySelectorAll(':hover');
    const el = hovered[hovered.length - 1];
    if (!el || ui.contains(el) || el === document.documentElement || el === document.body) return null;
    return { node: el, offset: 0 };
  }

  function selectionStart(): { node: Node; offset: number } | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return { node: r.startContainer, offset: r.startOffset };
  }

  async function start(mode: 'page' | 'selection' | 'here', text?: string) {
    timings.requested = performance.now();
    timings.playing = 0;
    const opts = { exclude };
    let x: Extracted | null = null;
    let startWord = 0;
    ui.message(null);
    if (text) {
      x = extractText(document, text);
    } else if (mode === 'selection') {
      x = extractSelection(document, opts);
      if (!x) {
        showOnly('Select some text on the page first, then choose Read selection.');
        return;
      }
    } else if (mode === 'here') {
      const at = lastContext ?? selectionStart() ?? hoverPoint();
      lastContext = null;
      if (at) {
        const page = extractPage(document, opts);
        const i = page ? readingWordAt(page, at.node, at.offset) : -1;
        if (page && i >= 0) {
          x = page;
          startWord = i;
        } else x = extractFrom(document, at.node, at.offset, opts);
      }
      x ??= extractPage(document, opts);
    } else {
      x = extractPage(document, opts);
      // When there is no clear article, a selection says more about what to read than a guess.
      if (x?.method === 'largest-block') x = extractSelection(document, opts) ?? x;
      x ??= extractSelection(document, opts);
    }
    if (!x) {
      showOnly('Narrata found no text to read here. Select some text and choose Read selection.');
      return;
    }
    timings.extracted = performance.now();
    timings.extractMs = Math.round(timings.extracted - timings.requested);
    hl.clear();
    reading = { session: newSession(), x, sentences: documentSentences(x.doc), word: startWord, url: location.href, detached: false };
    ui.mount();
    ui.setTitle(x.title);
    ui.setRate(prefs.rate);
    ui.setVoice(prefs.voice);
    ui.setFollowing(true);
    follower.set(true);
    note = !x.mapping
      ? 'This text is inside a frame, so it is read without highlighting.'
      : x.mapping.coverage < 0.8
        ? 'Some of this text could not be found on the page, so the highlight may skip words.'
        : null;
    ui.message(note);
    showWord(startWord);
    ui.focus();
    watchUrl();
    await openSession(x.words[startWord].start, true);
  }

  function showOnly(message: string) {
    ui.mount();
    ui.setTitle('Narrata');
    if (!reading) setUiState('idle');
    ui.message(message);
  }

  /** Single-page apps change content without a page load: notice it and stop reading the old text. */
  function watchUrl() {
    clearInterval(urlTimer);
    urlTimer = window.setInterval(() => {
      if (!reading) return clearInterval(urlTimer);
      if (location.href !== reading.url) {
        reading.url = location.href;
        hl.clear();
        void send({ type: 'pause', session: reading.session });
        ui.message('This page changed. Choose Read this page again to read the new content.');
      }
    }, 1000);
  }

  function close() {
    if (reading) void send({ type: 'close', session: reading.session });
    reading = null;
    clearInterval(urlTimer);
    hl.clear();
    ui.message(null);
    ui.unmount();
  }

  function status(): TabStatus {
    const st = ui.getState();
    return {
      reading: !!reading,
      title: reading?.x.title ?? document.title,
      state: st === 'needs-download' ? 'needs-download' : st === 'downloading' || st === 'preparing' ? 'loading' : (st as PlayerState),
      progress: reading ? reading.word / Math.max(1, reading.x.words.length) : 0,
      method: reading?.x.method,
    };
  }

  chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
    if (!isEnvelope(raw) || raw.to !== 'tab') return false;
    const msg = (raw as Envelope).msg as TabEvent | TabCommand;
    if ('session' in msg) {
      onEvent(msg);
      return false;
    }
    switch (msg.type) {
      case 'read':
        void start(msg.mode, msg.text);
        sendResponse({ ok: true });
        break;
      case 'toggle':
        if (reading) ui.focus();
        if (reading) void control((session) => ({ type: 'toggle', session }), true);
        else void start('page');
        sendResponse({ ok: true });
        break;
      case 'stop':
        close();
        sendResponse({ ok: true });
        break;
      case 'status':
        sendResponse(status());
        break;
      case 'has-selection': {
        const sel = document.getSelection();
        sendResponse(!!sel && !sel.isCollapsed && !!sel.toString().trim());
        break;
      }
    }
    return false;
  });

  // Read-only view of the current state, for automated checks (test build only).
  if (__NARRATA_TEST__) {
    g.__narrataDebug = {
      get reading() {
        return reading;
      },
      get highlightApi() {
        return hl.usesHighlightApi;
      },
      get following() {
        return follower.following;
      },
      timings,
      ui,
    };
  }
}

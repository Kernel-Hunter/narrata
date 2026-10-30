// Offscreen document: hosts the TTS worker and the audio player, the same modules the web app
// uses. It reads for one tab at a time and reports words, state and engine progress back to that
// tab through the service worker.

import SignalsmithStretch from 'signalsmith-stretch';
import { Player, type PlaybackDoc, type PlayerState } from '../../src/audio/player';
import { documentSentences, planChunks } from '../../src/core/chunker';
import { type DocText, tokenizeWords } from '../../src/core/text';
import { type EngineInfo, TtsClient } from '../../src/engine/client';
import type { ModelChoice } from '../../src/engine/protocol';
import { DEFAULT_VOICE } from '../../src/engine/voices';
import { type Envelope, type EngineRequest, type PopupEvent, SessionTable, type TabEvent, type TabEventBody, type TabRequest, envelope, isEnvelope } from './protocol';

// MV3 pages may not load scripts from blob: URLs, so the stretch worklet ships as a file.
(SignalsmithStretch as unknown as { moduleUrl: string }).moduleUrl = chrome.runtime.getURL('stretch-worklet.js');

// This document is never rendered, so requestAnimationFrame never fires. The player uses it to
// follow the audio clock; a timer does the same job here (timers keep running while audio plays).
window.requestAnimationFrame = (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 16);
window.cancelAnimationFrame = (id: number) => window.clearTimeout(id);

const sessions = new SessionTable();
let tts: TtsClient | null = null;
let player: Player | null = null;
let model: ModelChoice = 'auto';
/** Reading request waiting for the model (download or load). */
let pending: { offset: number; play: boolean } | null = null;
let preparing: Promise<void> | null = null;

function send(env: Envelope) {
  chrome.runtime.sendMessage(env).catch(() => {
    // Nobody listening (popup closed): fine.
  });
}

function toTab(event: TabEventBody) {
  const env = sessions.address(event);
  if (env) send(env);
}

function toPopup(event: PopupEvent) {
  send(envelope('popup', event));
}

function engine(choice: ModelChoice, voice: string = DEFAULT_VOICE): TtsClient {
  if (tts) return tts;
  model = choice;
  tts = new TtsClient(choice, voice);
  // Download progress arrives for every network chunk; pass on state changes at once and
  // progress at most five times a second.
  let lastState = '';
  let lastSent = 0;
  tts.subscribe((info) => {
    const now = performance.now();
    if (info.state === lastState && now - lastSent < 200) return;
    lastState = info.state;
    lastSent = now;
    toTab({ type: 'engine', info });
    toPopup({ type: 'engine', info });
    if (info.state === 'error' && pending) pending = null;
  });
  player = new Player(tts, {
    onState: (s: PlayerState) => {
      toTab({ type: 'state', state: s });
      toPopup({ type: 'session', tabId: sessions.owner?.tabId ?? null, state: s });
    },
    onWord: (w: number) => toTab({ type: 'word', word: w }),
    onError: (message: string) => toTab({ type: 'error', message }),
  });
  return tts;
}

/** Resolves once the worker has reported what is stored (needed to know if a download is due). */
function statusKnown(client: TtsClient): Promise<EngineInfo> {
  return new Promise((resolve) => {
    let done = false;
    let unsub: (() => void) | null = null;
    unsub = client.subscribe((info) => {
      if (done || (!info.status && info.state !== 'error' && info.state !== 'ready')) return;
      done = true;
      resolve(info);
      queueMicrotask(() => unsub?.());
    });
  });
}

function playbackDoc(doc: DocText): PlaybackDoc {
  const sentences = documentSentences(doc);
  return { doc, words: tokenizeWords(doc.text), sentences, chunks: planChunks(doc, sentences) };
}

async function prepareAndPlay(choice: ModelChoice): Promise<void> {
  const client = engine(choice);
  if (!preparing) {
    preparing = client.prepare(choice, player?.voice ?? DEFAULT_VOICE).finally(() => {
      preparing = null;
    });
  }
  try {
    await preparing;
  } catch (e) {
    toTab({ type: 'error', message: (e as Error).message });
    return;
  }
  const p = pending;
  pending = null;
  if (p && player?.pdoc) {
    if (p.play) await player.playFrom(p.offset);
    else player.setPosition(p.offset);
  }
}

async function open(tabId: number, req: Extract<TabRequest, { type: 'open' }>): Promise<{ ok: boolean; needsDownload?: boolean; info?: EngineInfo }> {
  const prev = sessions.claim(tabId, req.session);
  if (prev) send(envelope('tab', { type: 'ended', session: prev.session, reason: 'other-tab' } satisfies TabEvent, prev.tabId));
  const client = engine(req.prefs.model, req.prefs.voice);
  const p = player!;
  p.stop();
  p.rate = req.prefs.rate;
  p.setVoice(req.prefs.voice);
  p.load(playbackDoc({ text: req.doc.text, blocks: req.doc.blocks, chapters: [] }));
  toPopup({ type: 'session', tabId, state: 'loading' });
  pending = { offset: req.offset, play: req.play };
  // Ask what the saved voice needs: a fast voice needs only its own files.
  const info = client.info.state === 'ready' || preparing ? client.info : await client.select(req.prefs.model, req.prefs.voice);
  if (info.state !== 'ready' && (info.status?.plan.missingBytes ?? 0) > 0 && !preparing) {
    // Ask first: the tab shows the size and a download button.
    toTab({ type: 'engine', info });
    return { ok: true, needsDownload: true, info };
  }
  void prepareAndPlay(req.prefs.model);
  return { ok: true, info: client.info };
}

async function handleTab(tabId: number, req: TabRequest): Promise<unknown> {
  if (req.type === 'open') return open(tabId, req);
  if (!sessions.accepts(tabId, req.session) || !player) return { ok: false, reason: 'no-session' };
  const p = player;
  switch (req.type) {
    case 'toggle':
      if (pending) {
        pending.play = !pending.play;
        return { ok: true };
      }
      p.toggle();
      break;
    case 'pause':
      p.pause();
      break;
    case 'skip':
      p.skipSentence(req.delta);
      break;
    case 'seek':
      if (pending) pending.offset = req.offset;
      else if (p.state === 'paused' || p.state === 'idle' || p.state === 'ended') p.setPosition(req.offset);
      else await p.playFrom(req.offset);
      break;
    case 'rate':
      p.setRate(req.rate);
      break;
    case 'voice':
      p.setVoice(req.voice);
      break;
    case 'download':
      model = req.model;
      if (req.voice) p.setVoice(req.voice);
      void prepareAndPlay(req.model);
      break;
    case 'close':
      p.stop();
      pending = null;
      sessions.release(tabId, req.session);
      toPopup({ type: 'session', tabId: null, state: null });
      break;
  }
  return { ok: true };
}

async function handleEngine(req: EngineRequest): Promise<unknown> {
  switch (req.type) {
    case 'engine-info': {
      const client = engine(req.model ?? model, req.voice);
      if (client.info.state === 'ready' || preparing) return client.info;
      if (req.voice && req.voice !== player?.voice) {
        player?.setVoice(req.voice);
        return client.select(req.model ?? model, req.voice);
      }
      return client.info.status ? client.info : await statusKnown(client);
    }
    case 'session-info':
      return { tabId: sessions.owner?.tabId ?? null, state: player?.state ?? null };
    case 'debug':
      // State for automated checks, in the test build only.
      return __NARRATA_TEST__ ? debugSnapshot() : null;
    case 'download': {
      const client = engine(req.model, req.voice);
      if (req.voice) player?.setVoice(req.voice);
      if (client.info.state === 'ready') return client.info;
      model = req.model;
      if (!preparing) {
        preparing = client.prepare(req.model, player?.voice ?? DEFAULT_VOICE).finally(() => {
          preparing = null;
        });
        preparing.catch(() => {});
      }
      return client.info;
    }
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  if (!isEnvelope(raw) || raw.to !== 'offscreen') return false;
  const env = raw;
  const msg = env.msg as TabRequest | EngineRequest;
  const run = env.tabId !== undefined && 'session' in msg ? handleTab(env.tabId, msg as TabRequest) : handleEngine(msg as EngineRequest);
  run.then(sendResponse, (e: Error) => sendResponse({ ok: false, reason: e.message }));
  return true;
});

/** State of the engine and player, for automated checks (reachable from extension pages only). */
function debugSnapshot() {
  const p = player;
  const w = p?.pdoc && p.currentWord() >= 0 ? p.pdoc.words[p.currentWord()] : null;
  return {
    crossOriginIsolated: self.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    engine: tts?.info ?? null,
    owner: sessions.owner,
    state: p?.state ?? null,
    rate: p?.rate ?? null,
    voice: p?.voice ?? null,
    word: p?.currentWord() ?? -1,
    wordText: w && p?.pdoc ? p.pdoc.doc.text.slice(w.start, w.end) : null,
    words: p?.pdoc?.words.length ?? 0,
    stats: p?.stats ?? null,
    snapshot: p?.ctx ? { ...p.debugSnapshot(), placed: undefined, segments: undefined } : null,
    contextState: p?.ctx?.state ?? null,
    wallMs: performance.timeOrigin + performance.now(),
  };
}

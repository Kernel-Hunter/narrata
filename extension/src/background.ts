// Service worker: context menus, keyboard shortcuts, injecting the content script on demand
// (activeTab, no host permissions) and routing messages between tabs and the offscreen document.
// It keeps no state of its own, so Chrome can stop and restart it at any time.

import { type Envelope, type PopupRequest, type PopupStatus, type TabCommand, type TabStatus, envelope, isEnvelope, looksLikePdf, restrictedReason, routeInBackground } from './protocol';
import { HIGHLIGHT_CSS } from './content/highlight-css';

const OFFSCREEN_URL = 'offscreen.html';
let creating: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Runs the on-device voice model in a worker and plays the speech it generates.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/** Send to the offscreen document (creating it if needed) and return its reply. */
async function toOffscreen(env: Envelope): Promise<unknown> {
  await ensureOffscreen();
  let lastError: unknown;
  // Right after creation the document may not be listening yet.
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const reply = await chrome.runtime.sendMessage(env);
      if (reply !== undefined) return reply;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 50));
    if (attempt === 10) await ensureOffscreen();
  }
  throw lastError instanceof Error ? lastError : new Error('The voice engine did not answer.');
}

async function toTab<T = unknown>(tabId: number, msg: unknown): Promise<T | undefined> {
  try {
    return (await chrome.tabs.sendMessage(tabId, envelope('tab', msg), { frameId: 0 })) as T;
  } catch {
    return undefined;
  }
}

async function flag(tabId: number, message: string | null) {
  // Kept for the popup, which cannot always see the tab's URL.
  await chrome.storage.session.set({ [`error:${tabId}`]: message }).catch(() => {});
  await chrome.action.setBadgeText({ tabId, text: message ? '!' : '' }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: message ? `Narrata: ${message}` : 'Narrata' }).catch(() => {});
  if (message) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#b4232f' }).catch(() => {});
}

function pdfMessage(): string {
  return 'This is a PDF. Open it in the Narrata web app to read it with highlighting.';
}

/** Inject the content script into the top frame once. Returns an error message on failure. */
async function ensureContent(tab: chrome.tabs.Tab): Promise<string | null> {
  const tabId = tab.id!;
  const reason = restrictedReason(tab.url);
  if (reason && tab.url) return reason;
  if (looksLikePdf(tab.url)) return pdfMessage();
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => !!(globalThis as unknown as { __narrata?: boolean }).__narrata,
    });
    if (!probe?.result) {
      await chrome.scripting.insertCSS({ target: { tabId, frameIds: [0] }, css: HIGHLIGHT_CSS });
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    }
    return null;
  } catch (e) {
    const text = String((e as Error)?.message ?? e);
    if (/pdf/i.test(tab.url ?? '')) return pdfMessage();
    if (/cannot be scripted|cannot access|chrome:\/\/|gallery|extensions gallery/i.test(text)) return 'Chrome does not let extensions read this page.';
    if (/permission/i.test(text)) return 'Click the Narrata button on this page first, then try again.';
    return `Narrata could not start on this page (${text}).`;
  }
}

/** Selected text in any frame Narrata may read (same-origin frames; activeTab covers those). */
async function selectionInFrames(tabId: number): Promise<string> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => getSelection()?.toString() ?? '',
    });
    return results.map((r) => (r.result as string) ?? '').find((t) => t.trim()) ?? '';
  } catch {
    return '';
  }
}

async function run(tab: chrome.tabs.Tab | undefined, command: TabCommand): Promise<string | null> {
  if (!tab?.id) return 'No tab to read.';
  const error = await ensureContent(tab);
  await flag(tab.id, error);
  if (error) return error;
  if (command.type === 'read' && command.mode === 'selection' && !command.text) {
    // The content script reads the top frame's selection; a selection inside a frame is read as text.
    const top = await toTab<boolean>(tab.id, { type: 'has-selection' });
    if (!top) {
      const text = await selectionInFrames(tab.id);
      if (text) command = { ...command, text };
    }
  }
  await toTab(tab.id, command);
  return null;
}

async function popupStatus(tabId: number): Promise<PopupStatus> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const url = tab?.url ?? '';
  const stored = ((await chrome.storage.session.get(`error:${tabId}`).catch(() => ({}))) as Record<string, string | null>)[`error:${tabId}`] ?? null;
  const restricted = tab?.url ? (restrictedReason(url) ?? (looksLikePdf(url) ? pdfMessage() : null)) : stored;
  const status = restricted ? undefined : await toTab<TabStatus>(tabId, { type: 'status' });
  let engine = null;
  let readingTab: number | null = null;
  try {
    // The engine reports what the saved voice needs (only the offscreen document's worker knows).
    const prefs = ((await chrome.storage.local.get('prefs')).prefs ?? {}) as { voice?: string; model?: 'auto' | 'compact' };
    engine = (await toOffscreen(envelope('offscreen', { type: 'engine-info', voice: prefs.voice, model: prefs.model }))) as PopupStatus['engine'];
    const s = (await toOffscreen(envelope('offscreen', { type: 'session-info' }))) as { tabId: number | null };
    readingTab = s.tabId;
  } catch {
    engine = null;
  }
  return { page: { restricted, url }, tab: status ?? null, engine, readingTab };
}

async function handlePopup(req: PopupRequest): Promise<unknown> {
  switch (req.type) {
    case 'status':
      return popupStatus(req.tabId);
    case 'command': {
      const tab = await chrome.tabs.get(req.tabId).catch(() => undefined);
      const cmd: TabCommand =
        req.command === 'read-page' ? { type: 'read', mode: 'page' } : req.command === 'read-selection' ? { type: 'read', mode: 'selection' } : req.command === 'toggle' ? { type: 'toggle' } : { type: 'stop' };
      if (cmd.type === 'stop') {
        await toTab(req.tabId, cmd);
        return { ok: true };
      }
      const error = await run(tab, cmd);
      return { ok: !error, error };
    }
    case 'download':
      return toOffscreen(envelope('offscreen', { type: 'download', model: req.model, voice: req.voice }));
    case 'prefs': {
      const cur = ((await chrome.storage.local.get('prefs')).prefs ?? {}) as object;
      await chrome.storage.local.set({ prefs: { ...cur, ...req.prefs } });
      return { ok: true };
    }
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isEnvelope(raw)) return false;
  // Extension pages (popup, offscreen document) can also sit in a tab; only content scripts speak for one.
  const extensionPage = !!sender.url?.startsWith(chrome.runtime.getURL(''));
  const route = routeInBackground(raw, extensionPage ? { url: sender.url } : { tabId: sender.tab?.id, frameId: sender.frameId, url: sender.url });
  switch (route.kind) {
    case 'offscreen':
      toOffscreen(route.env).then(sendResponse, (e: Error) => sendResponse({ ok: false, reason: e.message }));
      return true;
    case 'tab':
      void chrome.tabs.sendMessage(route.tabId, route.env, { frameId: 0 }).catch(() => {});
      return false;
    case 'self':
      if (!extensionPage) return false;
      handlePopup(raw.msg as PopupRequest).then(sendResponse, (e: Error) => sendResponse({ ok: false, error: e.message }));
      return true;
    default:
      return false;
  }
});

const MENU = {
  page: 'narrata-read-page',
  selection: 'narrata-read-selection',
  here: 'narrata-read-here',
} as const;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.page, title: 'Read this page', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU.selection, title: 'Read selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU.here, title: 'Start reading from here', contexts: ['page', 'selection', 'link'] });
  });
});

function clickMenu(info: Pick<chrome.contextMenus.OnClickData, 'menuItemId' | 'frameId' | 'selectionText'>, tab: chrome.tabs.Tab | undefined) {
  const inFrame = info.frameId !== undefined && info.frameId !== 0;
  const text = info.selectionText?.trim();
  // A selection inside a frame cannot be highlighted from the top frame, so it is read as text.
  if (info.menuItemId === MENU.page) return run(tab, { type: 'read', mode: 'page' });
  if (info.menuItemId === MENU.selection) return run(tab, { type: 'read', mode: 'selection', ...(inFrame && text ? { text } : {}) });
  return run(tab, inFrame && text ? { type: 'read', mode: 'selection', text } : { type: 'read', mode: 'here' });
}

function runCommand(command: string, tab: chrome.tabs.Tab | undefined) {
  if (command === 'read-page') return run(tab, { type: 'read', mode: 'page' });
  if (command === 'read-selection') return run(tab, { type: 'read', mode: 'selection' });
  if (command === 'toggle-reading') return run(tab, { type: 'toggle' });
  return Promise.resolve(null);
}

chrome.contextMenus.onClicked.addListener((info, tab) => void clickMenu(info, tab));
chrome.commands.onCommand.addListener((command, tab) => void runCommand(command, tab));

// Hooks for automated checks, in the test build only: a test runner cannot click Chrome's context
// menu or press extension shortcuts, so it calls the same handlers directly.
if (__NARRATA_TEST__) {
  (globalThis as unknown as { narrataTest: object }).narrataTest = {
    menu: async (menuItemId: string, tabId: number, extra: { frameId?: number; selectionText?: string } = {}) => clickMenu({ menuItemId, ...extra }, await chrome.tabs.get(tabId)),
    command: async (command: string, tabId: number) => runCommand(command, await chrome.tabs.get(tabId)),
    ensureOffscreen,
    offscreen: (msg: unknown) => toOffscreen(envelope('offscreen', msg)),
    popup: (req: PopupRequest) => handlePopup(req),
  };
}

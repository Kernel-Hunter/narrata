// Messages between the extension's parts.
//
//   content script  <->  service worker  <->  offscreen document (engine + audio)
//                              ^
//                            popup
//
// Every message travels in an envelope addressed to one part. chrome.runtime.sendMessage reaches
// every extension page at once (service worker, offscreen document, popup), so each part only
// handles envelopes addressed to it. Content scripts can only be reached with
// chrome.tabs.sendMessage, so messages for a tab go through the service worker, which adds or
// reads the tab id.

import type { PlayerState } from '../../src/audio/player';
import type { BlockRange } from '../../src/core/text';
import type { EngineInfo } from '../../src/engine/client';
import type { ModelChoice } from '../../src/engine/protocol';

export type Part = 'background' | 'offscreen' | 'popup' | 'tab';

export interface Envelope<M = unknown> {
  narrata: 1;
  to: Part;
  /** Tab the message is about (set by the service worker for content-script traffic). */
  tabId?: number;
  msg: M;
}

export function envelope<M>(to: Part, msg: M, tabId?: number): Envelope<M> {
  return tabId === undefined ? { narrata: 1, to, msg } : { narrata: 1, to, tabId, msg };
}

export function isEnvelope(x: unknown): x is Envelope {
  return !!x && typeof x === 'object' && (x as Envelope).narrata === 1 && typeof (x as Envelope).to === 'string' && 'msg' in (x as object);
}

/** What the content script sends to the engine to start reading. */
export interface DocPayload {
  text: string;
  blocks: BlockRange[];
  title: string;
  url: string;
}

export interface ReadingPrefs {
  voice: string;
  rate: number;
  model: ModelChoice;
}

/** Content script -> offscreen document (through the service worker). */
export type TabRequest =
  | { type: 'open'; session: number; doc: DocPayload; offset: number; prefs: ReadingPrefs; play: boolean }
  | { type: 'toggle'; session: number }
  | { type: 'pause'; session: number }
  | { type: 'skip'; session: number; delta: number }
  | { type: 'seek'; session: number; offset: number }
  | { type: 'rate'; session: number; rate: number }
  | { type: 'voice'; session: number; voice: string }
  | { type: 'download'; session: number; model: ModelChoice; voice?: string }
  | { type: 'close'; session: number };

/** Offscreen document -> content script (through the service worker). */
export type TabEvent =
  | { type: 'state'; session: number; state: PlayerState }
  | { type: 'word'; session: number; word: number }
  | { type: 'engine'; session: number; info: EngineInfo }
  | { type: 'error'; session: number; message: string }
  | { type: 'ended'; session: number; reason: 'other-tab' | 'closed' };

/** A tab event before the session id is filled in. */
export type TabEventBody = TabEvent extends infer E ? (E extends unknown ? Omit<E, 'session'> : never) : never;

/** Service worker -> content script. */
export type TabCommand =
  | { type: 'read'; mode: 'page' | 'selection' | 'here'; text?: string }
  | { type: 'toggle' }
  | { type: 'stop' }
  | { type: 'status' }
  | { type: 'has-selection' };

/** What a tab reports about itself (reply to `status`). */
export interface TabStatus {
  reading: boolean;
  title: string;
  state: PlayerState | 'needs-download' | 'idle';
  progress: number;
  method?: string;
}

/** Popup -> service worker. */
export type PopupRequest =
  | { type: 'status'; tabId: number }
  | { type: 'command'; tabId: number; command: 'read-page' | 'read-selection' | 'toggle' | 'stop' }
  | { type: 'download'; model: ModelChoice; voice?: string }
  | { type: 'prefs'; prefs: Partial<ReadingPrefs> };

export interface PopupStatus {
  page: { restricted: string | null; url: string };
  tab: TabStatus | null;
  engine: EngineInfo | null;
  /** Tab id of the session that currently owns the engine, if any. */
  readingTab: number | null;
}

/** Offscreen document -> service worker / popup. */
export type EngineRequest = { type: 'engine-info'; voice?: string; model?: ModelChoice } | { type: 'session-info' } | { type: 'download'; model: ModelChoice; voice?: string } | { type: 'debug' };

/** Offscreen document -> popup broadcast. */
export type PopupEvent = { type: 'engine'; info: EngineInfo } | { type: 'session'; tabId: number | null; state: PlayerState | null };

// ---- routing -------------------------------------------------------------------------------

export type Route =
  /** Forward to the offscreen document (creating it first), tagged with the sender's tab. */
  | { kind: 'offscreen'; env: Envelope }
  /** Forward to a tab's content script (top frame only). */
  | { kind: 'tab'; tabId: number; env: Envelope }
  /** Handle in the service worker. */
  | { kind: 'self' }
  /** Not for the service worker (another part will receive it directly). */
  | { kind: 'ignore' };

export interface SenderInfo {
  /** Tab of a content script sender. */
  tabId?: number;
  frameId?: number;
  /** URL of an extension page sender. */
  url?: string;
}

/**
 * Where the service worker sends an envelope. Content scripts address the offscreen document
 * through the service worker; the offscreen document addresses tabs through it. Only the top
 * frame of a tab may drive a reading session.
 */
export function routeInBackground(env: Envelope, sender: SenderInfo): Route {
  const fromTab = sender.tabId !== undefined;
  if (fromTab && sender.frameId !== undefined && sender.frameId !== 0) return { kind: 'ignore' };
  if (env.to === 'background') {
    // A content script asking for the engine: re-address it with its own tab id. A tab can never
    // speak for another tab.
    if (fromTab && isTabRequest(env.msg)) return { kind: 'offscreen', env: envelope('offscreen', env.msg, sender.tabId) };
    return { kind: 'self' };
  }
  if (env.to === 'tab') {
    if (fromTab || env.tabId === undefined) return { kind: 'ignore' };
    return { kind: 'tab', tabId: env.tabId, env: envelope('tab', env.msg) };
  }
  return { kind: 'ignore' };
}

const TAB_REQUESTS = new Set(['open', 'toggle', 'pause', 'skip', 'seek', 'rate', 'voice', 'download', 'close']);

export function isTabRequest(m: unknown): m is TabRequest {
  return !!m && typeof m === 'object' && TAB_REQUESTS.has((m as TabRequest).type) && typeof (m as TabRequest).session === 'number';
}

// ---- restricted pages ----------------------------------------------------------------------

/** Why Narrata cannot run on a page, or null when it can. */
export function restrictedReason(url: string | undefined): string | null {
  if (!url) return 'Narrata cannot read this tab.';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Narrata cannot read this tab.';
  }
  const host = u.hostname;
  if (/^(chrome|edge|brave|opera|vivaldi|about|chrome-untrusted|devtools|view-source|chrome-search)$/.test(u.protocol.slice(0, -1))) {
    return 'Chrome does not let extensions read its own pages (settings, new tab, extensions).';
  }
  if (u.protocol === 'chrome-extension:' || u.protocol === 'extension:') return 'Extensions cannot read pages of other extensions.';
  if (host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && u.pathname.startsWith('/webstore')) || host === 'microsoftedge.microsoft.com') {
    return 'Chrome does not let extensions read the Web Store.';
  }
  if (u.protocol === 'file:') return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Narrata can only read web pages.';
  return null;
}

/** True for URLs Chrome opens in its own PDF viewer, which extensions cannot read. */
export function looksLikePdf(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// ---- sessions ------------------------------------------------------------------------------

/**
 * The offscreen document reads for one tab at a time. Events produced for an older session (a
 * chunk that finished generating after the user switched tabs, or a word from before a restart)
 * must not reach the new owner's page, and requests from a tab that lost the engine are refused.
 */
export class SessionTable {
  owner: { tabId: number; session: number } | null = null;

  /** Make (tabId, session) the owner. Returns the previous owner if it was a different tab or session. */
  claim(tabId: number, session: number): { tabId: number; session: number } | null {
    const prev = this.owner;
    this.owner = { tabId, session };
    if (prev && (prev.tabId !== tabId || prev.session !== session)) return prev;
    return null;
  }

  /** True when a request from this tab and session may drive the engine. */
  accepts(tabId: number, session: number): boolean {
    return !!this.owner && this.owner.tabId === tabId && this.owner.session === session;
  }

  /** Address an event for the owning tab, or null if nobody owns the engine. */
  address(event: TabEventBody): Envelope<TabEvent> | null {
    if (!this.owner) return null;
    return envelope('tab', { ...event, session: this.owner.session } as TabEvent, this.owner.tabId);
  }

  release(tabId: number, session: number): boolean {
    if (!this.accepts(tabId, session)) return false;
    this.owner = null;
    return true;
  }
}

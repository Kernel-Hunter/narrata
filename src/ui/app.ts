import { Player, type PlaybackDoc, type PlayerState } from '../audio/player';
import { MERGE_CHARS, type PlanOptions, documentSentences, planChunks } from '../core/chunker';
import { estimateSeconds, formatBytes, formatDate, formatRate, formatRemaining } from '../core/format';
import { recommendVoice, shouldOfferFastVoice, type VoiceKind } from '../core/device';
import { lastAtOrBefore, tokenizeWords, wordIndexAt } from '../core/text';
import { ACCEPT, loadFile, loadPastedText } from '../docs';
import type { LoadedDoc } from '../docs/types';
import { TtsClient, type EngineInfo } from '../engine/client';
import { downloadSize, type Variant } from '../engine/model-store';
import type { Tuning } from '../engine/protocol';
import { DEFAULT_VOICE, PIPER_VOICES, VOICES, accentLabel, fastVoiceFor, isPiper, voiceById } from '../engine/voices';
import { Library, type DocMeta } from '../store/library';
import { loadSettings, saveSettings, type Settings } from '../store/settings';
import { h, isTypingTarget, prefersReducedMotion } from './dom';
import { icons, logo } from './icons';
import { Popover, sheet, toast } from './overlay';
import { PlayerBar } from './player-bar';
import { ReaderView } from './reader-view';
import { SAMPLE_TEXT, SAMPLE_TITLE } from './sample';
import type { DocView } from './views';

interface OpenDoc {
  meta: DocMeta | null;
  loaded: LoadedDoc;
  pdoc: PlaybackDoc;
  view: DocView;
}

/**
 * Engine overrides for measurements: ?debug&threads=2&variant=fp32&build=webgpu&opt=basic&exec=parallel.
 * ?debug&failgpu treats every graphics chip result as bad audio, to check the fallback.
 */
function tuningFromUrl(): Tuning | undefined {
  const q = new URLSearchParams(location.search);
  if (!import.meta.env.DEV && !q.has('debug')) return undefined;
  const t: Tuning = {};
  const threads = Number(q.get('threads'));
  if (threads > 0) t.threads = threads;
  const variant = q.get('variant');
  if (variant) t.variant = variant as Variant;
  const build = q.get('build');
  if (build === 'wasm' || build === 'webgpu') t.build = build;
  const opt = q.get('opt');
  const exec = q.get('exec');
  if (opt || exec) t.session = { graphOptimizationLevel: (opt ?? undefined) as 'all' | undefined, executionMode: (exec ?? undefined) as 'parallel' | undefined };
  if (q.has('failgpu')) t.failGpu = true;
  return t;
}

/** Chunk plan override for measurements: ?debug&plan=sentences|ramp|merge */
function planFromUrl(): PlanOptions | null {
  const q = new URLSearchParams(location.search);
  if (!import.meta.env.DEV && !q.has('debug')) return null;
  const p = q.get('plan');
  return p === 'sentences' ? {} : p === 'ramp' ? { ramp: true } : p === 'merge' ? { merge: MERGE_CHARS } : null;
}

const KIND_BADGE: Record<string, string> = { text: 'TXT', markdown: 'MD', html: 'WEB', pdf: 'PDF', epub: 'EPUB' };
const LAST_DOC = 'narrata.lastDoc';
const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export class App {
  settings: Settings = loadSettings();
  readonly tts: TtsClient;
  readonly player: Player;
  readonly library = new Library();
  private bar: PlayerBar;
  private topbar: HTMLElement;
  private titleEl: HTMLElement;
  private stage: HTMLElement;
  private backPill: HTMLButtonElement;
  private fileInput: HTMLInputElement;
  private tocBtn: HTMLButtonElement;
  private viewBtn: HTMLButtonElement;
  private doc: OpenDoc | null = null;
  private follow = true;
  private autoScrollUntil = 0;
  private saveTimer = 0;
  private heroTimer = 0;
  private wantPlay = false;
  private voicePop: Popover;
  private speedPop: Popover;
  private volumePop: Popover;
  private typePop: Popover;
  private morePop: Popover;
  private tocPop: Popover;
  private previewing: { id: string; playing: boolean } | null = null;
  private recent: DocMeta[] = [];

  constructor(root: HTMLElement) {
    this.applyAppearance();
    this.tts = new TtsClient(this.settings.model, this.settings.voice, tuningFromUrl());
    this.player = new Player(this.tts, {
      onState: (s) => this.onPlayerState(s),
      onWord: (w) => this.onWord(w),
      onError: (m) => toast(m, { error: true }),
    });
    this.player.planOverride = planFromUrl();
    this.player.onWait = () => {
      this.updateMeta();
      this.maybeOfferFastVoice();
    };
    this.player.rate = this.settings.rate;
    this.player.volume = this.settings.volume;
    this.player.voice = this.settings.voice;

    this.fileInput = h('input', { type: 'file', accept: ACCEPT, hidden: true }) as HTMLInputElement;
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) void this.openFile(f);
    });

    this.titleEl = h('div', { class: 'bar-title' });
    this.tocBtn = h('button', { class: 'icon-btn', 'aria-label': 'Contents', title: 'Contents', html: icons.list, hidden: true, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }) as HTMLButtonElement;
    this.viewBtn = h('button', { class: 'icon-btn', 'aria-label': 'Show as text', title: 'Switch between page and text view', html: icons.text, hidden: true }) as HTMLButtonElement;
    const openBtn = h('button', { class: 'icon-btn', 'aria-label': 'Open a file', title: 'Open a file (Ctrl+O)', html: icons.plus, onclick: () => this.fileInput.click() });
    const typeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Reading settings', title: 'Reading settings', html: icons.type, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }) as HTMLButtonElement;
    const moreBtn = h('button', { class: 'icon-btn', 'aria-label': 'More', title: 'More', html: icons.more, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }) as HTMLButtonElement;
    this.topbar = h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'brand', 'aria-label': 'Narrata, home', onclick: () => this.goHome() }, h('span', { html: logo }).firstChild!, 'Narrata'),
      this.titleEl,
      h('nav', { class: 'top-actions', 'aria-label': 'Document' }, this.tocBtn, this.viewBtn, openBtn, typeBtn, moreBtn),
    );
    this.stage = h('main', { class: 'stage', id: 'main' });
    this.backPill = h('button', { class: 'back-pill', hidden: true, html: `${icons.chevronDown}<span>Back to current</span>` }) as HTMLButtonElement;
    this.backPill.addEventListener('click', () => {
      this.follow = true;
      this.backPill.hidden = true;
      this.scrollToCurrent(true);
    });

    this.bar = new PlayerBar({
      onToggle: () => void this.togglePlay(),
      onPrev: () => this.skip(-1),
      onNext: () => this.skip(1),
      onSeek: (f, commit) => this.seekFraction(f, commit),
      onVoice: (a) => this.voicePop.toggle(a),
      onSpeed: (a) => this.speedPop.toggle(a),
      onVolume: (a) => this.volumePop.toggle(a),
    });
    this.bar.setVoice(voiceById(this.settings.voice));
    this.bar.setRate(this.settings.rate);
    this.bar.setVolume(this.settings.volume);

    this.voicePop = new Popover('Voice', () => this.voiceMenu());
    this.speedPop = new Popover('Speed', () => this.speedMenu());
    this.volumePop = new Popover('Volume', () => this.volumeMenu());
    this.typePop = new Popover('Reading settings', () => this.typeMenu());
    this.morePop = new Popover('More', () => this.moreMenu());
    this.tocPop = new Popover('Contents', () => this.tocMenu());
    typeBtn.addEventListener('click', () => this.typePop.toggle(typeBtn));
    moreBtn.addEventListener('click', () => this.morePop.toggle(moreBtn));
    this.tocBtn.addEventListener('click', () => this.tocPop.toggle(this.tocBtn));
    this.viewBtn.addEventListener('click', () => this.togglePdfMode());

    root.append(this.topbar, this.stage, this.backPill, this.bar.el, this.fileInput);
    this.tts.subscribe((info) => this.onEngine(info));
    this.recheckWhenVisible();
    this.bindGlobalEvents();
    this.setupMediaSession();
    void this.start();
  }

  // ---- startup -------------------------------------------------------------

  private async start() {
    this.recent = await this.library.list().catch(() => []);
    const last = localStorage.getItem(LAST_DOC);
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.has('sample')) return this.openSample();
    if (last && this.recent.some((d) => d.id === last)) {
      await this.openFromLibrary(last);
      return;
    }
    this.renderWelcome();
  }

  private applyAppearance() {
    const s = this.settings;
    const root = document.documentElement;
    if (s.theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = s.theme;
    if (s.font === 'serif') delete root.dataset.font;
    else root.dataset.font = s.font;
    root.style.setProperty('--reading-size', `${s.fontSize}px`);
    root.style.setProperty('--reading-leading', String(s.lineHeight));
    const dark = s.theme === 'dark' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#0f1114' : '#f5f6f8'));
    if (s.font === 'dyslexic') void import('@fontsource/opendyslexic/400.css');
  }

  private save() {
    saveSettings(this.settings);
  }

  // ---- engine --------------------------------------------------------------

  private engineLine(info: EngineInfo): string {
    if (info.state === 'downloading' && info.download) return `Downloading voice ${Math.floor((info.download.loaded / info.download.total) * 100)}%`;
    if (info.state === 'loading') return info.stage ?? 'Preparing the voice';
    if (info.state === 'error') return 'Voice unavailable';
    if (info.voiceDownload) {
      const v = voiceById(info.voiceDownload.voice);
      return `Downloading ${isPiper(v) ? v.name : 'the natural voice'} ${Math.floor((info.voiceDownload.loaded / Math.max(1, info.voiceDownload.total)) * 100)}%`;
    }
    if (info.state === 'ready') return isPiper(voiceById(this.settings.voice)) ? 'Fast voice · on this device' : `On this device · ${info.device === 'webgpu' ? 'graphics chip' : 'processor'}`;
    if (info.state === 'needs-download') return 'Voice not downloaded yet';
    return '';
  }

  private onEngine(info: EngineInfo) {
    if (info.state === 'loading' && !info.stage && info.status && info.status.plan.missingBytes === 0) {
      // Everything is stored: load right away so the first play is fast.
      void this.tts.prepare(this.settings.model, this.settings.voice).catch(() => {});
    }
    this.updateVoiceCard();
    this.updateMeta();
    if (info.state === 'ready' && this.wantPlay) {
      this.wantPlay = false;
      void this.playNow();
    }
    if (info.state === 'error' && this.wantPlay) {
      this.wantPlay = false;
      this.bar.setMode('play');
      toast(info.error ?? 'The voice could not start.', { error: true });
    }
    if (info.fallback && info.fallback !== this.lastFallback) {
      this.lastFallback = info.fallback;
      toast('Your graphics chip produced bad audio, so Narrata switched to the processor.');
    }
  }
  private lastFallback?: string;

  /** Download size of the selected voice (what is still missing), or of the model for `choice`. */
  private sizeFor(choice: 'auto' | 'compact' = this.settings.model): number {
    const s = this.tts.info.status;
    if (!s) return downloadSize(choice === 'compact' ? 'uint8' : 'fp32');
    if (choice === this.settings.model) return s.plan.missingBytes || s.plan.bytes;
    return downloadSize(choice === 'compact' || !s.hasWebGPU ? 'uint8' : 'fp32');
  }

  /**
   * Browsers run hidden tabs at low priority (on a Mac, on the efficiency cores), so a speed test
   * made while the tab was opened in the background reads several times too slow. If the tab was
   * hidden at start, check again once it has been visible for a moment.
   */
  private recheckWhenVisible() {
    if (!document.hidden) return;
    const onVisible = () => {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVisible);
      setTimeout(() => {
        if (this.isFirstRun()) void this.tts.probe();
      }, 500);
    };
    document.addEventListener('visibilitychange', onVisible);
  }

  /** Nothing is stored yet: offer the choice between the natural and the fast voice. */
  private isFirstRun(): boolean {
    const s = this.tts.info.status;
    return !!s && s.storedBytes === 0 && this.tts.info.state === 'needs-download';
  }

  private async startDownload(choice: 'auto' | 'compact' = this.settings.model) {
    if (choice !== this.settings.model) {
      this.settings.model = choice;
      this.save();
    }
    try {
      await this.tts.prepare(choice, this.settings.voice);
    } catch (e) {
      toast(`Download stopped: ${(e as Error).message}`, { error: true, action: 'Retry', onAction: () => void this.startDownload(choice) });
    }
  }

  /** First-run choice: select a voice of that kind and download it. */
  private pickVoiceKind(kind: VoiceKind, choice: 'auto' | 'compact' = this.settings.model) {
    const current = voiceById(this.settings.voice);
    const id = kind === 'fast' ? (isPiper(current) ? current.id : fastVoiceFor(current).id) : isPiper(current) ? DEFAULT_VOICE : current.id;
    if (id !== this.settings.voice) {
      this.settings.voice = id;
      this.save();
      this.bar.setVoice(voiceById(id));
      this.player.setVoice(id);
    }
    void this.startDownload(choice);
  }

  /**
   * The first-run card: the natural voice or the fast one, with the size of each and a suggestion
   * from the device check made by the worker (see recommendVoice).
   */
  private voiceChoice(onPick: (kind: VoiceKind, choice?: 'auto' | 'compact') => void): HTMLElement {
    const s = this.tts.info.status!;
    const advice = s.probe ? recommendVoice(s.probe) : null;
    const natural = s.kokoro.missingBytes || s.kokoro.bytes;
    const fast = fastVoiceFor(voiceById(this.settings.voice));
    const fastSize = fast.bytes + fast.configBytes;
    const option = (kind: VoiceKind, title: string, size: number, text: string) =>
      h(
        'button',
        { class: 'choice', 'data-kind': kind, 'aria-describedby': 'choice-reason', onclick: () => onPick(kind) },
        h('span', { class: 'choice-head' }, h('span', { class: 'choice-title' }, title), advice?.pick === kind ? h('span', { class: 'choice-badge' }, 'Recommended') : null),
        h('span', { class: 'choice-text' }, text),
        h('span', { class: 'choice-size', html: `${icons.download}<span>Download ${formatBytes(size)}</span>` }),
      );
    return h(
      'div',
      { class: 'choice-wrap' },
      h(
        'div',
        { class: 'choice-row' },
        option('natural', 'Natural voice', natural, 'Best quality. 28 voices. Needs a fairly recent computer.'),
        option('fast', 'Fast voice', fastSize, 'Works on any computer. Sounds less natural. 3 voices.'),
      ),
      h('p', { class: 'choice-reason', id: 'choice-reason' }, advice ? advice.reason : 'Checking how fast this computer is.', ' You can switch voices later in the voice menu.'),
      s.hasWebGPU && this.settings.model === 'auto'
        ? h('button', { class: 'btn btn-quiet choice-compact', onclick: () => onPick('natural', 'compact') }, `Natural voice, smaller download (${formatBytes(downloadSize('uint8'))}), runs on the processor`)
        : null,
    );
  }

  private confirmDownload(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = this.tts.info.status;
      const size = formatBytes(this.sizeFor());
      let decided = false;
      const done = (v: boolean, choice?: 'auto' | 'compact') => {
        decided = true;
        close();
        if (v) void this.startDownload(choice);
        resolve(v);
      };
      const fast = isPiper(voiceById(this.settings.voice));
      const body: Node[] = this.isFirstRun()
        ? [
            h('p', { class: 'sheet-text' }, 'Narrata reads with a voice that runs on this device. Pick one to download once; it is stored in this browser for offline use.'),
            this.voiceChoice((kind, choice) => {
              decided = true;
              close();
              this.pickVoiceKind(kind, choice);
              resolve(true);
            }),
            h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', onclick: () => done(false) }, 'Not now')),
          ]
        : [
            h(
              'p',
              { class: 'sheet-text' },
              fast
                ? `The fast voice runs on this device. It is a one-time download of ${size}, stored in this browser for offline use.`
                : `Narrata reads with Kokoro, an open voice model that runs on this device. It is a one-time download of ${size}, stored in this browser for offline use.`,
            ),
            h(
              'div',
              { class: 'sheet-actions' },
              !fast && s?.hasWebGPU && this.settings.model === 'auto' ? h('button', { class: 'btn btn-quiet', onclick: () => done(true, 'compact') }, `Use the smaller model (${formatBytes(downloadSize('uint8'))})`) : null,
              h('button', { class: 'btn', onclick: () => done(false) }, 'Not now'),
              h('button', { class: 'btn btn-primary', html: `${icons.download}<span>Download ${size}</span>`, onclick: () => done(true, this.settings.model) }),
            ),
          ];
      const { close } = sheet(this.isFirstRun() ? 'Choose a voice' : 'Download the voice', body, { onClose: () => !decided && resolve(false) });
    });
  }

  // ---- welcome -------------------------------------------------------------

  private voiceCard: HTMLElement | null = null;

  private renderWelcome() {
    this.closeDoc();
    // Nothing to play yet: the player appears with the first document.
    this.bar.el.hidden = true;
    document.title = 'Narrata';
    const words = 'Reads anything aloud with a natural voice that runs on your device.'.split(' ');
    const hero = h('h1', { class: 'hero-line' }, ...words.flatMap((w, i) => [h('span', { class: 'w' }, w), i < words.length - 1 ? ' ' : '']));
    this.voiceCard = h('section', { class: 'voice-card', 'aria-live': 'polite' });
    const list = this.recent.length
      ? [h('h2', { class: 'section-label' }, 'Recent'), this.docList(this.recent)]
      : [];
    const welcome = h(
      'section',
      { class: 'welcome' },
      hero,
      h('p', { class: 'hero-sub' }, 'PDFs, books, web pages and notes, read with the current word highlighted. Free, private, and it keeps working offline.'),
      this.voiceCard,
      h(
        'div',
        { class: 'start-actions' },
        h('button', { class: 'btn btn-primary', html: `${icons.sparkle}<span>Try a sample</span>`, onclick: () => this.openSample() }),
        h('button', { class: 'btn', html: `${icons.file}<span>Open a file</span>`, onclick: () => this.fileInput.click() }),
        h('button', { class: 'btn', html: `${icons.paste}<span>Paste text</span>`, onclick: () => this.pasteDialog() }),
      ),
      h('p', { class: 'drop-hint' }, 'You can also drop a PDF, EPUB, web page, Markdown or text file anywhere on this page.'),
      ...list,
      h('p', { class: 'privacy-note', html: `${icons.lock}<span>Your files and the voice stay on this device. Narrata has no account, no server and no analytics.</span>` }),
    );
    this.stage.replaceChildren(welcome);
    this.updateVoiceCard();
    this.animateHero(hero);
    this.updateMeta();
  }

  private animateHero(hero: HTMLElement) {
    clearTimeout(this.heroTimer);
    const spans = Array.from(hero.querySelectorAll<HTMLElement>('.w'));
    if (prefersReducedMotion()) return;
    let i = 0;
    const step = () => {
      if (!hero.isConnected) return;
      spans.forEach((s, k) => s.classList.toggle('on', k === i));
      i++;
      if (i > spans.length) {
        i = 0;
        this.heroTimer = window.setTimeout(step, 2200);
      } else this.heroTimer = window.setTimeout(step, 260 + spans[i - 1].textContent!.length * 18);
    };
    this.heroTimer = window.setTimeout(step, 700);
  }

  private updateVoiceCard() {
    const card = this.voiceCard;
    if (!card || !card.isConnected) return;
    const info = this.tts.info;
    const head = (title: string, text: string, icon = icons.speaker) =>
      h('div', { class: 'voice-card-head' }, h('span', { class: 'voice-card-icon', html: icon }), h('div', {}, h('p', { class: 'voice-card-title' }, title), h('p', { class: 'voice-card-text' }, text)));
    const s = info.status;
    switch (info.state) {
      case 'starting':
        card.replaceChildren(head('Checking this device', 'One moment.'));
        break;
      case 'needs-download': {
        if (this.isFirstRun()) {
          card.replaceChildren(
            head('Choose a voice', 'Downloaded once and stored on this device, so it works offline. Nothing you read is uploaded.'),
            this.voiceChoice((kind, choice) => this.pickVoiceKind(kind, choice)),
          );
          break;
        }
        const size = formatBytes(this.sizeFor());
        const fast = isPiper(voiceById(this.settings.voice));
        card.replaceChildren(
          head(fast ? 'Download the fast voice once' : 'Download the voice once', `${size}, stored on this device so it works offline. Nothing you read is uploaded.`),
          h(
            'div',
            { class: 'voice-card-actions' },
            h('button', { class: 'btn btn-primary', html: `${icons.download}<span>Download voice (${size})</span>`, onclick: () => void this.startDownload() }),
            !fast && s?.hasWebGPU && this.settings.model === 'auto' ? h('button', { class: 'btn btn-quiet', onclick: () => void this.startDownload('compact') }, `Smaller model (${formatBytes(downloadSize('uint8'))}), slower`) : null,
          ),
        );
        break;
      }
      case 'downloading': {
        const d = info.download;
        const pct = d && d.total ? d.loaded / d.total : 0;
        const elapsed = d ? (performance.now() - d.startedAt) / 1000 : 0;
        const eta = d && pct > 0.02 && elapsed > 2 ? (elapsed / pct) * (1 - pct) : NaN;
        const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Voice download', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct * 100) }, h('span', {}));
        (bar.firstChild as HTMLElement).style.width = `${pct * 100}%`;
        card.replaceChildren(
          head('Downloading the voice', 'You can keep this tab open and start reading as soon as it finishes.', icons.download),
          bar,
          h('div', { class: 'progress-meta' }, h('span', {}, d ? `${formatBytes(d.loaded)} of ${formatBytes(d.total)}` : 'Starting'), h('span', {}, isFinite(eta) ? formatRemaining(eta) : '')),
        );
        break;
      }
      case 'loading':
        card.replaceChildren(head(info.stage ?? 'Preparing the voice', 'This takes a few seconds.', icons.spinner));
        break;
      case 'ready':
        card.replaceChildren(
          info.engine === 'piper'
            ? head('Fast voice ready', 'Runs on this device. Pick a sample or open a file. The natural voices are in the voice menu.', icons.check)
            : head('Voice ready', `Runs on this device's ${info.device === 'webgpu' ? 'graphics chip' : 'processor'}. Pick a sample or open a file.`, icons.check),
        );
        break;
      case 'error':
        card.replaceChildren(
          head('The voice could not start', info.error ?? 'Unknown error', icons.info),
          h('div', { class: 'voice-card-actions' }, h('button', { class: 'btn', onclick: () => void this.startDownload() }, 'Try again')),
        );
        break;
    }
  }

  private docList(docs: DocMeta[]): HTMLElement {
    return h(
      'ul',
      { class: 'doc-list' },
      ...docs.map((d) =>
        h(
          'li',
          { class: 'doc-row' },
          h('button', { class: 'doc-open', 'aria-label': `Open ${d.title}`, onclick: () => void this.openFromLibrary(d.id) }),
          h('span', { class: 'doc-badge', 'aria-hidden': 'true' }, KIND_BADGE[d.kind] ?? 'DOC'),
          h(
            'div',
            { class: 'doc-info' },
            h('div', { class: 'doc-name' }, d.title),
            h(
              'div',
              { class: 'doc-sub' },
              h('span', { class: 'doc-bar', 'aria-hidden': 'true' }, h('span', { style: `width:${Math.round(d.progress * 100)}%` })),
              h('span', {}, `${Math.round(d.progress * 100)}% · ${formatDate(d.openedAt)}`),
            ),
          ),
          h('button', { class: 'icon-btn doc-delete', 'aria-label': `Remove ${d.title}`, title: 'Remove from library', html: icons.trash, onclick: () => void this.removeDoc(d) }),
        ),
      ),
    );
  }

  private async removeDoc(d: DocMeta) {
    const full = await this.library.get(d.id);
    await this.library.remove(d.id);
    this.recent = await this.library.list();
    if (this.doc?.meta?.id === d.id) this.goHome();
    else if (!this.doc) this.renderWelcome();
    toast(`Removed “${d.title}”.`, {
      action: 'Undo',
      onAction: async () => {
        if (!full) return;
        await this.library.add(full.content, full.meta.openedAt);
        await this.library.savePosition(d.id, full.meta.position, full.meta.openedAt);
        this.recent = await this.library.list();
        if (!this.doc) this.renderWelcome();
      },
    });
  }

  private goHome() {
    this.player.stop();
    localStorage.removeItem(LAST_DOC);
    void this.library.list().then((r) => {
      this.recent = r;
      this.renderWelcome();
    });
  }

  // ---- opening documents ---------------------------------------------------

  async openFile(file: File) {
    this.stage.replaceChildren(h('div', { class: 'loading-doc', html: `${icons.spinner}<span>Opening ${file.name}</span>` }));
    try {
      const loaded = await loadFile(file);
      const meta = await this.library.add(loaded).catch(() => null);
      this.open(loaded, meta);
    } catch (e) {
      toast((e as Error).message || `Could not open ${file.name}.`, { error: true });
      if (!this.doc) this.renderWelcome();
    }
  }

  async openText(text: string, title?: string) {
    if (!text.trim()) return;
    const loaded = loadPastedText(text, title);
    const meta = await this.library.add(loaded).catch(() => null);
    this.open(loaded, meta);
  }

  openSample() {
    void this.openText(SAMPLE_TEXT, SAMPLE_TITLE);
  }

  async openFromLibrary(id: string) {
    const rec = await this.library.get(id);
    if (!rec) {
      toast('That document is no longer in the library.', { error: true });
      return this.renderWelcome();
    }
    const meta = await this.library.savePosition(id, rec.meta.position);
    this.open(rec.content, meta ?? rec.meta);
  }

  private closeDoc() {
    if (this.doc) {
      this.doc.view.destroy();
      this.doc = null;
    }
    this.player.stop();
    this.titleEl.textContent = '';
    this.tocBtn.hidden = true;
    this.viewBtn.hidden = true;
    this.backPill.hidden = true;
  }

  private async makeView(loaded: LoadedDoc): Promise<DocView> {
    const seek = (off: number) => this.seekTo(off);
    const words = tokenizeWords(loaded.doc.text).length;
    const minutes = Math.max(1, Math.round(estimateSeconds(words, 1) / 60));
    const subtitle = `${KIND_BADGE[loaded.kind] ?? 'Text'} · ${minutes} min listen`;
    if (loaded.kind === 'pdf' && loaded.pdfMap && loaded.pdfPages && loaded.source && this.settings.pdfMode === 'page') {
      const { PdfView } = await import('./pdf-view');
      return new PdfView(loaded.doc, loaded.pdfMap, loaded.pdfPages, loaded.source, seek);
    }
    return new ReaderView(loaded.doc, { title: loaded.title, author: loaded.author, subtitle }, seek);
  }

  private async open(loaded: LoadedDoc, meta: DocMeta | null) {
    this.closeDoc();
    clearTimeout(this.heroTimer);
    const sentences = documentSentences(loaded.doc);
    const pdoc: PlaybackDoc = { doc: loaded.doc, words: tokenizeWords(loaded.doc.text), sentences, chunks: planChunks(loaded.doc, sentences) };
    const view = await this.makeView(loaded);
    this.doc = { meta, loaded, pdoc, view };
    this.bar.el.hidden = false;
    this.stage.replaceChildren(view.el);
    this.titleEl.textContent = loaded.title;
    document.title = `${loaded.title} · Narrata`;
    this.tocBtn.hidden = loaded.doc.chapters.length < 2;
    this.viewBtn.hidden = loaded.kind !== 'pdf';
    this.updateViewBtn();
    if (meta) localStorage.setItem(LAST_DOC, meta.id);
    this.player.load(pdoc);
    this.follow = true;
    const pos = meta?.position ?? 0;
    this.player.setPosition(pos);
    window.scrollTo({ top: 0 });
    if (pos > 0) {
      await view.ensureVisible(pos);
      requestAnimationFrame(() => this.scrollToCurrent(false));
    }
    this.setMediaMetadata();
    this.updateMeta();
  }

  private updateViewBtn() {
    const page = this.settings.pdfMode === 'page';
    this.viewBtn.innerHTML = page ? icons.text : icons.page;
    this.viewBtn.setAttribute('aria-label', page ? 'Show as text' : 'Show pages');
  }

  private async togglePdfMode() {
    if (!this.doc || this.doc.loaded.kind !== 'pdf') return;
    this.settings.pdfMode = this.settings.pdfMode === 'page' ? 'text' : 'page';
    this.save();
    this.updateViewBtn();
    const old = this.doc.view;
    const view = await this.makeView(this.doc.loaded);
    old.destroy();
    this.doc.view = view;
    this.stage.replaceChildren(view.el);
    const off = this.player.currentOffset();
    await view.ensureVisible(off);
    requestAnimationFrame(() => {
      this.onWord(this.player.currentWord(), true);
      this.scrollToCurrent(false);
    });
  }

  // ---- playback ------------------------------------------------------------

  private async togglePlay() {
    if (!this.doc) {
      this.openSample();
      return;
    }
    const st = this.player.state;
    if (st === 'playing' || st === 'buffering' || st === 'loading') {
      this.player.pause();
      return;
    }
    if (this.wantPlay) {
      this.wantPlay = false;
      this.bar.setMode('play');
      return;
    }
    // Create the audio context inside the click, before any await.
    const audio = this.player.ensureAudio();
    if (!this.tts.ready) {
      const info = this.tts.info;
      if (info.state === 'needs-download' || info.state === 'error') {
        const ok = await this.confirmDownload();
        if (!ok) return;
      }
      this.wantPlay = true;
      this.bar.setMode('busy');
      await audio;
      return;
    }
    await audio;
    await this.playNow();
  }

  private async playNow() {
    this.follow = true;
    if (this.player.state === 'ended') await this.player.playFrom(0);
    else await this.player.resume();
  }

  private seekTo(offset: number) {
    if (!this.doc) return;
    this.follow = true;
    this.backPill.hidden = true;
    if (!this.tts.ready) {
      this.player.setPosition(offset);
      void this.togglePlay();
      return;
    }
    void this.player.ensureAudio();
    void this.player.playFrom(offset);
  }

  private seekFraction(f: number, commit: boolean) {
    if (!this.doc) return;
    const words = this.doc.pdoc.words;
    const target = words[Math.min(words.length - 1, Math.floor(f * words.length))];
    if (!target) return;
    if (!commit) {
      this.bar.setStatus(this.engineLine(this.tts.info), this.remainingText(words.indexOf(target)));
      return;
    }
    const active = ['playing', 'buffering', 'loading'].includes(this.player.state);
    this.follow = true;
    if (active) void this.player.playFrom(target.start);
    else this.player.setPosition(target.start);
    this.scrollToCurrent(true);
  }

  private skip(delta: number) {
    if (!this.doc) return;
    this.follow = true;
    this.player.skipSentence(delta);
    this.scrollToCurrent(true);
  }

  private setRate(r: number) {
    r = Math.round(Math.min(3, Math.max(0.5, r)) * 100) / 100;
    this.settings.rate = r;
    this.save();
    this.player.setRate(r);
    this.bar.setRate(r);
    this.updateMeta();
    if (this.speedPop.open) this.speedPop.render();
  }

  private setVoice(id: string) {
    const previous = this.settings.voice;
    this.settings.voice = id;
    this.save();
    this.bar.setVoice(voiceById(id));
    const info = this.tts.info;
    if (info.state === 'needs-download' || info.state === 'error' || info.state === 'starting') {
      // Nothing is loaded yet: download nothing now, show what this voice needs instead.
      this.player.setVoice(id);
      void this.tts.select(this.settings.model, id);
      if (this.voicePop.open) this.voicePop.render();
      return;
    }
    const v = voiceById(id);
    const kokoro = info.status?.kokoro;
    if (!isPiper(v) && info.engine === 'piper' && kokoro && kokoro.missingBytes > 0) {
      toast(`Downloading the natural voice (${formatBytes(kokoro.missingBytes)}). The fast voice keeps reading until it is ready.`);
    }
    this.tts
      .ensureVoice(id)
      .then(() => {
        if (this.settings.voice === id) this.player.setVoice(id);
      })
      .catch((e: Error) => {
        toast(`Could not load ${voiceById(id).name}: ${e.message}`, { error: true });
        if (this.settings.voice !== id) return;
        this.settings.voice = previous;
        this.save();
        this.bar.setVoice(voiceById(previous));
        if (this.voicePop.open) this.voicePop.render();
      });
    if (this.voicePop.open) this.voicePop.render();
  }

  /**
   * Offer the fast voice once, when the natural voice cannot keep up with playback on this
   * device (measured on the audio generated so far).
   */
  private maybeOfferFastVoice() {
    if (!this.tts.ready) return;
    const v = voiceById(this.settings.voice);
    const { rtf, seconds } = this.player.measuredRtf('kokoro');
    const offer = shouldOfferFastVoice({ offered: this.settings.fastVoiceOffer !== 'pending', piper: isPiper(v), device: this.tts.info.device, rtf, seconds, rate: this.settings.rate });
    if (!offer) return;
    this.settings.fastVoiceOffer = 'offered';
    this.save();
    const fast = fastVoiceFor(v);
    const size = this.tts.info.status?.fastVoices.includes(fast.id) ? '' : ` (${formatBytes(fast.bytes)} download)`;
    toast(`The natural voice is too slow on this computer to read without pauses. Switch to the fast voice${size}?`, {
      action: 'Use fast voice',
      ms: 15000,
      onAction: () => this.setVoice(fast.id),
    });
  }

  private async previewVoice(id: string) {
    if (this.previewing?.id === id && this.previewing.playing) {
      this.player.stopPreview();
      return;
    }
    if (!this.tts.ready) {
      const ok = this.tts.info.state === 'needs-download' ? await this.confirmDownload() : true;
      if (!ok) return;
      toast('The voice preview will play when the download finishes.');
      await this.tts.prepare(this.settings.model, this.settings.voice).catch(() => {});
    }
    const v = voiceById(id);
    const run = { id, playing: false };
    this.previewing = run;
    if (this.voicePop.open) this.voicePop.render();
    try {
      await this.tts.ensureVoice(id);
      await this.player.preview(id, `Hi, I'm ${v.name}. I can read your documents, books and articles aloud.`, () => {
        run.playing = true;
        if (this.previewing === run && this.voicePop.open) this.voicePop.render();
      });
    } catch (e) {
      toast(`Could not play ${v.name}: ${(e as Error).message}`, { error: true });
    } finally {
      if (this.previewing === run) this.previewing = null;
      if (this.voicePop.open) this.voicePop.render();
    }
  }

  private onPlayerState(s: PlayerState) {
    this.bar.setMode(s === 'playing' ? 'pause' : s === 'loading' || s === 'buffering' ? 'busy' : 'play');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s === 'playing' || s === 'buffering' || s === 'loading' ? 'playing' : s === 'idle' ? 'none' : 'paused';
    if (s === 'ended' && this.doc?.meta) void this.library.savePosition(this.doc.meta.id, this.doc.loaded.doc.text.length);
    this.updateMeta();
    this.maybeOfferFastVoice();
  }

  private onWord(w: number, force = false) {
    const d = this.doc;
    if (!d) return;
    const word = d.pdoc.words[w] ?? null;
    const si = word ? lastAtOrBefore(d.pdoc.sentences, word.start, (s) => s.start) : -1;
    const sentence = si >= 0 ? d.pdoc.sentences[si] : null;
    d.view.highlight(word, sentence);
    if (!word) return;
    const total = d.pdoc.words.length;
    this.bar.setProgress(total ? w / total : 0, `${Math.round((w / Math.max(1, total)) * 100)} percent`);
    this.updateMeta();
    this.maybeOfferFastVoice();
    if (force || this.player.state !== 'idle') this.followWord();
    this.schedulePositionSave(word.start);
  }

  private schedulePositionSave(offset: number) {
    const meta = this.doc?.meta;
    if (!meta || this.saveTimer) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      const off = this.player.currentOffset() || offset;
      void this.library.savePosition(meta.id, off).then((m) => m && this.doc?.meta?.id === m.id && (this.doc.meta = m));
    }, 1500);
  }

  private remainingText(wordIndex = this.player.currentWord()): string {
    if (!this.doc) return '';
    const left = this.doc.pdoc.words.length - Math.max(0, wordIndex);
    return formatRemaining(estimateSeconds(left, this.settings.rate));
  }

  private updateMeta() {
    const info = this.tts.info;
    let status = this.engineLine(info);
    if ((this.player.state === 'loading' || this.player.state === 'buffering') && !info.voiceDownload) {
      // A calm wait: playback starts once enough audio is ready to play without stopping.
      const wait = this.player.waitEstimate;
      status = wait !== null && wait >= 3 ? `Preparing audio · about ${Math.ceil(wait / 5) * 5} s` : 'Preparing audio';
    }
    this.bar.setStatus(status, this.doc ? this.remainingText() : '');
  }

  // ---- following the current word -----------------------------------------

  private bounds() {
    const top = this.topbar.getBoundingClientRect().bottom;
    const bottom = this.bar.el.getBoundingClientRect().top;
    return { top, bottom: Math.max(top + 100, bottom) };
  }

  private followWord() {
    const d = this.doc;
    if (!d) return;
    const offset = this.player.currentOffset();
    const rect = d.view.rectFor(offset);
    const { top, bottom } = this.bounds();
    const visible = !!rect && rect.top >= top && rect.bottom <= bottom;
    if (!this.follow) {
      this.backPill.hidden = visible || this.player.state === 'idle';
      return;
    }
    this.backPill.hidden = true;
    if (!rect) {
      void d.view.ensureVisible(offset).then(() => this.scrollToCurrent(true));
      return;
    }
    const span = bottom - top;
    if (rect.top < top + span * 0.12 || rect.bottom > top + span * 0.72) this.scrollToCurrent(true);
  }

  private scrollToCurrent(smooth: boolean) {
    const d = this.doc;
    if (!d) return;
    const rect = d.view.rectFor(this.player.currentOffset());
    if (!rect) return;
    const { top, bottom } = this.bounds();
    const target = window.scrollY + rect.top - (top + (bottom - top) * 0.3);
    this.autoScrollUntil = performance.now() + (smooth ? 900 : 100);
    window.scrollTo({ top: Math.max(0, target), behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  }

  private userScrolled() {
    if (!this.doc || performance.now() < this.autoScrollUntil) return;
    if (this.player.state === 'idle') return;
    this.follow = false;
    this.followWord();
  }

  // ---- global events -------------------------------------------------------

  private bindGlobalEvents() {
    window.addEventListener('scroll', () => {
      this.topbar.classList.toggle('scrolled', window.scrollY > 8);
      if (!this.follow) this.followWord();
    }, { passive: true });
    window.addEventListener('wheel', () => this.userScrolled(), { passive: true });
    window.addEventListener('touchmove', () => this.userScrolled(), { passive: true });
    document.addEventListener('pointerdown', (e) => {
      // Dragging the page scrollbar.
      if (e.target === document.documentElement) this.userScrolled();
    });
    window.addEventListener('resize', () => this.doc?.view.relayout());

    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        this.fileInput.click();
        return;
      }
      if (mod || e.altKey) return;
      const onButton = e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement;
      switch (e.key) {
        case ' ':
          // Space on another button activates that button; everywhere else it plays or pauses.
          if (onButton && e.target !== this.bar.playBtn) return;
          e.preventDefault();
          void this.togglePlay();
          break;
        case 'ArrowLeft':
          if (e.target instanceof HTMLInputElement) return;
          e.preventDefault();
          this.skip(-1);
          break;
        case 'ArrowRight':
          if (e.target instanceof HTMLInputElement) return;
          e.preventDefault();
          this.skip(1);
          break;
        case '[':
          this.setRate(this.settings.rate - 0.1);
          break;
        case ']':
          this.setRate(this.settings.rate + 0.1);
          break;
        case '?':
          this.shortcutsDialog();
          break;
        case 'PageDown':
        case 'PageUp':
        case 'ArrowDown':
        case 'ArrowUp':
        case 'Home':
        case 'End':
          this.userScrolled();
          break;
      }
    });
    document.addEventListener('paste', (e) => {
      if (isTypingTarget(e.target) || document.querySelector('dialog[open]')) return;
      const text = e.clipboardData?.getData('text/plain');
      if (text && text.trim().length > 20) {
        e.preventDefault();
        void this.openText(text);
      }
    });

    let depth = 0;
    const overlay = h('div', { class: 'drop-overlay', hidden: true }, h('div', { class: 'drop-card', html: `${icons.download}Drop to read<span>PDF, EPUB, web page, Markdown or text</span>` }));
    document.body.append(overlay);
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.openFile(f);
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyAppearance());
  }

  private setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // action not supported
      }
    };
    set('play', () => void this.togglePlay());
    set('pause', () => this.player.pause());
    set('stop', () => this.player.pause());
    set('previoustrack', () => this.skip(-1));
    set('nexttrack', () => this.skip(1));
    set('seekbackward', () => this.skip(-1));
    set('seekforward', () => this.skip(1));
  }

  private setMediaMetadata() {
    if (!('mediaSession' in navigator) || !this.doc) return;
    const icon = new URL('./icons/icon-512.png', document.baseURI).href;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.doc.loaded.title,
      artist: this.doc.loaded.author ?? voiceById(this.settings.voice).name,
      album: 'Narrata',
      artwork: [{ src: icon, sizes: '512x512', type: 'image/png' }],
    });
  }

  // ---- menus ---------------------------------------------------------------

  private voiceMenu(): Node[] {
    const row = (id: string) => {
      const v = voiceById(id);
      const selected = id === this.settings.voice;
      const loading = this.previewing?.id === id && !this.previewing.playing;
      const stopping = this.previewing?.id === id && this.previewing.playing;
      return h(
        'div',
        { class: 'voice-row' },
        h(
          'button',
          { class: 'menu-item', role: 'menuitemradio', 'aria-checked': String(selected), onclick: () => this.setVoice(id) },
          h('span', { class: 'avatar', 'data-g': v.gender, 'aria-hidden': 'true' }, v.name[0]),
          h('span', { class: 'grow' }, v.name, h('span', { class: 'voice-meta' }, `${accentLabel(v)} · ${v.gender === 'Female' ? 'female' : 'male'}`)),
          h('span', { class: 'check', html: icons.check }),
        ),
        h('button', {
          class: 'icon-btn',
          'aria-label': stopping ? `Stop preview` : `Preview ${v.name}`,
          title: stopping ? 'Stop preview' : `Preview ${v.name}`,
          'aria-busy': String(loading),
          html: stopping ? icons.stop : loading ? icons.spinner : icons.play,
          onclick: () => void this.previewVoice(id),
        }),
      );
    };
    const best = ['af_heart', 'af_bella', 'af_nicole', 'bf_emma'];
    const stored = this.tts.info.status?.fastVoices ?? [];
    const fastRow = (id: string) => {
      const r = row(id);
      const v = voiceById(id);
      if (isPiper(v) && !stored.includes(id)) r.querySelector('.voice-meta')?.append(` · ${formatBytes(v.bytes)}`);
      return r;
    };
    const kokoro = this.tts.info.status?.kokoro;
    const naturalNote = kokoro && kokoro.missingBytes > 0 && this.tts.info.state === 'ready' ? h('p', { class: 'pop-note' }, `The natural voices need a one-time download of ${formatBytes(kokoro.missingBytes)}.`) : null;
    return [
      h('div', { class: 'pop-section' }, h('p', { class: 'pop-title' }, 'Best voices'), naturalNote, ...best.map(row)),
      h('div', { class: 'pop-section' }, h('p', { class: 'pop-title' }, 'American'), ...VOICES.filter((v) => v.lang === 'a' && !best.includes(v.id)).map((v) => row(v.id))),
      h('div', { class: 'pop-section' }, h('p', { class: 'pop-title' }, 'British'), ...VOICES.filter((v) => v.lang === 'b' && !best.includes(v.id)).map((v) => row(v.id))),
      h(
        'div',
        { class: 'pop-section' },
        h('p', { class: 'pop-title' }, 'Fast voices'),
        h('p', { class: 'pop-note' }, 'Simpler voices that need much less computing power, for computers where the natural voice pauses. They run on this device too.'),
        ...PIPER_VOICES.map((v) => fastRow(v.id)),
      ),
    ];
  }

  private speedMenu(): Node[] {
    const r = this.settings.rate;
    const range = h('input', { class: 'range', type: 'range', min: 0.5, max: 3, step: 0.05, value: r, 'aria-label': 'Speed' }) as HTMLInputElement;
    range.addEventListener('input', () => {
      this.setRate(Number(range.value));
    });
    return [
      h('p', { class: 'pop-title' }, 'Speed'),
      h('div', { class: 'speed-value', 'aria-hidden': 'true' }, formatRate(r)),
      h('div', { class: 'field' }, range),
      h('div', { class: 'preset-row' }, ...RATE_PRESETS.map((p) => h('button', { class: 'preset', 'aria-pressed': String(Math.abs(p - r) < 0.001), onclick: () => this.setRate(p) }, formatRate(p)))),
      h('p', { class: 'small', style: 'margin:8px 10px 6px' }, 'Pitch stays natural at every speed.'),
    ];
  }

  private volumeMenu(): Node[] {
    const range = h('input', { class: 'range', type: 'range', min: 0, max: 1, step: 0.01, value: this.settings.volume, 'aria-label': 'Volume' }) as HTMLInputElement;
    range.addEventListener('input', () => {
      const v = Number(range.value);
      this.settings.volume = v;
      this.player.setVolume(v);
      this.bar.setVolume(v);
      this.save();
    });
    return [h('p', { class: 'pop-title' }, 'Volume'), h('div', { class: 'field' }, range)];
  }

  private typeMenu(): Node[] {
    const s = this.settings;
    const seg = <T extends string>(label: string, value: T, options: [T, string, string?][], set: (v: T) => void) =>
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'field-label' }, label),
        h('div', { class: 'segmented', role: 'group', 'aria-label': label }, ...options.map(([v, text, cls]) => h('button', { class: cls ?? '', 'aria-pressed': String(v === value), onclick: () => set(v) }, text))),
      );
    const slider = (label: string, value: number, min: number, max: number, step: number, fmt: (n: number) => string, set: (n: number) => void) => {
      const out = h('span', {}, fmt(value));
      const input = h('input', { class: 'range', type: 'range', min, max, step, value, 'aria-label': label }) as HTMLInputElement;
      input.addEventListener('input', () => {
        set(Number(input.value));
        out.textContent = fmt(Number(input.value));
      });
      return h('div', { class: 'field' }, h('div', { class: 'field-label' }, h('span', {}, label), out), input);
    };
    const update = (patch: Partial<Settings>) => {
      Object.assign(this.settings, patch);
      this.save();
      this.applyAppearance();
      this.typePop.render();
      requestAnimationFrame(() => this.doc?.view.relayout());
    };
    return [
      h('p', { class: 'pop-title' }, 'Reading'),
      seg('Theme', s.theme, [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], (theme) => update({ theme })),
      seg('Font', s.font, [['serif', 'Serif', 'seg-serif'], ['sans', 'Sans'], ['dyslexic', 'OpenDyslexic', 'seg-dys']], (font) => update({ font })),
      slider('Text size', s.fontSize, 15, 32, 1, (n) => `${n}px`, (fontSize) => {
        this.settings.fontSize = fontSize;
        this.save();
        this.applyAppearance();
        this.doc?.view.relayout();
      }),
      slider('Line spacing', s.lineHeight, 1.3, 2.4, 0.05, (n) => n.toFixed(2), (lineHeight) => {
        this.settings.lineHeight = lineHeight;
        this.save();
        this.applyAppearance();
        this.doc?.view.relayout();
      }),
    ];
  }

  private tocMenu(): Node[] {
    const d = this.doc;
    if (!d) return [];
    const cur = d.loaded.doc.blocks[Math.max(0, lastAtOrBefore(d.loaded.doc.blocks, this.player.currentOffset(), (b) => b.start))]?.chapter;
    return [
      h('p', { class: 'pop-title' }, 'Contents'),
      ...d.loaded.doc.chapters.map((c, i) =>
        h('button', {
          class: 'menu-item',
          role: 'menuitemradio',
          'aria-checked': String(i === cur),
          onclick: () => {
            // Focus moves to the text (like a skip link), so Space plays from the chapter.
            d.view.el.tabIndex = -1;
            this.tocPop.hide(d.view.el);
            this.goToChapter(i);
          },
        }, h('span', { class: 'grow' }, c.title), h('span', { class: 'check', html: icons.check })),
      ),
    ];
  }

  private goToChapter(i: number) {
    const d = this.doc;
    if (!d) return;
    const block = d.loaded.doc.blocks[d.loaded.doc.chapters[i].block];
    const active = ['playing', 'buffering', 'loading'].includes(this.player.state);
    this.follow = true;
    if (active) void this.player.playFrom(block.start);
    else this.player.setPosition(block.start);
    this.scrollToCurrent(false);
  }

  private moreMenu(): Node[] {
    const item = (icon: string, label: string, hint: string | null, fn: () => void, disabled = false) =>
      h('button', { class: 'menu-item', disabled, onclick: () => { this.morePop.hide(); fn(); } }, h('span', { html: icon }).firstChild!, h('span', { class: 'grow' }, label, hint ? h('span', { class: 'voice-meta' }, hint) : null));
    return [
      h(
        'div',
        { class: 'pop-section' },
        item(icons.file, 'Open a file', 'PDF, EPUB, web page, Markdown, text', () => this.fileInput.click()),
        item(icons.paste, 'Paste text', null, () => this.pasteDialog()),
        item(icons.library, 'Library', `${this.recent.length} document${this.recent.length === 1 ? '' : 's'}`, () => this.goHome()),
      ),
      h(
        'div',
        { class: 'pop-section' },
        item(icons.download, 'Export audio', this.doc ? 'Save this document as an audio file' : 'Open a document first', () => void this.exportDialog(), !this.doc),
        item(icons.keyboard, 'Keyboard shortcuts', null, () => this.shortcutsDialog()),
        item(icons.info, 'About and storage', null, () => this.aboutDialog()),
      ),
    ];
  }

  // ---- dialogs -------------------------------------------------------------

  private pasteDialog() {
    const title = h('input', { type: 'text', placeholder: 'Title (optional)', 'aria-label': 'Title' }) as HTMLInputElement;
    const area = h('textarea', { placeholder: 'Paste or type the text you want to hear.', 'aria-label': 'Text to read' }) as HTMLTextAreaElement;
    const { close } = sheet('Paste text', [
      title,
      area,
      h(
        'div',
        { class: 'sheet-actions' },
        h('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => {
            const text = area.value;
            close();
            void this.openText(text, title.value.trim() || undefined);
          },
        }, 'Read this'),
      ),
    ]);
    area.focus();
  }

  private shortcutsDialog() {
    const row = (keys: string[], text: string) => [h('dt', {}, ...keys.flatMap((k, i) => [i ? ' ' : '', h('kbd', {}, k)])), h('dd', {}, text)];
    sheet('Keyboard shortcuts', [
      h('dl', { class: 'kbd-list' },
        ...row(['Space'], 'Play or pause'),
        ...row(['←', '→'], 'Previous or next sentence'),
        ...row(['[', ']'], 'Slower or faster'),
        ...row(['Ctrl', 'O'], 'Open a file'),
        ...row(['Ctrl', 'V'], 'Read pasted text'),
        ...row(['?'], 'Show this list'),
      ),
      h('p', { class: 'small', style: 'margin-top:16px' }, 'Click any word to start reading from there.'),
    ]);
  }

  private aboutDialog() {
    const info = this.tts.info;
    const stored = info.status?.storedBytes ?? 0;
    const voice = voiceById(this.settings.voice);
    const modelLine = info.state !== 'ready'
      ? 'No voice loaded yet.'
      : isPiper(voice)
        ? `Piper voice ${voice.name} on the processor (WebAssembly, ${info.threads ?? 1} thread${info.threads === 1 ? '' : 's'}).`
        : `Kokoro-82M (${info.variant === 'fp32' ? 'full precision' : '8-bit'}) on the ${info.device === 'webgpu' ? 'graphics chip (WebGPU)' : `processor (WebAssembly, ${info.threads ?? 1} thread${info.threads === 1 ? '' : 's'})`}.`;
    const { close } = sheet('About Narrata', [
      h('p', { class: 'sheet-text' }, 'Narrata reads text aloud with open voice models (Kokoro-82M for the natural voices, Piper for the fast ones) running entirely in your browser through ONNX Runtime Web. Documents, reading positions and the voices are stored only on this device.'),
      h('ul', { class: 'about-list' },
        h('li', {}, modelLine),
        h('li', {}, `Voice data stored: ${formatBytes(stored)}${info.status?.persistent ? '' : ' (temporary: this browser does not allow storing files)'}.`),
        h('li', {}, `Library: ${this.recent.length} document${this.recent.length === 1 ? '' : 's'}.`),
        h('li', {}, `Cross-origin isolated: ${self.crossOriginIsolated ? 'yes (multi-threaded)' : 'no (single thread)'}.`),
      ),
      h('p', { class: 'small', style: 'margin-top:14px' }, 'Free software under the MIT License. Built with Kokoro, Piper, misaki, ONNX Runtime Web, pdf.js, Readability, fflate, Signalsmith Stretch and mp4-muxer.'),
      h(
        'div',
        { class: 'sheet-actions' },
        h('button', {
          class: 'btn btn-danger',
          disabled: stored === 0,
          onclick: () => {
            close();
            this.player.stop();
            this.tts.clearModels();
            toast('Removed the downloaded voice data.');
          },
        }, 'Remove voice data'),
        h('button', { class: 'btn btn-primary', onclick: () => close() }, 'Done'),
      ),
    ]);
  }

  /** Export the open document; returns the encoded file (also used by tests). */
  exportDocument(onProgress: (done: number, total: number, seconds: number) => void, format: 'm4a' | 'wav' = typeof AudioEncoder !== 'undefined' ? 'm4a' : 'wav') {
    const d = this.doc!;
    const chunks = d.pdoc.chunks.map((c) => ({ text: d.loaded.doc.text.slice(c.start, c.end), endsWith: c.endsWith }));
    return this.tts.exportAudio(chunks, this.settings.voice, d.loaded.title, format, onProgress);
  }

  private async exportDialog() {
    if (!this.doc) return;
    if (!this.tts.ready) {
      if (this.tts.info.state === 'needs-download' && !(await this.confirmDownload())) return;
      await this.tts.prepare(this.settings.model, this.settings.voice).catch(() => {});
    }
    const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Export progress', 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', {}));
    const meta = h('div', { class: 'progress-meta' }, h('span', {}, 'Starting'), h('span', {}, ''));
    const est = estimateSeconds(this.doc.pdoc.words.length, 1);
    // Keep generating at full speed if the tab goes to the background during the export.
    void this.player.ensureAudio().catch(() => {});
    this.player.busyElsewhere = true;
    this.player.updateKeepAlive();
    const job = this.exportDocument((done, total, seconds) => {
      (bar.firstChild as HTMLElement).style.width = `${(done / total) * 100}%`;
      bar.setAttribute('aria-valuenow', String(Math.round((done / total) * 100)));
      meta.replaceChildren(h('span', {}, `${done} of ${total} sentences`), h('span', {}, `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')} of audio`));
    });
    let finished = false;
    const { close } = sheet('Export audio', [
      h('p', { class: 'sheet-text' }, `Saving “${this.doc.loaded.title}” with the ${voiceById(this.settings.voice).name} voice, about ${Math.max(1, Math.round(est / 60))} min of audio. Playback can continue while this runs.`),
      bar,
      meta,
      h('div', { class: 'sheet-actions' }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel')),
    ], { onClose: () => !finished && job.cancel() });
    try {
      const r = await job.promise;
      finished = true;
      close();
      const name = `${this.doc?.loaded.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'narrata'}.${r.ext}`;
      const url = URL.createObjectURL(new Blob([r.data], { type: r.mime }));
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast(`Exported ${name}.`);
    } catch (e) {
      if ((e as Error).message !== 'cancelled') toast(`Export failed: ${(e as Error).message}`, { error: true });
    } finally {
      this.player.busyElsewhere = false;
      this.player.updateKeepAlive();
    }
  }

  /** Helpers exposed for debugging and automated checks. */
  get current() {
    return this.doc;
  }

  get formatRate() {
    return formatRate;
  }

  wordIndexAt(offset: number) {
    return this.doc ? wordIndexAt(this.doc.pdoc.words, offset) : -1;
  }
}

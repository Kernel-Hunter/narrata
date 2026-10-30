// Floating player injected into the page. It lives in a shadow root, so the page's styles cannot
// reach it and its styles cannot leak into the page.

import type { PlayerState } from '../../../src/audio/player';
import type { EngineInfo } from '../../../src/engine/client';
import type { ModelChoice } from '../../../src/engine/protocol';
import { downloadSize } from '../../../src/engine/model-store';
import { PIPER_VOICES, VOICES, accentLabel } from '../../../src/engine/voices';
import { choiceHtml, isFirstRun } from '../choice';
import { icons, logo } from '../../../src/ui/icons';

export interface MiniPlayerActions {
  toggle(): void;
  skip(delta: number): void;
  rate(rate: number): void;
  voice(voice: string): void;
  close(): void;
  backToCurrent(): void;
  /** Download the model; with a voice, select that voice first (first-run choice). */
  download(model: ModelChoice, voice?: string): void;
}

export type UiState = PlayerState | 'needs-download' | 'downloading' | 'preparing';

const RATES = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.np {
  --bg: rgba(21, 23, 28, 0.94); --fg: #f2f3f5; --muted: #a3a9b5; --line: rgba(255,255,255,0.1);
  --accent: #ffc746; --accent-ink: #15171c; --soft: rgba(255,255,255,0.08);
  --logo-bg: #f2f3f5; --logo-fg: #15171c; --logo-accent: #e0a21c;
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  width: 380px; max-width: calc(100vw - 24px);
  font: 13px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Roboto, sans-serif;
  color: var(--fg); background: var(--bg);
  border: 1px solid var(--line); border-radius: 18px;
  box-shadow: 0 2px 6px rgba(0,0,0,.18), 0 18px 50px rgba(0,0,0,.32);
  backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4);
  outline: none; user-select: none; -webkit-user-select: none;
  animation: in .22s cubic-bezier(.2,.7,.2,1);
}
@keyframes in { from { opacity: 0; transform: translateY(8px) scale(.98); } }
.row { display: flex; align-items: center; gap: 4px; }
.row.top { padding: 12px 10px 4px 14px; gap: 10px; }
.row.controls { padding: 4px 12px 12px 8px; }
.logo { flex: none; width: 28px; height: 28px; }
.logo svg { display: block; }
button { font: inherit; color: inherit; border: 0; background: none; cursor: pointer; padding: 0; margin: 0; -webkit-tap-highlight-color: transparent; }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ib { width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; color: var(--fg); flex: none; }
.ib:hover { background: var(--soft); }
.ib svg { width: 19px; height: 19px; }
.play { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--accent); color: var(--accent-ink); flex: none; transition: transform .12s; }
.play:hover { transform: scale(1.05); }
.play:active { transform: scale(.96); }
.play svg { width: 20px; height: 20px; }
.play .spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.meta { flex: 1; min-width: 0; }
.title { font-weight: 650; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { color: var(--muted); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { flex: 1; height: 4px; border-radius: 99px; background: var(--soft); margin: 0 10px 0 8px; overflow: hidden; }
.bar > span { display: block; height: 100%; width: 0; background: var(--accent); border-radius: inherit; transition: width .3s; }
.chip { height: 28px; min-width: 46px; padding: 0 8px; border-radius: 9px; background: var(--soft); font-weight: 650; font-size: 12px; font-variant-numeric: tabular-nums; flex: none; }
.chip:hover { background: rgba(255,255,255,0.14); }
.panel { border-top: 1px solid var(--line); padding: 12px 14px 14px; }
.panel[hidden] { display: none; }
.speed-row { display: flex; align-items: center; gap: 10px; }
.speed-row input { flex: 1; accent-color: var(--accent); }
.speed-val { width: 42px; text-align: right; font-weight: 650; font-variant-numeric: tabular-nums; }
.presets { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.presets button { height: 26px; padding: 0 9px; border-radius: 8px; background: var(--soft); font-size: 12px; font-variant-numeric: tabular-nums; }
.presets button[aria-pressed='true'] { background: var(--accent); color: var(--accent-ink); font-weight: 650; }
label.lbl { display: block; color: var(--muted); font-size: 12px; margin-bottom: 6px; }
select { width: 100%; height: 32px; border-radius: 9px; border: 1px solid var(--line); background: #22252c; color: var(--fg); font: inherit; padding: 0 8px; }
.dl p { margin: 0 0 10px; color: var(--fg); }
.dl p.small { color: var(--muted); font-size: 12px; }
.dl .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.btn { height: 32px; padding: 0 14px; border-radius: 10px; font-weight: 650; background: var(--accent); color: var(--accent-ink); }
.btn.quiet { background: var(--soft); color: var(--fg); font-weight: 600; }
.progress { height: 6px; border-radius: 99px; background: var(--soft); overflow: hidden; margin: 4px 0 8px; }
.progress > span { display: block; height: 100%; width: 0; background: var(--accent); transition: width .25s; }
.msg { border-top: 1px solid var(--line); padding: 10px 14px 12px; color: #ffd9a0; font-size: 12px; }
.msg[hidden] { display: none; }
.back {
  position: absolute; left: 50%; top: -14px; transform: translate(-50%, -100%);
  height: 30px; padding: 0 14px; border-radius: 99px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); box-shadow: 0 6px 20px rgba(0,0,0,.25); font-weight: 600; font-size: 12px;
  display: flex; align-items: center; gap: 6px; white-space: nowrap;
}
.back[hidden] { display: none; }
.back svg { width: 14px; height: 14px; transform: rotate(90deg); }
.hl-word, .hl-sentence { position: fixed; left: 0; top: 0; pointer-events: none; border-radius: 3px; z-index: 2147483646; }
.hl-word { background: rgba(255, 210, 90, 0.55); mix-blend-mode: multiply; }
.hl-sentence { background: rgba(255, 199, 70, 0.18); mix-blend-mode: multiply; }
@media (max-width: 480px) { .np { right: 12px; left: 12px; bottom: 12px; width: auto; } }
@media (prefers-reduced-motion: reduce) { .np { animation: none; } .bar > span, .progress > span { transition: none; } }
`;

export class MiniPlayer {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  /** Fixed layer for the fallback highlight boxes. */
  readonly layer: HTMLElement;
  private el: HTMLElement;
  private $ = <T extends Element = HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
  private state: UiState = 'idle';
  private rate = 1;

  constructor(private readonly actions: MiniPlayerActions) {
    this.host = document.createElement('div');
    this.host.setAttribute('data-narrata-host', '');
    this.root = this.host.attachShadow({ mode: 'open' });
    const voices = (lang: 'a' | 'b') =>
      VOICES.filter((v) => v.lang === lang)
        .map((v) => `<option value="${v.id}">${v.name} (${v.gender.toLowerCase()})</option>`)
        .join('');
    const fastVoices = PIPER_VOICES.map((v) => `<option value="${v.id}">${v.name} (${accentLabel(v).toLowerCase()} ${v.gender.toLowerCase()}, ${mb(v.bytes)})</option>`).join('');
    this.root.innerHTML = `<style>${CSS}</style>
<div class="layer"></div>
<div class="np" role="region" aria-label="Narrata player" tabindex="-1">
  <button class="back" hidden>${icons.chevronLeft}<span>Back to current</span></button>
  <div class="row top">
    <div class="logo">${logo}</div>
    <div class="meta">
      <div class="title"></div>
      <div class="sub">Starting</div>
    </div>
    <button class="ib close" aria-label="Close" title="Stop and close">${icons.close}</button>
  </div>
  <div class="row controls">
    <button class="ib prev" aria-label="Previous sentence" title="Previous sentence">${icons.back}</button>
    <button class="play" aria-label="Play" title="Play or pause (Space)">${icons.play}</button>
    <button class="ib next" aria-label="Next sentence" title="Next sentence">${icons.forward}</button>
    <div class="bar" aria-hidden="true"><span></span></div>
    <button class="chip speed" aria-label="Speed" aria-expanded="false" title="Speed">1×</button>
    <button class="ib voice-btn" aria-label="Voice" aria-expanded="false" title="Voice">${icons.speaker}</button>
  </div>
  <div class="panel speed-panel" hidden>
    <div class="speed-row"><span>Speed</span><input type="range" min="0.5" max="3" step="0.05" value="1" aria-label="Speed"><span class="speed-val">1×</span></div>
    <div class="presets">${RATES.map((r) => `<button data-rate="${r}" aria-pressed="false">${r}×</button>`).join('')}</div>
  </div>
  <div class="panel voice-panel" hidden>
    <label class="lbl" for="voice">Voice</label>
    <select id="voice"><optgroup label="${accentLabel(VOICES[0])}">${voices('a')}</optgroup><optgroup label="British">${voices('b')}</optgroup><optgroup label="Fast voices, for slower computers">${fastVoices}</optgroup></select>
  </div>
  <div class="panel dl" hidden></div>
  <div class="msg" hidden></div>
</div>`;
    this.el = this.$('.np');
    this.layer = this.$('.layer');
    this.bind();
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  unmount(): void {
    this.host.remove();
  }

  contains(t: EventTarget | null): boolean {
    return t === this.host || (t instanceof Node && this.host.contains(t));
  }

  get height(): number {
    return this.host.isConnected ? this.el.getBoundingClientRect().height + 28 : 0;
  }

  private bind() {
    this.$('.play').addEventListener('click', () => this.actions.toggle());
    this.$('.prev').addEventListener('click', () => this.actions.skip(-1));
    this.$('.next').addEventListener('click', () => this.actions.skip(1));
    this.$('.close').addEventListener('click', () => this.actions.close());
    this.$('.back').addEventListener('click', () => this.actions.backToCurrent());
    this.$('.speed').addEventListener('click', () => this.togglePanel('speed'));
    this.$('.voice-btn').addEventListener('click', () => this.togglePanel('voice'));
    const range = this.$<HTMLInputElement>('.speed-panel input');
    range.addEventListener('input', () => this.applyRate(Number(range.value)));
    this.root.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((b) => b.addEventListener('click', () => this.applyRate(Number(b.dataset.rate))));
    const sel = this.$<HTMLSelectElement>('select');
    sel.addEventListener('change', () => this.actions.voice(sel.value));
    // Keys work only while focus is inside the player, never on the page itself.
    this.el.addEventListener('keydown', (e) => {
      const t = e.composedPath()[0] as HTMLElement;
      const inField = t.tagName === 'SELECT' || t.tagName === 'INPUT';
      if (e.key === ' ' && !(t.tagName === 'BUTTON') && !inField) {
        e.preventDefault();
        this.actions.toggle();
      } else if (e.key === 'ArrowLeft' && !inField) {
        e.preventDefault();
        this.actions.skip(-1);
      } else if (e.key === 'ArrowRight' && !inField) {
        e.preventDefault();
        this.actions.skip(1);
      } else if (e.key === 'Escape') {
        this.togglePanel(null);
        this.el.focus();
      }
      e.stopPropagation();
    });
    // Clicks inside the player never count as page clicks.
    this.el.addEventListener('mousedown', (e) => {
      if ((e.composedPath()[0] as HTMLElement).tagName !== 'SELECT' && (e.composedPath()[0] as HTMLElement).tagName !== 'INPUT') this.el.focus({ preventScroll: true });
    });
  }

  private applyRate(r: number) {
    const rate = Math.round(Math.min(3, Math.max(0.5, r)) * 100) / 100;
    this.setRate(rate);
    this.actions.rate(rate);
  }

  private togglePanel(which: 'speed' | 'voice' | null) {
    const sp = this.$('.speed-panel');
    const vp = this.$('.voice-panel');
    const openSpeed = which === 'speed' && sp.hidden;
    const openVoice = which === 'voice' && vp.hidden;
    sp.hidden = !openSpeed;
    vp.hidden = !openVoice;
    this.$('.speed').setAttribute('aria-expanded', String(openSpeed));
    this.$('.voice-btn').setAttribute('aria-expanded', String(openVoice));
    if (openVoice) this.$<HTMLSelectElement>('select').focus();
  }

  focus(): void {
    this.el.focus({ preventScroll: true });
  }

  setTitle(title: string): void {
    this.$('.title').textContent = title;
  }

  setRate(rate: number): void {
    this.rate = rate;
    const label = `${Number(rate.toFixed(2))}×`;
    this.$('.speed').textContent = label;
    this.$('.speed-val').textContent = label;
    this.$<HTMLInputElement>('.speed-panel input').value = String(rate);
    this.root.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((b) => b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.rate) - rate) < 0.01)));
  }

  getRate(): number {
    return this.rate;
  }

  setVoice(voice: string): void {
    this.$<HTMLSelectElement>('select').value = voice;
  }

  setProgress(fraction: number): void {
    this.$<HTMLElement>('.bar > span').style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  }

  setFollowing(following: boolean): void {
    this.$('.back').hidden = following;
  }

  setStatus(text: string): void {
    this.$('.sub').textContent = text;
  }

  setState(state: UiState): void {
    this.state = state;
    const play = this.$('.play');
    const busy = state === 'loading' || state === 'buffering' || state === 'preparing' || state === 'downloading';
    const playing = state === 'playing' || busy;
    play.innerHTML = busy ? icons.spinner : playing ? icons.pause : icons.play;
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.host.dataset.state = state;
  }

  getState(): UiState {
    return this.state;
  }

  message(text: string | null): void {
    const m = this.$('.msg');
    m.hidden = !text;
    m.textContent = text ?? '';
  }

  /** Download offer, progress or nothing, depending on the engine state. */
  showEngine(info: EngineInfo | null): void {
    const dl = this.$('.dl');
    if (!info || info.state === 'ready' || (info.state !== 'needs-download' && info.state !== 'downloading')) {
      dl.hidden = true;
      dl.innerHTML = '';
      return;
    }
    dl.hidden = false;
    if (info.state === 'needs-download' && isFirstRun(info.status)) {
      dl.innerHTML = choiceHtml(info.status!, this.$<HTMLSelectElement>('select').value);
      dl.querySelectorAll<HTMLButtonElement>('[data-voice]').forEach((b) => b.addEventListener('click', () => this.actions.download(b.dataset.model as ModelChoice, b.dataset.voice)));
      return;
    }
    if (info.state === 'needs-download') {
      const plan = info.status?.plan;
      const full = plan?.missingBytes ?? 0;
      const gpu = info.status?.hasWebGPU && plan?.engine === 'kokoro';
      dl.innerHTML = `<p>Narrata reads with a voice that runs on this computer. It needs a one-time download of <strong>${mb(full)}</strong> from Hugging Face.</p>
<p class="small">${gpu ? 'The full voice uses your graphics chip. The smaller one runs on the processor and is slower.' : 'Your browser has no WebGPU, so the voice runs on the processor.'} Nothing you read is sent anywhere.</p>
<div class="actions"><button class="btn" data-model="auto">Download ${mb(full)}</button>${gpu ? `<button class="btn quiet" data-model="compact">Smaller voice, ${mb(downloadSize('uint8'))}</button>` : ''}</div>`;
      dl.querySelectorAll<HTMLButtonElement>('[data-model]').forEach((b) => b.addEventListener('click', () => this.actions.download(b.dataset.model as ModelChoice)));
      return;
    }
    const d = info.download;
    const frac = d && d.total ? d.loaded / d.total : 0;
    dl.innerHTML = `<p>Downloading the voice: ${d ? `${mb(d.loaded)} of ${mb(d.total)}` : 'starting'}</p><div class="progress"><span style="width:${(frac * 100).toFixed(1)}%"></span></div><p class="small">This happens once. You can keep browsing.</p>`;
  }
}

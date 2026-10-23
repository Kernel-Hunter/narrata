import { formatRate } from '../core/format';
import { type Voice } from '../engine/voices';
import { h } from './dom';
import { icons } from './icons';

export interface PlayerBarHandlers {
  onToggle(): void;
  onPrev(): void;
  onNext(): void;
  onSeek(fraction: number, commit: boolean): void;
  onVoice(anchor: HTMLElement): void;
  onSpeed(anchor: HTMLElement): void;
  onVolume(anchor: HTMLElement): void;
}

export class PlayerBar {
  readonly el: HTMLElement;
  readonly playBtn: HTMLButtonElement;
  readonly voiceBtn: HTMLButtonElement;
  readonly speedBtn: HTMLButtonElement;
  readonly volumeBtn: HTMLButtonElement;
  private seek: HTMLInputElement;
  private status: HTMLElement;
  private left: HTMLElement;
  private dragging = false;
  private mode: 'play' | 'pause' | 'busy' = 'play';

  constructor(h_: PlayerBarHandlers) {
    this.seek = h('input', { class: 'seek', type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Position in document' }) as HTMLInputElement;
    this.seek.addEventListener('input', () => {
      this.dragging = true;
      this.paintSeek();
      h_.onSeek(Number(this.seek.value) / 1000, false);
    });
    this.seek.addEventListener('change', () => {
      this.dragging = false;
      h_.onSeek(Number(this.seek.value) / 1000, true);
    });
    this.playBtn = h('button', { class: 'play-btn', 'aria-label': 'Play', title: 'Play (Space)', html: icons.play, onclick: () => h_.onToggle() }) as HTMLButtonElement;
    const prev = h('button', { class: 'icon-btn', 'aria-label': 'Previous sentence', title: 'Previous sentence (Left arrow)', html: icons.back, onclick: () => h_.onPrev() });
    const next = h('button', { class: 'icon-btn', 'aria-label': 'Next sentence', title: 'Next sentence (Right arrow)', html: icons.forward, onclick: () => h_.onNext() });
    this.voiceBtn = h('button', { class: 'chip voice-chip', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }) as HTMLButtonElement;
    this.voiceBtn.addEventListener('click', () => h_.onVoice(this.voiceBtn));
    this.speedBtn = h('button', { class: 'chip speed-chip', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Speed ([ and ])' }) as HTMLButtonElement;
    this.speedBtn.addEventListener('click', () => h_.onSpeed(this.speedBtn));
    this.volumeBtn = h('button', { class: 'icon-btn volume-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-label': 'Volume', html: icons.volume }) as HTMLButtonElement;
    this.volumeBtn.addEventListener('click', () => h_.onVolume(this.volumeBtn));
    this.status = h('span', { class: 'status' });
    this.left = h('span', { class: 'time-left' });
    this.el = h(
      'div',
      { class: 'player', role: 'region', 'aria-label': 'Player' },
      h('div', { class: 'seek-wrap' }, this.seek),
      h(
        'div',
        { class: 'player-row' },
        h('div', { class: 'player-left' }, this.voiceBtn),
        h('div', { class: 'transport' }, prev, this.playBtn, next),
        h('div', { class: 'player-right' }, this.speedBtn, this.volumeBtn),
      ),
      h('div', { class: 'player-meta' }, this.status, this.left),
    );
  }

  setMode(mode: 'play' | 'pause' | 'busy'): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.playBtn.innerHTML = mode === 'pause' ? icons.pause : mode === 'busy' ? icons.spinner : icons.play;
    const label = mode === 'pause' ? 'Pause' : mode === 'busy' ? 'Pause (preparing audio)' : 'Play';
    this.playBtn.setAttribute('aria-label', label);
    this.playBtn.title = `${label} (Space)`;
  }

  setVoice(v: Voice): void {
    this.voiceBtn.replaceChildren(
      h('span', { class: 'avatar', 'data-g': v.gender, 'aria-hidden': 'true' }, v.name[0]),
      h('span', { class: 'chip-label' }, v.name),
      h('span', { html: icons.chevronDown, 'aria-hidden': 'true' }).firstChild!,
    );
    this.voiceBtn.setAttribute('aria-label', `Voice: ${v.name}`);
  }

  setRate(r: number): void {
    this.speedBtn.textContent = formatRate(r);
    this.speedBtn.setAttribute('aria-label', `Speed ${formatRate(r)}`);
  }

  setVolume(v: number): void {
    this.volumeBtn.innerHTML = v === 0 ? icons.mute : icons.volume;
  }

  setProgress(fraction: number, valueText: string): void {
    if (this.dragging) return;
    this.seek.value = String(Math.round(fraction * 1000));
    this.seek.setAttribute('aria-valuetext', valueText);
    this.paintSeek();
  }

  private paintSeek() {
    this.seek.style.setProperty('--p', `${Number(this.seek.value) / 10}%`);
  }

  setStatus(text: string, left = ''): void {
    this.status.textContent = text;
    this.left.textContent = left;
  }
}

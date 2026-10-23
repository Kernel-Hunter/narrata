import type { ModelChoice } from '../engine/protocol';
import { DEFAULT_VOICE } from '../engine/voices';

export type Theme = 'system' | 'light' | 'dark';
export type ReadingFont = 'serif' | 'sans' | 'dyslexic';

export interface Settings {
  voice: string;
  rate: number;
  volume: number;
  theme: Theme;
  font: ReadingFont;
  fontSize: number;
  lineHeight: number;
  model: ModelChoice;
  pdfMode: 'page' | 'text';
}

export const DEFAULTS: Settings = {
  voice: DEFAULT_VOICE,
  rate: 1,
  volume: 1,
  theme: 'system',
  font: 'serif',
  fontSize: 20,
  lineHeight: 1.7,
  model: 'auto',
  pdfMode: 'page',
};

const KEY = 'narrata.settings';

export function clampSettings(s: Partial<Settings>): Settings {
  const m = { ...DEFAULTS, ...s };
  return {
    ...m,
    rate: Math.min(3, Math.max(0.5, Number(m.rate) || 1)),
    volume: Math.min(1, Math.max(0, Number.isFinite(Number(m.volume)) ? Number(m.volume) : 1)),
    fontSize: Math.min(32, Math.max(15, Number(m.fontSize) || DEFAULTS.fontSize)),
    lineHeight: Math.min(2.4, Math.max(1.3, Number(m.lineHeight) || DEFAULTS.lineHeight)),
    theme: ['system', 'light', 'dark'].includes(m.theme) ? m.theme : 'system',
    font: ['serif', 'sans', 'dyslexic'].includes(m.font) ? m.font : 'serif',
    model: m.model === 'compact' ? 'compact' : 'auto',
    pdfMode: m.pdfMode === 'text' ? 'text' : 'page',
  };
}

export function loadSettings(storage: Storage | null = safeStorage()): Settings {
  try {
    const raw = storage?.getItem(KEY);
    return clampSettings(raw ? (JSON.parse(raw) as Partial<Settings>) : {});
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(s));
  } catch {
    // Private mode or storage disabled: settings last for this session only.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

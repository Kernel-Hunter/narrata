export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

/** "12 min left", "45 sec left", "1 hr 5 min left". */
export function formatRemaining(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec left`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min left`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min left` : `${h} hr left`;
}

/** Spoken words per minute of the Kokoro voices at 1x, measured on the sample text. */
export const WORDS_PER_MINUTE_1X = 165;

export function estimateSeconds(words: number, rate: number): number {
  return (words / WORDS_PER_MINUTE_1X) * 60 / Math.max(0.1, rate);
}

export function formatRate(r: number): string {
  return `${Number.isInteger(r) ? r.toFixed(1) : String(+r.toFixed(2))}×`;
}

export function formatDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const days = Math.floor((now - ts) / 86400000);
  if (days < 1 && new Date(now).getDate() === d.getDate()) return 'Today';
  if (days < 2) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: now - ts > 300 * 86400000 ? 'numeric' : undefined });
}

// Unpacked extensions cannot update themselves. The popup asks GitHub for the latest release, at
// most once a day (the answer is kept in chrome.storage), and offers it when it is newer than the
// version that is running. The request sends nothing about what they read.

export const RELEASES_API = 'https://api.github.com/repos/Kernel-Hunter/narrata/releases/latest';
const RELEASES_PAGE = 'https://github.com/Kernel-Hunter/narrata/releases/';
const KEY = 'update';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Release {
  /** Without the leading v, as in the manifest. */
  version: string;
  /** The release page on GitHub. */
  url: string;
}

interface Cached {
  checkedAt: number;
  latest: Release | null;
}

/** The part of chrome.storage.local this needs, so tests can pass a stand-in. */
export interface UpdateStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const parts = (v: string) => v.replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);

/** True when `candidate` is a later version than `current` ("0.10.0" is later than "0.9.2"). */
export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** The release in a GitHub API answer, or null if it is not a usable published release. */
export function parseRelease(data: unknown): Release | null {
  if (!data || typeof data !== 'object') return null;
  const r = data as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
  if (r.draft || r.prerelease || typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') return null;
  const version = r.tag_name.replace(/^v/i, '');
  if (!/^\d+(\.\d+){0,3}$/.test(version)) return null;
  // Only ever link to this repository's releases.
  if (!r.html_url.startsWith(RELEASES_PAGE)) return null;
  return { version, url: r.html_url };
}

/**
 * The latest release, from storage if GitHub was asked less than a day ago. A failed request
 * counts as a check too, so an unreachable GitHub is not asked on every popup.
 */
export async function latestRelease(storage: UpdateStorage, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Release | null> {
  const stored: Record<string, unknown> = await storage.get(KEY).catch(() => ({}));
  const cached = stored[KEY] as Cached | undefined;
  if (cached && typeof cached.checkedAt === 'number' && now - cached.checkedAt < DAY_MS && now >= cached.checkedAt) return cached.latest;
  let latest: Release | null = cached?.latest ?? null;
  try {
    const res = await fetcher(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store' });
    if (res.ok) latest = parseRelease(await res.json());
    else if (res.status === 404) latest = null; // no release published yet
  } catch {
    // Offline: keep what was known.
  }
  await storage.set({ [KEY]: { checkedAt: now, latest } satisfies Cached }).catch(() => {});
  return latest;
}

/** The release to offer, or null when the running version is the latest. */
export async function availableUpdate(current: string, storage: UpdateStorage, now = Date.now(), fetcher: typeof fetch = fetch): Promise<Release | null> {
  const latest = await latestRelease(storage, now, fetcher);
  return latest && isNewer(latest.version, current) ? latest : null;
}

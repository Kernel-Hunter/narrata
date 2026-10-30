// Tells a page that stays open when a newer version of Narrata has been deployed. The build
// writes its id into index.html (<meta name="narrata-build">) and into version.json next to it
// (see vite.config.ts). The service worker never caches version.json, so when the two differ,
// this page is out of date.
//
// The page checks when it becomes visible again (at most once a minute), every 30 minutes, when
// the connection comes back, and when the browser finds a new service worker by itself. It never
// reloads on its own: the app shows a notice and reloads when the user asks (see main.ts).

const CHECK_EVERY_MS = 30 * 60_000;
/** Switching tabs back and forth checks at most this often. */
const MIN_GAP_MS = 60_000;
/** Longest wait for the new service worker before reloading anyway. */
const WORKER_WAIT_MS = 10_000;

/** The build id of the running page, or null in development. */
export function currentBuild(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>('meta[name="narrata-build"]')?.content || null;
}

/** The build id of the latest deploy, or null when it cannot be read (offline, for example). */
export async function latestBuild(base: string = document.baseURI, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    // The query and no-store skip every cache on the way (GitHub Pages sends max-age=600).
    const url = new URL('./version.json', base);
    url.searchParams.set('t', String(Date.now()));
    const res = await fetcher(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { build?: unknown };
    return typeof data.build === 'string' && data.build ? data.build : null;
  } catch {
    return null;
  }
}

/** Calls `onUpdate` once, when a deploy newer than this page is found. */
export function watchForUpdates(onUpdate: () => void): void {
  const mine = currentBuild();
  if (!mine) return;
  let found = false;
  let running = false;
  let last = 0;
  const check = async (force = false) => {
    if (found || running || !navigator.onLine) return;
    if (!force && Date.now() - last < MIN_GAP_MS) return;
    running = true;
    last = Date.now();
    const latest = await latestBuild();
    running = false;
    if (found || !latest || latest === mine) return;
    found = true;
    clearInterval(timer);
    // Let the service worker cache the new version now, so the reload is quick and works offline.
    void navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
    onUpdate();
  };
  const timer = setInterval(() => void check(true), CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check();
  });
  addEventListener('online', () => void check());
  // The browser checks for a new service worker on its own too (on navigations, for example).
  void navigator.serviceWorker
    ?.getRegistration()
    .then((reg) =>
      reg?.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'activated') void check(true);
        });
      }),
    )
    .catch(() => {});
}

/** Resolves when the registration has no worker installing, or after `ms`. */
async function workerSettled(reg: ServiceWorkerRegistration, ms: number): Promise<void> {
  await Promise.race([
    (async () => {
      await reg.update().catch(() => {});
      const worker = reg.installing ?? reg.waiting;
      if (!worker) return;
      await new Promise<void>((resolve) => {
        const done = () => worker.state === 'activated' || worker.state === 'redundant';
        if (done()) return resolve();
        worker.addEventListener('statechange', () => done() && resolve());
      });
    })(),
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ]);
}

/**
 * Reloads into the new version. Waits briefly for the new service worker, which caches the new
 * app shell as it installs, so the reload does not fall back to the previous version's copy.
 */
export async function reloadForUpdate(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (reg) await workerSettled(reg, WORKER_WAIT_MS);
  location.reload();
}

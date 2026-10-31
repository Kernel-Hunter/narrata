/* Narrata service worker: cross-origin isolation headers (COOP/COEP) for hosts that cannot set
   them, in the spirit of coi-serviceworker (MIT), and the offline cache.
   The build fills in VERSION, SHELL, PRECACHE and REVS (see vite.config.ts).

   Install caches only SHELL, the few files the page needs to start, so the worker takes control
   (and the page becomes cross-origin isolated) within seconds even on a slow link. The rest of the
   build (ONNX Runtime, pdf.js, pronunciation data, fonts, lazily loaded modules) is cached when
   first used, and the page asks for it to be cached in the background once the worker runs
   ('warm' message), so the app works offline after the first visit. */

const VERSION = '__VERSION__';
const SHELL = __SHELL__;
const PRECACHE = __PRECACHE__;
/** Short content hash of every built file, to reuse unchanged files from the previous version. */
const REVS = __REVS__;
const CACHE = `narrata-${VERSION}`;
const REV_HEADER = 'X-Narrata-Rev';

const abs = (p) => new URL(p, self.registration.scope).href;
const revByUrl = new Map(Object.entries(REVS).map(([p, r]) => [abs(p), r]));
const assetsPrefix = abs('./assets/');
const appUrls = new Set([abs('./'), abs('./index.html')]);
const versionUrl = abs('./version.json');
/** URL without query or fragment, the key files are cached under. */
const keyOf = (url) => {
  const u = new URL(url);
  return u.origin + u.pathname;
};
/** Vite puts a content hash in every file name under assets/, so those never change. */
const isHashed = (key) => key.startsWith(assetsPrefix);

/** Files being fetched into the cache, so a page request and the warm-up never download twice. */
const inflight = new Map();

self.addEventListener('install', (event) => {
  // Activate as soon as the shell is cached; a page still on the previous version keeps working
  // (see 'activate', which keeps the previous cache, and the fallback in asset()).
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(SHELL.map((p) => fetchInto(cache, abs(p), true)));
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      // Keep the cache of the version this one replaces (caches.keys() is in creation order): a
      // tab opened before the update may still load modules of that version. Older ones go.
      const old = (await caches.keys()).filter((k) => k.startsWith('narrata-') && k !== CACHE);
      for (const k of old.slice(0, -1)) await caches.delete(k);
    })(),
  );
});

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  // The page is up: cache the rest of the build without holding up anything else.
  if (type === 'warm') event.waitUntil(warm());
  // A page loaded without the worker (for example after a hard reload) asks to be controlled.
  else if (type === 'claim') event.waitUntil(self.clients.claim());
});

function isolate(response) {
  if (!response || response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withRev(response, rev) {
  if (!rev) return response;
  const headers = new Headers(response.headers);
  headers.set(REV_HEADER, rev);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * A file of this build cached by an earlier version with the same content: moved into the current
 * cache instead of downloaded again. Removed from the old cache, so only changed files stay there.
 */
async function fromOld(cache, key) {
  const rev = revByUrl.get(key);
  if (!rev) return null;
  for (const name of await caches.keys()) {
    if (name === CACHE || !name.startsWith('narrata-')) continue;
    const old = await caches.open(name);
    const hit = await old.match(key, { ignoreVary: true });
    if (hit && hit.headers.get(REV_HEADER) === rev) {
      await cache.put(key, hit.clone());
      await old.delete(key, { ignoreVary: true });
      return hit;
    }
  }
  return null;
}

/**
 * Fetches a file of the build into the cache (once, however many callers ask). Hashed files may
 * come from the HTTP cache; others are revalidated, so an earlier deploy's copy is never stored
 * under this version.
 */
function fetchInto(cache, key, strict = false) {
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      if (await fromOld(cache, key)) return;
      const res = await fetch(key, { cache: isHashed(key) ? 'default' : 'no-cache', credentials: 'same-origin' });
      if (!res.ok || res.status !== 200) throw new Error(`${res.status} ${key}`);
      await cache.put(key, withRev(res, revByUrl.get(key)));
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return strict ? p : p.catch(() => {});
}

let warming = null;
/** Caches every file of the build that is not cached yet, three at a time. */
function warm() {
  warming ??= (async () => {
    const cache = await caches.open(CACHE);
    const todo = [];
    for (const p of [...SHELL, ...PRECACHE]) {
      const key = abs(p);
      if (!(await cache.match(key, { ignoreVary: true }))) todo.push(key);
    }
    let i = 0;
    const lane = async () => {
      while (i < todo.length) await fetchInto(cache, todo[i++]);
    };
    await Promise.all([lane(), lane(), lane()]);
  })().finally(() => {
    warming = null;
  });
  return warming;
}

/** Any cached copy, of this version or the one before (a tab opened before an update). */
const anyCached = (req) => caches.match(req, { ignoreSearch: true, ignoreVary: true });

/**
 * Pages: the network first, so a new deploy's index.html is never paired with the previous
 * version's modules, then the cached copy (offline, or no answer within a few seconds).
 */
async function navigate(req) {
  const key = keyOf(req.url);
  const cache = await caches.open(CACHE);
  const cached = (await cache.match(key, { ignoreVary: true })) || (appUrls.has(key) ? await cache.match(abs('./'), { ignoreVary: true }) : undefined);
  const network = fetch(req, { cache: 'no-cache' });
  network.catch(() => {}); // answered from the cache after the timeout, then failed: nothing to do
  try {
    if (!cached) return isolate(await network);
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve(null), 4000)));
    const res = await Promise.race([network, late]);
    clearTimeout(timer);
    return isolate(res ?? cached);
  } catch (err) {
    if (cached) return isolate(cached);
    throw err;
  }
}

/** Files of the build: cache first. Other same-origin files: the network, with the headers. */
async function asset(req, event) {
  const key = keyOf(req.url);
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
  if (hit) return isolate(hit);
  const ours = revByUrl.has(key) || isHashed(key);
  if (ours && !req.headers.has('range')) {
    const pending = inflight.get(key);
    if (pending) {
      await pending.catch(() => {});
      const now = await cache.match(key, { ignoreVary: true });
      if (now) return isolate(now);
    }
    const moved = await fromOld(cache, key).catch(() => null);
    if (moved) return isolate(moved);
  }
  let res;
  try {
    res = await fetch(req, isHashed(key) || !revByUrl.has(key) ? undefined : { cache: 'no-cache' });
  } catch (err) {
    const old = await anyCached(req);
    if (old) return isolate(old);
    throw err;
  }
  if (res.status === 200 && res.type === 'basic' && ours && !req.headers.has('range') && !inflight.has(key)) {
    const p = cache
      .put(key, withRev(res.clone(), revByUrl.get(key)))
      .catch(() => {})
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    event.waitUntil(p);
  } else if (!res.ok && isHashed(key)) {
    // A module of the previous version, gone from the server after a deploy.
    const old = await anyCached(req);
    if (old) return isolate(old);
  }
  return isolate(res);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  // The page checks this file for a newer deploy, so it always comes from the network.
  if (keyOf(req.url) === versionUrl) return;
  event.respondWith(req.mode === 'navigate' ? navigate(req) : asset(req, event));
});

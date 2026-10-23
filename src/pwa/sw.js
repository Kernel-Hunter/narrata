/* Narrata service worker: offline cache for the app shell, and cross-origin isolation headers
   (COOP/COEP) for hosts that cannot set them, in the spirit of coi-serviceworker (MIT).
   The build fills in VERSION and PRECACHE (see vite.config.ts). */

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `narrata-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE.map((p) => new Request(new URL(p, self.registration.scope), { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith('narrata-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function isolate(response) {
  if (!response || response.status === 0 || response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // ignoreVary: hosts send "Vary: Origin" and module scripts carry an Origin header.
      let hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
      if (!hit && req.mode === 'navigate') hit = await cache.match(new URL('./', self.registration.scope).href, { ignoreVary: true });
      if (hit) return isolate(hit);
      try {
        return isolate(await fetch(req));
      } catch (err) {
        if (req.mode === 'navigate') {
          const shell = await cache.match(new URL('./index.html', self.registration.scope).href, { ignoreVary: true });
          if (shell) return isolate(shell);
        }
        throw err;
      }
    })(),
  );
});

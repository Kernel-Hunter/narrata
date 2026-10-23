// Registers the service worker. Static hosts such as GitHub Pages cannot send the
// Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers, so the service worker adds
// them to every response it serves (the same approach as coi-serviceworker). The first visit is
// not isolated yet; once the worker controls the page we reload one time.

const RELOAD_FLAG = 'narrata.coiReload';

export async function registerServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return true;
  try {
    const reg = await navigator.serviceWorker.register(new URL('./sw.js', document.baseURI), { scope: './' });
    if (self.crossOriginIsolated) {
      sessionStorage.removeItem(RELOAD_FLAG);
      return true;
    }
    if (sessionStorage.getItem(RELOAD_FLAG)) {
      // Already reloaded once and still not isolated (for example the browser refuses the
      // headers). Run single-threaded rather than loop.
      return true;
    }
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
        const sw = reg.installing ?? reg.waiting ?? reg.active;
        if (sw?.state === 'activated' && navigator.serviceWorker.controller) done();
        setTimeout(done, 8000);
      });
    }
    sessionStorage.setItem(RELOAD_FLAG, '1');
    location.reload();
    return false;
  } catch {
    return true;
  }
}

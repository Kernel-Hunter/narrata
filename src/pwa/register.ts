// Registers the service worker. Static hosts such as GitHub Pages cannot send the
// Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers, so the service worker adds
// them to every response it serves (the same approach as coi-serviceworker). The first visit is
// not isolated yet: the page waits until the worker controls it, then reloads once.
//
// The page gives up on isolation (and runs the voice on one thread) only when the browser really
// cannot do it: no service worker support, registration refused, or the page is controlled by the
// worker and still not isolated after a reload. A slow first install is not a reason; if it takes
// longer than WAIT_MS the app starts and isolation is marked pending (see isolationState).

const RELOADS = 'narrata.coiReloads';
/** Longest wait for the worker to take control on a first visit (the shell is small). */
const WAIT_MS = 30_000;
/** After this, show "Getting ready" instead of an empty page. */
const NOTICE_MS = 1000;
/** Ask the worker to cache the rest of the app this long after the page has loaded. */
const WARM_DELAY_MS = 4000;

/**
 * 'isolated': multi-threaded WebAssembly is available. 'pending': the service worker is still
 * installing, isolation follows after a reload. 'unavailable': this browser cannot isolate the page.
 */
export type Isolation = 'isolated' | 'pending' | 'unavailable';

let state: Isolation = self.crossOriginIsolated ? 'isolated' : 'unavailable';
const readyListeners: (() => void)[] = [];

export function isolationState(): Isolation {
  return state;
}

/** Called once if isolation was pending and the worker now controls the page (reload to use it). */
export function onIsolationReady(cb: () => void): void {
  readyListeners.push(cb);
}

/** Reloads into the isolated page, counting the attempt so a browser that refuses cannot loop. */
export function reloadForIsolation(): void {
  sessionStorage.setItem(RELOADS, String(reloadCount() + 1));
  location.reload();
}

function reloadCount(): number {
  return Number(sessionStorage.getItem(RELOADS)) || 0;
}

/** Once the page is idle, ask the active worker to cache the rest of the build for offline use. */
function warmWhenIdle() {
  const go = () =>
    setTimeout(() => {
      const idle = (self as unknown as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 0));
      idle(() => void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'warm' })), { timeout: 5000 });
    }, WARM_DELAY_MS);
  if (document.readyState === 'complete') go();
  else addEventListener('load', go, { once: true });
}

/** Resolves true when the worker controls the page, false after `ms`. */
function waitForControl(reg: ServiceWorkerRegistration, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (navigator.serviceWorker.controller) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
    // A worker is already active but this page loaded without it (a hard reload): ask it to
    // take control. A worker still installing claims every page itself when it activates.
    const claim = () => reg.active?.postMessage({ type: 'claim' });
    if (reg.active) claim();
    else void navigator.serviceWorker.ready.then(claim);
  });
}

function showGettingReady(root: HTMLElement): () => void {
  const timer = setTimeout(() => {
    const box = document.createElement('div');
    box.className = 'boot-wait';
    box.setAttribute('role', 'status');
    const title = document.createElement('p');
    title.className = 'boot-wait-title';
    title.textContent = 'Getting ready';
    const text = document.createElement('p');
    text.textContent = 'Setting up Narrata on this device. This happens once.';
    box.append(title, text);
    root.replaceChildren(box);
  }, NOTICE_MS);
  return () => {
    clearTimeout(timer);
    root.replaceChildren();
  };
}

/**
 * Registers the worker. Resolves true when the app should start, false when the page is about to
 * reload.
 */
export async function registerServiceWorker(root: HTMLElement): Promise<boolean> {
  if (!('serviceWorker' in navigator)) {
    state = self.crossOriginIsolated ? 'isolated' : 'unavailable';
    return true;
  }
  // Registering waits for sw.js itself, which takes a moment on a slow link.
  const hide = self.crossOriginIsolated ? () => {} : showGettingReady(root);
  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register(new URL('./sw.js', document.baseURI), { scope: './' });
  } catch {
    hide();
    state = self.crossOriginIsolated ? 'isolated' : 'unavailable';
    return true;
  }
  warmWhenIdle();
  if (self.crossOriginIsolated) {
    sessionStorage.removeItem(RELOADS);
    state = 'isolated';
    return true;
  }
  if (navigator.serviceWorker.controller) {
    // Controlled, so the headers were added, and still not isolated: the browser does not support
    // it. Reload once anyway in case the page came from an earlier worker without the headers.
    if (reloadCount() >= 1) {
      hide();
      state = 'unavailable';
      return true;
    }
    reloadForIsolation();
    return false;
  }
  if (reloadCount() >= 2) {
    // Reloaded twice and still not controlled (for example a private window that drops workers).
    hide();
    state = 'unavailable';
    return true;
  }
  const controlled = await waitForControl(reg, WAIT_MS);
  if (controlled) {
    reloadForIsolation();
    return false;
  }
  hide();
  // Still installing on a very slow link: start single-threaded for now, isolation follows.
  state = 'pending';
  navigator.serviceWorker.addEventListener('controllerchange', () => readyListeners.splice(0).forEach((cb) => cb()), { once: true });
  return true;
}

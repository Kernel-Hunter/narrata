import './styles/app.css';
import { onIsolationReady, registerServiceWorker, reloadForIsolation } from './pwa/register';
import { App } from './ui/app';
import { toast } from './ui/overlay';

const root = document.getElementById('app')!;

async function boot() {
  // In production the service worker adds the cross-origin isolation headers (needed for
  // multi-threaded WebAssembly) and caches the app for offline use. It may reload the page once.
  if (import.meta.env.PROD && !(await registerServiceWorker(root))) return;
  const app = new App(root);
  // The first install took very long and the app started single-threaded: offer the reload.
  onIsolationReady(() => toast('Narrata is ready to use all processor cores.', { action: 'Reload', onAction: reloadForIsolation, ms: 60_000 }));
  // Files opened with the installed app ("Open with Narrata").
  const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    const handle = params.files[0];
    if (handle) void app.openFile(await handle.getFile());
  });
  (window as unknown as { narrata: unknown }).narrata = { app, player: app.player, tts: app.tts, library: app.library };
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
    const { installDebug } = await import('./debug');
    installDebug(app);
  }
}

void boot();

// Launches Playwright's Chromium with a persistent profile and finds its browser process id.
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

export async function launchBrowser(userDataDir, { headless = true, args = [], ignoreDefaultArgs = [], serviceWorkers = 'block' } = {}) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: ['--autoplay-policy=no-user-gesture-required', ...args],
    ignoreDefaultArgs,
    // A service worker would keep serving an earlier build from its cache.
    serviceWorkers,
  });
  const out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.includes(`--user-data-dir=${userDataDir}`) && !l.includes('--type='));
  const pid = line ? Number(line.trim().split(/\s+/)[0]) : null;
  if (!pid) throw new Error('browser process not found');
  return { context, pid };
}

// Renders the extension's toolbar and store icons from public/icons/icon.svg.
// Run: node scripts/make-ext-icons.mjs (needs `pnpm exec playwright install chromium` once).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'public/icons/icon.svg'), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.locator('svg').screenshot({ path: join(root, `extension/logo/${size}.png`), omitBackground: true });
}
await browser.close();
console.log('wrote extension/logo/{16,32,48,128}.png');

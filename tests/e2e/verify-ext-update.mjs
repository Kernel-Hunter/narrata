// Checks the update notice in the extension popup, with GitHub's answer stubbed.
//
//   pnpm build:ext:test && node tests/e2e/verify-ext-update.mjs [--headed] [--shots DIR]
//
// Loads dist-ext-test/ unpacked in a fresh profile and opens the popup as a page: once with a
// release newer than the manifest version (the notice shows, and a second popup within the day
// does not ask GitHub again), once with the same version (no notice).
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extPath, launch, root, sleep } from './harness.mjs';

const args = process.argv.slice(2);
const headless = !args.includes('--headed');
const i = args.indexOf('--shots');
const shots = i >= 0 ? args[i + 1] : join(root, 'docs', 'screenshots');
mkdirSync(shots, { recursive: true });
const current = JSON.parse(readFileSync(join(extPath, 'manifest.json'), 'utf8')).version;
const bump = (v) => v.split('.').map((n, k) => (k === 1 ? Number(n) + 1 : k === 2 ? 0 : n)).join('.');

let failed = 0;
function check(name, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  ' + JSON.stringify(detail)}`);
}

/** A fresh profile whose popup sees `tag` as GitHub's latest release. */
async function run(tag, shot) {
  const profile = mkdtempSync(join(tmpdir(), 'narrata-ext-update-'));
  const ctx = await launch({ userDataDir: profile, headless });
  let calls = 0;
  await ctx.context.route('https://api.github.com/**', (route) => {
    calls++;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ tag_name: tag, html_url: `https://github.com/Kernel-Hunter/narrata/releases/tag/${tag}`, draft: false, prerelease: false }),
    });
  });
  const open = async () => {
    const popup = await ctx.context.newPage();
    await popup.setViewportSize({ width: 340, height: 600 });
    await popup.goto(`chrome-extension://${ctx.extId}/popup.html`);
    await sleep(1500);
    return popup;
  };
  const popup = await open();
  const box = popup.locator('#update');
  const result = { visible: await box.isVisible(), text: (await box.textContent()) ?? '', href: await popup.locator('#release-link').getAttribute('href').catch(() => null), calls };
  if (shot) await popup.screenshot({ path: join(shots, shot) });
  await popup.close();
  const again = await open();
  result.visibleAgain = await again.locator('#update').isVisible();
  result.callsAfterSecond = calls;
  await ctx.context.close();
  rmSync(profile, { recursive: true, force: true });
  return result;
}

const newer = bump(current);
const a = await run(`v${newer}`, 'ext-update-notice.png');
check(`a newer release (v${newer}, running v${current}) shows the notice`, a.visible && a.text.includes(`Update available: v${newer}`) && a.text.includes(`narrata-extension-${newer}.zip`), a);
check('the button opens the release page', a.href === `https://github.com/Kernel-Hunter/narrata/releases/tag/v${newer}`, a.href);
check('GitHub is asked once, the second popup uses the stored answer', a.calls === 1 && a.callsAfterSecond === 1 && a.visibleAgain, { calls: a.callsAfterSecond });
const b = await run(`v${current}`, 'ext-update-none.png');
check('no notice when up to date', !b.visible && b.calls === 1, b);
console.log(failed ? `${failed} check(s) failed` : 'All checks passed');
process.exit(failed ? 1 : 0);

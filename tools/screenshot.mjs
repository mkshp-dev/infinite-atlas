// Dev utility: drive the real app in headless Chromium, take screenshots and
// report console errors. Uses the Playwright copy cached on this machine.
//   node tools/screenshot.mjs [url]

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/homelab/.cache/mkshp-dev-run/node_modules/playwright');

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const out = '/tmp/atlas-shots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const logs = [];
page.on('console', (message) => logs.push(`[${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));

async function shot(name) {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`shot: ${out}/${name}.png`);
}

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(3000);
await shot('01-descent');
console.log('status:', await page.textContent('#status'));
console.log('seed:', await page.inputValue('#seed'));
console.log('position:', await page.textContent('#stat-pos'));
console.log('altitude:', await page.textContent('#stat-alt'));
console.log('zoom:', await page.textContent('#stat-scale'));
console.log('fps:', await page.textContent('#stat-fps'));

await page.click('#view-first');
await page.waitForTimeout(1000);
await shot('02-canopy-cam');

await page.click('#view-third');
await page.keyboard.down('d');
await page.waitForTimeout(900);
await page.keyboard.up('d');
await page.waitForTimeout(500);
await shot('03-steered');

await page.click('#new-seed');
await page.waitForTimeout(2200);
await shot('04-new-seed');
console.log('seed 2:', await page.inputValue('#seed'));

await page.click('#mode-atlas');
await page.waitForTimeout(1200);
await page.mouse.move(760, 460);
await page.mouse.wheel(0, -700);
await page.waitForTimeout(1500);
await shot('05-atlas');

await page.click('#mode-3d');
await page.waitForFunction(() => window.__atlas?.state?.view3d?.ready === true, null, {
  timeout: 30000,
});
await page.waitForTimeout(1200);
await shot('06-3d');
console.log('3D status:', await page.textContent('#status'));

await page.setViewportSize({ width: 420, height: 820 });
await page.waitForTimeout(1200);
await shot('07-mobile');

console.log('--- console ---');
console.log(logs.join('\n') || '(none)');

await browser.close();

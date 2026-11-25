// Dev utility: compare the same view at several zoom levels.
//   node tools/zoomcheck.mjs [seed] [x] [y]

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/homelab/.cache/mkshp-dev-run/node_modules/playwright');

const seed = process.argv[2] || 'frost-creek-33';
const x = process.argv[3] || '-2953.3';
const y = process.argv[4] || '-942.2';
const out = '/tmp/atlas-zoom';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

for (const z of [1, 2, 4, 8, 12, 16, 24, 32]) {
  await page.goto(`http://127.0.0.1:8123/?v=${z}#seed=${seed}&mode=atlas&x=${x}&y=${y}&z=${z}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('ready'), null, {
    timeout: 20000,
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/z${z}.png` });
  console.log(`z${z}: ${await page.textContent('#status')}`);
}

await browser.close();

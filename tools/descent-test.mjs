// Dev utility: exercise the descent experience (fall, steer, view toggle,
// atlas toggle, landing) and collect console errors plus screenshots.
//   node tools/descent-test.mjs [url]

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/homelab/.cache/mkshp-dev-run/node_modules/playwright');

const base = process.argv[2] || 'http://127.0.0.1:8123/';
const out = '/tmp/atlas-descent';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    errors.push(`[${message.type()}] ${message.text()}`);
  }
});
page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));

async function shot(name) {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`shot: ${out}/${name}.png`);
}

async function stats(label) {
  const info = await page.evaluate(() => {
    const s = window.__atlas?.state;
    return {
      mode: s?.mode,
      view: s?.view,
      altitude: Math.round(s?.descent?.altitude ?? -1),
      landed: s?.descent?.landed,
      x: Math.round(s?.descent?.x ?? 0),
      y: Math.round(s?.descent?.y ?? 0),
      zoom: s?.cam?.scale?.toFixed(2),
      status: document.querySelector('#status')?.textContent,
      altText: document.querySelector('#stat-alt')?.textContent,
      pending: window.__atlas?.engine?.pending ?? -1,
      cached: window.__atlas?.engine?.cached ?? -1,
      hash: location.hash,
    };
  });
  console.log(label, JSON.stringify(info));
  return info;
}

await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(
  () => document.querySelector('#status')?.textContent.includes('ready'),
  null,
  { timeout: 20000 },
);
await page.waitForTimeout(600);
await shot('01-descent');
const initial = await stats('initial');

// Steer right for a second: position should move, altitude should keep falling.
await page.keyboard.down('d');
await page.waitForTimeout(1200);
await page.keyboard.up('d');
const steered = await stats('steered');
console.log('steered right:', steered.x > initial.x, '| altitude fell:', steered.altitude < initial.altitude);

// Dive with shift.
await page.keyboard.down('Shift');
await page.waitForTimeout(1200);
await page.keyboard.up('Shift');
const dived = await stats('dived');
console.log('dive faster:', initial.altitude - dived.altitude > initial.altitude - steered.altitude);

// Canopy cam.
await page.click('#view-first');
await page.waitForTimeout(600);
await shot('02-canopy-cam');
const first = await stats('first-person');
console.log('first person:', first.view === 'first');

// Back to third person, then fast-forward to the ground.
await page.click('#view-third');
await page.evaluate(() => {
  const d = window.__atlas.state.descent;
  d.altitude = 24;
});
await page.waitForTimeout(400);
await shot('03-near-ground');
await page.waitForFunction(
  () => window.__atlas?.state?.descent?.landed === true,
  null,
  { timeout: 20000 },
);
await page.waitForTimeout(700);
await shot('04-landed');
const landed = await stats('landed');

// Atlas toggle: free roam must come back, with wheel zoom working.
await page.click('#mode-atlas');
await page.waitForTimeout(500);
const atlas = await stats('atlas');
await page.mouse.move(720, 450);
await page.mouse.wheel(0, -900);
await page.waitForTimeout(1200);
const zoomed = await stats('atlas-zoomed');
console.log('atlas mode:', atlas.mode === 'atlas', '| wheel zoom works:', zoomed.zoom > atlas.zoom);
await shot('05-atlas');

// Back to descent: a fresh drop from the current spot.
await page.click('#mode-descent');
await page.waitForTimeout(600);
const redrop = await stats('redrop');
console.log('fresh drop:', redrop.mode === 'descent' && redrop.altitude > 600);
await shot('06-redrop');

// Reload should restore mode, view and altitude.
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(
  () => document.querySelector('#status')?.textContent.includes('ready'),
  null,
  { timeout: 20000 },
);
const reloaded = await stats('reloaded');
console.log('reload kept mode:', reloaded.mode === redrop.mode, '| altitude close:', Math.abs(reloaded.altitude - redrop.altitude) < 30);

// Mobile.
await page.setViewportSize({ width: 420, height: 820 });
await page.waitForTimeout(900);
await shot('07-mobile');

await page.click('#view-first');
await page.waitForTimeout(700);
await shot('08-mobile-canopy');

console.log('--- errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');
await browser.close();

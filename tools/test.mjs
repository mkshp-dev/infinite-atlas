// Dev utility: exercise the app (zoom, pan, layers, seed, reload) and collect
// console errors plus a few screenshots.
//   node tools/test.mjs

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/homelab/.cache/mkshp-dev-run/node_modules/playwright');

const base = process.argv[2] || 'http://127.0.0.1:8123/';
const out = '/tmp/atlas-test';
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

async function waitReady(timeout = 15000) {
  await page.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('ready'),
    null,
    { timeout },
  );
}

async function stats(label) {
  const info = await page.evaluate(() => ({
    seed: document.querySelector('#seed').value,
    pos: document.querySelector('#stat-pos').textContent,
    zoom: document.querySelector('#stat-scale').textContent,
    detail: document.querySelector('#stat-level').textContent,
    fps: document.querySelector('#stat-fps').textContent,
    status: document.querySelector('#status').textContent,
    pending: window.__atlas?.engine?.pending ?? -1,
    cached: window.__atlas?.engine?.cached ?? -1,
    hash: location.hash,
  }));
  console.log(label, JSON.stringify(info));
  return info;
}

await page.goto(base, { waitUntil: 'load' });
await waitReady();
await page.screenshot({ path: `${out}/01-initial.png` });
const initial = await stats('initial');

// Hash + reload should restore the same world and view.
await page.reload({ waitUntil: 'load' });
await waitReady();
const reloaded = await stats('reloaded');
const posValue = (text) => text.replace(/,/g, '');
console.log(
  'reload preserved view:',
  reloaded.seed === initial.seed && posValue(reloaded.pos) === posValue(initial.pos),
);

// Far out.
await page.mouse.move(720, 450);
for (let i = 0; i < 3; i++) {
  await page.mouse.wheel(0, 1400);
  await page.waitForTimeout(120);
}
await waitReady();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/02-far.png` });
await stats('far');

// Back in, and deep.
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, -1400);
  await page.waitForTimeout(120);
}
await waitReady();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/03-deep.png` });
await stats('deep');

// Pan continuously across a few screens while watching fps.
for (let i = 0; i < 3; i++) {
  await page.mouse.move(200, 450);
  await page.mouse.down();
  for (let step = 0; step < 12; step++) {
    await page.mouse.move(200 + step * 90, 450 + Math.sin(step) * 100, { steps: 2 });
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
}
await waitReady();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/04-pan.png` });
await stats('panned');

// Layers off.
for (const id of ['#opt-relief', '#opt-shading', '#opt-contours', '#opt-grain']) {
  const exists = await page.$(id);
  if (exists) await exists.click();
}
console.log('layer checkboxes:', await page.evaluate(() => ({
  relief: document.querySelector('#opt-shading').checked,
  contours: document.querySelector('#opt-contours').checked,
  grain: document.querySelector('#opt-grain').checked,
})));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/05-layers.png` });
await stats('layers');

// Custom seed via input.
await page.fill('#seed', 'hollow-ridge-11');
await page.press('#seed', 'Enter');
await waitReady();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/06-custom-seed.png` });
const custom = await stats('custom');
console.log('custom seed applied:', custom.seed === 'hollow-ridge-11');

// Mobile layout.
await page.setViewportSize({ width: 420, height: 820 });
await page.waitForTimeout(700);
await page.screenshot({ path: `${out}/07-mobile.png` });

console.log('--- errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');
await browser.close();

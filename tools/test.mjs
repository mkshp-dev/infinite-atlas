// Dev utility: exercise both experiences (descent and atlas), including
// steering, diving, canopy cam, landing, zoom/pan, layers, seed and reload.
//   node tools/test.mjs [url]

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
      seed: document.querySelector('#seed')?.value,
      pos: document.querySelector('#stat-pos')?.textContent,
      altitude: Math.round(s?.descent?.altitude ?? -1),
      landed: s?.descent?.landed,
      zoom: Number(s?.cam?.scale?.toFixed(2)),
      detail: document.querySelector('#stat-level')?.textContent,
      fps: document.querySelector('#stat-fps')?.textContent,
      status: document.querySelector('#status')?.textContent,
      pending: window.__atlas?.engine?.pending ?? -1,
      cached: window.__atlas?.engine?.cached ?? -1,
      hash: location.hash,
    };
  });
  console.log(label, JSON.stringify(info));
  return info;
}

const waitReady = () =>
  page.waitForFunction(
    () => document.querySelector('#status')?.textContent.includes('ready'),
    null,
    { timeout: 20000 },
  );

await page.goto(base, { waitUntil: 'load' });
await waitReady();
await page.waitForTimeout(700);
await shot('01-descent');
const initial = await stats('initial');
console.log('starts in descent:', initial.mode === 'descent', '| airborne:', !initial.landed);

// Steering leans the canopy; altitude keeps falling.
await page.keyboard.down('d');
await page.waitForTimeout(1200);
await page.keyboard.up('d');
const steered = await stats('steered');
console.log('steering moved east:', steered.pos !== initial.pos, '| altitude fell:', steered.altitude < initial.altitude);

// Diving drops faster than gliding.
const glide = initial.altitude - steered.altitude;
await page.keyboard.down('Shift');
await page.waitForTimeout(1200);
await page.keyboard.up('Shift');
const dived = await stats('dived');
console.log('dive is faster:', steered.altitude - dived.altitude > glide);

// Canopy cam.
await page.click('#view-first');
await page.waitForTimeout(800);
await shot('02-canopy-cam');
const first = await stats('canopy-cam');
console.log('canopy cam on:', first.view === 'first');
await page.click('#view-third');

// Fast-forward to the ground.
await page.evaluate(() => {
  window.__atlas.state.descent.altitude = 20;
});
await page.waitForFunction(() => window.__atlas?.state?.descent?.landed === true, null, {
  timeout: 20000,
});
await page.waitForTimeout(700);
await shot('03-landed');
const landed = await stats('landed');
console.log('landed at ground level:', landed.altitude === 0 && landed.landed);

// Atlas mode: wheel zoom and drag pan must work again.
await page.click('#mode-atlas');
await page.waitForTimeout(500);
const atlas = await stats('atlas');
await page.mouse.move(720, 450);
await page.mouse.wheel(0, -900);
await page.waitForTimeout(1200);
const zoomed = await stats('atlas-zoomed');
console.log('atlas mode:', atlas.mode === 'atlas', '| wheel zoom works:', zoomed.zoom > atlas.zoom);

await page.mouse.move(800, 500);
await page.mouse.down();
await page.mouse.move(420, 330, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(700);
await shot('04-atlas');

// Layers and a custom seed in atlas mode.
for (const id of ['#opt-shading', '#opt-contours', '#opt-grain']) {
  const exists = await page.$(id);
  if (exists) await exists.click();
}
await page.waitForTimeout(600);
console.log('layer checkboxes:', await page.evaluate(() => ({
  relief: document.querySelector('#opt-shading').checked,
  contours: document.querySelector('#opt-contours').checked,
  grain: document.querySelector('#opt-grain').checked,
})));
await shot('05-layers');

await page.fill('#seed', 'hollow-ridge-11');
await page.press('#seed', 'Enter');
await waitReady();
await page.waitForTimeout(500);
const custom = await stats('custom-seed');
console.log('custom seed applied:', custom.seed === 'hollow-ridge-11');

// Back to descent: a fresh drop from the current spot.
await page.click('#mode-descent');
await page.waitForTimeout(500);
const redrop = await stats('redrop');
console.log('fresh drop:', redrop.mode === 'descent' && redrop.altitude > 600);

// Reload should restore mode, view and altitude.
await page.reload({ waitUntil: 'load' });
await waitReady();
await page.waitForTimeout(300);
const reloaded = await stats('reloaded');
console.log('reload kept mode:', reloaded.mode === 'descent', '| altitude close:', Math.abs(reloaded.altitude - redrop.altitude) < 40);
console.log('hash carries mode/view:', reloaded.hash.includes('mode=descent') && reloaded.hash.includes('view='));

// Mobile layout.
await page.setViewportSize({ width: 420, height: 820 });
await page.waitForTimeout(900);
await shot('06-mobile');

console.log('--- errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');
await browser.close();

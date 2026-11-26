// Dev utility: exercise the 3D terrain view, its controls and its isolation
// from the 2D atlas.
//   node tools/view3d-test.mjs [url]

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/home/homelab/.cache/mkshp-dev-run/node_modules/playwright');

const base = process.argv[2] || 'http://127.0.0.1:8123/';
const out = '/tmp/atlas-3d';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (message) => {
  // SwiftShader in headless Chromium logs driver performance warnings that are
  // not application errors.
  if (message.type() === 'error' && !message.text().includes('GL Driver Message')) {
    errors.push(`[${message.type()}] ${message.text()}`);
  }
});
page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));

async function shot(name) {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`shot: ${out}/${name}.png`);
}

async function waitReady() {
  await page.waitForFunction(() => window.__atlas?.state?.view3d?.ready === true, null, {
    timeout: 30000,
  });
  await page.waitForTimeout(400);
}

async function stats(label) {
  const info = await page.evaluate(() => {
    const s = window.__atlas?.state;
    const v = s?.view3d;
    const positions = v?.terrain?.geometry?.attributes?.position?.array;
    let signature = 0;
    if (positions) {
      for (let i = 1; i < positions.length; i += 997) signature += positions[i];
    }
    return {
      mode: s?.mode,
      seed: s?.seedText,
      ready: v?.ready ?? false,
      status: document.querySelector('#status')?.textContent,
      triangles: v?.triangles ?? 0,
      generationMs: v ? Math.round(v.generationMs) : 0,
      fps: Math.round(v?.fps ?? 0),
      distance: v ? Math.round(v.distance) : 0,
      yaw: v ? Number(v.yaw.toFixed(3)) : 0,
      camera: v ? v.camera.position.toArray().map((n) => Math.round(n)) : null,
      signature: Math.round(signature),
      canvasHidden: document.querySelector('#terrain3d')?.hidden,
      mapVisibility: getComputedStyle(document.querySelector('#map')).visibility,
      hash: location.hash,
    };
  });
  console.log(label, JSON.stringify(info));
  return info;
}

await page.goto(`${base}#seed=hollow-ridge-11&mode=3d&x=0&y=0&z=1`, { waitUntil: 'load' });
await waitReady();
await shot('01-terrain');
const initial = await stats('initial');
console.log(
  '3D rendered:',
  initial.mode === '3d' && initial.ready && initial.triangles > 0,
  '| canvas visible:',
  initial.canvasHidden === false,
  '| map hidden:',
  initial.mapVisibility === 'hidden',
);

// Orbit and dolly.
await page.mouse.move(800, 500);
await page.mouse.down();
await page.mouse.move(1010, 415, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(300);
const orbited = await stats('orbited');
console.log('drag orbited camera:', orbited.yaw !== initial.yaw && orbited.camera.join() !== initial.camera.join());

await page.mouse.move(720, 450);
await page.mouse.wheel(0, 520);
await page.waitForTimeout(300);
const dollied = await stats('dollied');
console.log('wheel changed distance:', dollied.distance > orbited.distance);
await shot('02-orbit');

// The atlas must come back exactly as before, and the 3D renderer must be gone.
await page.click('#mode-atlas');
await page.waitForTimeout(600);
const atlas = await stats('atlas');
console.log(
  'atlas restored:',
  atlas.mode === 'atlas' && atlas.canvasHidden === true && atlas.mapVisibility === 'visible',
  '| 3D disposed:',
  (await page.evaluate(() => window.__atlas.state.view3d === null)),
);
await page.mouse.move(720, 450);
await page.mouse.wheel(0, -900);
await page.waitForTimeout(1000);
const atlasZoom = await page.evaluate(() => window.__atlas.state.cam.scale);
console.log('atlas wheel zoom works:', atlasZoom > 1);
await shot('03-atlas');

// Back into 3D, same world.
await page.click('#mode-3d');
await waitReady();
const back = await stats('back');
console.log('3D rebuilt:', back.ready && back.mode === '3d');

// A new seed rebuilds the mesh and keeps the view working.
await page.fill('#seed', 'quiet-harbor-42');
await page.press('#seed', 'Enter');
await page.waitForFunction(
  () => window.__atlas?.state?.view3d?.ready === true && window.__atlas?.state?.seedText === 'quiet-harbor-42',
  null,
  { timeout: 30000 },
);
await page.waitForTimeout(500);
const seeded = await stats('new-seed');
console.log('seed changed terrain:', seeded.signature !== back.signature);
await shot('04-new-seed');

// Descent still works and gets a fresh drop.
await page.click('#mode-descent');
await page.waitForTimeout(700);
const descent = await stats('descent');
console.log(
  'descent restored:',
  descent.mode === 'descent' && descent.mapVisibility === 'visible' && descent.canvasHidden === true,
);

// Reload restores the 3D mode, seed and centre.
await page.click('#mode-3d');
await waitReady();
const beforeReload = await stats('before-reload');
await page.reload({ waitUntil: 'load' });
await waitReady();
const reloaded = await stats('reloaded');
console.log(
  'reload kept 3D:',
  reloaded.mode === '3d' &&
    reloaded.seed === beforeReload.seed &&
    reloaded.hash.includes('mode=3d'),
  '| terrain deterministic:',
  reloaded.signature === beforeReload.signature,
);

// A shared 3D link applied to the already-open page (hashchange) should move
// the patch without a reload.
await page.evaluate(() => {
  location.hash = '#seed=iron-mesa-77&mode=3d&x=900&y=-450&z=1';
});
await page.waitForFunction(
  () => window.__atlas?.state?.view3d?.ready === true && window.__atlas?.state?.seedText === 'iron-mesa-77',
  null,
  { timeout: 30000 },
);
await page.waitForTimeout(500);
const shared = await stats('shared-link');
const sharedCenter = await page.evaluate(() => window.__atlas.state.view3d.getCenter());
console.log(
  'shared link applied:',
  shared.mode === '3d' && shared.seed === 'iron-mesa-77',
  '| centre:',
  Math.round(sharedCenter.x),
  Math.round(sharedCenter.y),
  '| terrain changed:',
  shared.signature !== reloaded.signature,
);

// Mobile.
await page.setViewportSize({ width: 420, height: 820 });
await page.waitForTimeout(900);
await shot('05-mobile');

console.log('--- errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');
await browser.close();

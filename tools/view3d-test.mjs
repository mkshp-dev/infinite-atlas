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
    timeout: 45000,
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
    const st = v?.stats;
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
      chunks: st?.activeChunks ?? 0,
      pending: st?.pendingChunks ?? 0,
      lod: st?.lodCounts?.slice(0, 3) ?? [],
      center: v?.getCenter ? v.getCenter() : null,
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
try {
  await page.waitForFunction(
    () => window.__atlas?.state?.view3d?.ready === true && window.__atlas?.state?.seedText === 'iron-mesa-77',
    null,
    { timeout: 120000 },
  );
} catch (error) {
  // A stuck stream is a real failure, but print why instead of only a timeout.
  const state = await page.evaluate(() => {
    const v = window.__atlas?.state?.view3d;
    return {
      seed: window.__atlas?.state?.seedText,
      ready: v?.ready,
      status: v?.status,
      error: v?.error,
      chunks: v?.stats?.activeChunks,
      pending: v?.stats?.pendingChunks,
      queued: v?.stats?.queuedChunks,
      workers: v?.workers?.length,
      hash: location.hash,
    };
  });
  console.log('shared-link timeout:', JSON.stringify(state));
  console.log('errors so far:', errors.join('\n') || '(none)');
  throw error;
}
await page.waitForTimeout(900);
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

// Pan target to stream new chunks.
await page.setViewportSize({ width: 1440, height: 900 });
await page.click('#mode-3d');
await waitReady();
const beforePan = await page.evaluate(() => {
  const v = window.__atlas.state.view3d;
  return { center: v.getCenter(), chunks: v.stats.activeChunks, pending: v.stats.pendingChunks, lod: v.stats.lodCounts.slice(0,3) };
});
await page.mouse.move(720, 450);
await page.mouse.down({ button: 'right' });
await page.mouse.move(1040, 560, { steps: 20 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(1200);
const afterPan = await page.evaluate(() => {
  const v = window.__atlas.state.view3d;
  return { center: v.getCenter(), chunks: v.stats.activeChunks, pending: v.stats.pendingChunks, lod: v.stats.lodCounts.slice(0,3) };
});
console.log('panned target:', Math.hypot(afterPan.center.x - beforePan.center.x, afterPan.center.y - beforePan.center.y) > 100,
  '| chunks active:', afterPan.chunks > 0,
  '| lod levels:', afterPan.lod);
await shot('05-pan');

// --- 3D parachute descent ---------------------------------------------------
// The canopy is a constrained first-person camera: it drifts and steers, but
// cannot orbit, pan or dolly. Detail rises and the visible disc (chunk ring +
// fog) shrinks as the subject nears the ground.
const canopy = () =>
  page.evaluate(() => {
    const v = window.__atlas.state.view3d;
    const d = v.getDescent();
    return {
      active: d.active,
      landed: d.landed,
      altitude: d.altitude,
      yaw: d.yaw,
      base: d.baseYaw,
      max: d.maxYaw,
      x: d.x,
      z: d.z,
      vx: v.descent.vx,
      vz: v.descent.vz,
      radius: v.stats.radius,
      fogFar: v.scene.fog.far,
      clouds: v.cloudGroup.visible,
      chunks: v.stats.activeChunks,
      button: document.querySelector('#descend-3d')?.textContent,
      hint: document.querySelector('#hint')?.textContent,
    };
  });

await page.click('#descend-3d');
await page.waitForTimeout(600);
const canopyHigh = await canopy();
console.log(
  '3D descent started:',
  canopyHigh.active && canopyHigh.altitude < 640 && canopyHigh.altitude > 0,
  '| clouds:', canopyHigh.clouds,
  '| ring:', canopyHigh.radius,
  '| fog far:', Math.round(canopyHigh.fogFar),
  '| button:', canopyHigh.button,
);

// Look around: yaw stays inside the allowed cone.
await page.mouse.move(720, 450);
await page.mouse.down();
await page.mouse.move(1435, 430, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(150);
const canopyLook = await canopy();
console.log('canopy yaw clamped:', Math.abs(canopyLook.yaw - canopyLook.base) <= canopyLook.max + 0.001);

// No dolly, no pan: the canopy owns the camera.
const distBefore = await page.evaluate(() => window.__atlas.state.view3d.distance);
await page.mouse.move(720, 450);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(150);
const distAfter = await page.evaluate(() => window.__atlas.state.view3d.distance);
console.log('canopy wheel locked:', distBefore === distAfter);

// Steering is camera-relative: D must push the drift to the canopy's right.
const steerBefore = await canopy();
await page.keyboard.down('d');
await page.waitForTimeout(500);
await page.keyboard.up('d');
const steerAfter = await canopy();
const rightward = (s) => s.vx * Math.cos(s.yaw) - s.vz * Math.sin(s.yaw);
console.log('canopy steering:', rightward(steerAfter) > rightward(steerBefore) + 0.2);

// Drop low: the ring and fog contract.
await page.evaluate(() => {
  const v = window.__atlas.state.view3d;
  const c = v.getCenter();
  v.startDescent({ x: c.x, y: c.y, altitude: 130 });
});
await page.waitForTimeout(900);
const canopyLow = await canopy();
console.log(
  'canopy detail rises with altitude fall:',
  canopyLow.radius < canopyHigh.radius && canopyLow.fogFar < canopyHigh.fogFar,
  '| ring:', canopyLow.radius,
  '| fog far:', Math.round(canopyLow.fogFar),
);
await shot('06-canopy');

// Touchdown returns to the orbit camera.
await page.evaluate(() => {
  const v = window.__atlas.state.view3d;
  const c = v.getCenter();
  v.startDescent({ x: c.x, y: c.y, altitude: 62 });
});
await page.waitForFunction(() => window.__atlas.state.view3d.getDescent().landed === true, null, {
  timeout: 60000,
});
await page.waitForTimeout(500);
const landed = await canopy();
console.log(
  'canopy landed:',
  !landed.active && landed.landed,
  '| orbit fog restored:', landed.fogFar === 5632,
  '| clouds off:', !landed.clouds,
  '| button:', landed.button,
);
await shot('07-landed');

// Deterministic chunk edge sampling and LOD/eviction diagnostics.
const chunkCheck = await page.evaluate(async () => {
  const mod = await import('./js/terrain3d-data.js');
  const a = mod.buildTerrainChunk({ seed: 12345, cx: 0, cy: 0, lod: 0, chunkSize: 512, segments: 64, heightScale: 1250 });
  const b = mod.buildTerrainChunk({ seed: 12345, cx: 1, cy: 0, lod: 0, chunkSize: 512, segments: 64, heightScale: 1250 });
  const n = 65;
  let edgeMatch = true;
  for (let j = 0; j < n; j++) {
    const ah = a.positions[(j * n + (n - 1)) * 3 + 1];
    const bh = b.positions[(j * n + 0) * 3 + 1];
    if (Math.abs(ah - bh) > 1e-6) { edgeMatch = false; break; }
  }
  const v = window.__atlas.state.view3d;
  const stats = v.stats;
  const lodDiffOk = (() => {
    for (const c of v.chunks.values()) {
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        for (const o of v.chunks.values()) {
          if (o.cx === c.cx + dx && o.cy === c.cy + dy && Math.abs(o.lod - c.lod) > 1) return false;
        }
      }
    }
    return true;
  })();
  // The fine side of every LOD seam must sit on the coarse straight edge,
  // including the midpoints between coarse vertices, or the skirt shows
  // through as a dark line.
  const seamOk = (() => {
    const byCoord = new Map();
    for (const c of v.chunks.values()) byCoord.set(`${c.cx}:${c.cy}`, c);
    const yAt = (c, i, j) => {
      const n = c.sourceData.segments + 1;
      return c.mesh.geometry.getAttribute('position').getY(j * n + i);
    };
    for (const c of v.chunks.values()) {
      for (const [dx, dy, side] of [[1, 0, 'E'], [0, 1, 'S']]) {
        const nb = byCoord.get(`${c.cx + dx}:${c.cy + dy}`);
        if (!nb) continue;
        const fine = c.sourceData.segments >= nb.sourceData.segments ? c : nb;
        const coarse = fine === c ? nb : c;
        if (fine.sourceData.segments === coarse.sourceData.segments) continue;
        const ratio = fine.sourceData.segments / coarse.sourceData.segments;
        const fineIsC = fine === c;
        for (let k = 0; k <= fine.sourceData.segments; k++) {
          const ck = k / ratio;
          const k0 = Math.floor(ck);
          const k1 = Math.min(coarse.sourceData.segments, k0 + 1);
          const t = ck - k0;
          let fy;
          let cy;
          if (side === 'E' || side === 'W') {
            const fi = side === 'E' ? (fineIsC ? fine.sourceData.segments : 0) : (fineIsC ? 0 : fine.sourceData.segments);
            const ci = side === 'E' ? (fineIsC ? 0 : coarse.sourceData.segments) : (fineIsC ? coarse.sourceData.segments : 0);
            fy = yAt(fine, fi, k);
            cy = yAt(coarse, ci, k0) * (1 - t) + yAt(coarse, ci, k1) * t;
          } else {
            const fj = side === 'S' ? (fineIsC ? fine.sourceData.segments : 0) : (fineIsC ? 0 : fine.sourceData.segments);
            const cj = side === 'S' ? (fineIsC ? 0 : coarse.sourceData.segments) : (fineIsC ? coarse.sourceData.segments : 0);
            fy = yAt(fine, k, fj);
            cy = yAt(coarse, k0, cj) * (1 - t) + yAt(coarse, k1, cj) * t;
          }
          if (Math.abs(fy - cy) > 0.01) return false;
        }
      }
    }
    return true;
  })();
  return { edgeMatch, seamOk, active: stats.activeChunks, pending: stats.pendingChunks, lod: stats.lodCounts.slice(0,3), lodDiffOk };
});
console.log('chunk edges deterministic:', chunkCheck.edgeMatch, '| seam gap closed:', chunkCheck.seamOk, '| lod diff <=1:', chunkCheck.lodDiffOk, '| stats:', chunkCheck.active, chunkCheck.pending, chunkCheck.lod);

const vegCheck = await page.evaluate(async () => {
  const v = window.__atlas.state.view3d;
  const stats = v.stats;
  const veg = stats.vegetation;
  const mod = await import('./js/vegetation.js');
  const a = mod.buildVegetationChunk({ seed: 123, cx: 0, cy: 0, chunkSize: 512 });
  const b = mod.buildVegetationChunk({ seed: 123, cx: 0, cy: 0, chunkSize: 512 });
  let det = a.total === b.total;
  for (const k of Object.keys(a.instances)) {
    const A=a.instances[k], B=b.instances[k];
    if (A.length !== B.length) det = false;
    for (let i=0;i<A.length && det;i++) if (A[i]!==B[i]) det=false;
  }
  let lodOk = veg.lodDist.length === 3;
  let meshLodOk = true;
  let meshCount = 0;
  v.vegetationGroup.traverse((o) => {
    if (!o.isInstancedMesh) return;
    meshCount += 1;
    if (![0, 1, 2].includes(o.userData.lodLevel)) meshLodOk = false;
    if (!o.userData.vegType) meshLodOk = false;
  });
  // Camera must stay above the sampled terrain surface.
  const world = await import('./js/world.js');
  const cam = v.camera.position;
  const ground = (world.elevationAt(cam.x, cam.z, v.seed, 6) - world.SEA_LEVEL) * v.heightScale;
  const camAboveGround = cam.y >= ground - 1;
  return {
    det,
    trees: veg.treeInstances,
    grass: veg.groundInstances,
    vegChunks: veg.chunks,
    batches: veg.batches,
    lodDist: veg.lodDist,
    lodOk,
    meshLodOk,
    meshCount,
    camAboveGround,
  };
});
console.log(
  'vegetation deterministic:', vegCheck.det,
  '| trees:', vegCheck.trees,
  '| ground:', vegCheck.grass,
  '| vegChunks:', vegCheck.vegChunks,
  '| batches:', vegCheck.batches,
  '| LOD bands:', vegCheck.lodDist.join('/'),
  '| lod meta ok:', vegCheck.lodOk && vegCheck.meshLodOk,
  '| camera above ground:', vegCheck.camAboveGround,
);

// Mobile.
await page.setViewportSize({ width: 420, height: 820 });
await page.waitForTimeout(900);
await shot('08-mobile');

console.log('--- errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');
await browser.close();

import assert from 'node:assert/strict';
import { buildVegetationChunk } from '../js/vegetation.js';
import { SEA_LEVEL, biomeAt, elevationAt, moistureAt } from '../js/world.js';

const CHUNK = 512;
const SEED = 42;

function posSet(inst) {
  const s = new Set();
  for (let i = 0; i < inst.length; i += 7) s.add(`${inst[i].toFixed(3)},${inst[i + 2].toFixed(3)}`);
  return s;
}

function findChunk(seed, minTotal = 10) {
  for (let x = -10; x <= 10; x++) {
    for (let y = -10; y <= 10; y++) {
      const c = buildVegetationChunk({ seed, cx: x, cy: y, chunkSize: CHUNK });
      if (c.total > minTotal) return { c, x, y };
    }
  }
  throw new Error('no vegetated chunk found');
}

const { c: a, x: cx, y: cy } = findChunk(SEED);

// --- Determinism -----------------------------------------------------------
const b = buildVegetationChunk({ seed: SEED, cx, cy, chunkSize: CHUNK });
assert.equal(a.total, b.total, 'deterministic total');
for (const k of Object.keys(a.instances)) {
  assert.equal(a.instances[k].length, b.instances[k].length, `len ${k}`);
  for (let i = 0; i < a.instances[k].length; i++) {
    assert.equal(a.instances[k][i], b.instances[k][i], `val ${k} ${i}`);
  }
}

// Same result even if the chunk is requested after a distant neighbour.
buildVegetationChunk({ seed: SEED, cx: cx + 7, cy: cy - 4, chunkSize: CHUNK });
const late = buildVegetationChunk({ seed: SEED, cx, cy, chunkSize: CHUNK });
assert.equal(late.total, a.total, 'generation order must not matter');
for (const k of Object.keys(a.instances)) {
  assert.deepEqual(Array.from(late.instances[k]), Array.from(a.instances[k]), `order ${k}`);
}

// --- Chunk boundaries ------------------------------------------------------
for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
  const neighbour = buildVegetationChunk({ seed: SEED, cx: cx + dx, cy: cy + dy, chunkSize: CHUNK });
  for (const k of Object.keys(a.instances)) {
    const sa = posSet(a.instances[k]);
    const sb = posSet(neighbour.instances[k] || new Float32Array());
    for (const p of sa) assert.ok(!sb.has(p), `duplicate across boundary ${k} ${p}`);
  }
}

// Every instance belongs to exactly the chunk that owns its coordinates.
for (const [type, arr] of Object.entries(a.instances)) {
  for (let i = 0; i < arr.length; i += 7) {
    const x = arr[i];
    const z = arr[i + 2];
    assert.ok(x >= cx * CHUNK && x < (cx + 1) * CHUNK, `${type} x outside chunk`);
    assert.ok(z >= cy * CHUNK && z < (cy + 1) * CHUNK, `${type} z outside chunk`);
    assert.ok(arr[i + 3] > 0, `${type} scale must be positive`);
    assert.ok(arr[i + 6] > 0, `${type} needs at least one LOD mask`);
  }
}

// --- Biome / terrain suitability ------------------------------------------
for (const [type, arr] of Object.entries(a.instances)) {
  for (let i = 0; i < arr.length; i += 7) {
    const x = arr[i];
    const z = arr[i + 2];
    const e = elevationAt(x, z, SEED, 6);
    const m = moistureAt(x, z, SEED);
    assert.ok(e > SEA_LEVEL, `${type} must not grow in water (${x},${z})`);
    const biome = biomeAt(e, m);
    assert.ok(biome !== 'ocean' && biome !== 'shallows', `${type} must not grow in ${biome}`);
    if (type !== 'grass') {
      assert.ok(biome !== 'snow', `${type} must not grow on snow`);
      const t = (e - SEA_LEVEL) / (1 - SEA_LEVEL);
      assert.ok(t <= 0.87, `${type} must stay below the snow line`);
    }
  }
}

// Dense biomes must out-produce open ones.
function countTrees(chunk) {
  return ['broadleaf', 'tall', 'tropical', 'small'].reduce(
    (n, k) => n + (chunk.instances[k]?.length || 0) / 7,
    0,
  );
}
let dense = null;
let open = null;
for (let x = -10; x <= 10 && !(dense && open); x++) {
  for (let y = -10; y <= 10; y++) {
    const chunk = buildVegetationChunk({ seed: SEED, cx: x, cy: y, chunkSize: CHUNK });
    const mid = { x: x * CHUNK + 256, y: y * CHUNK + 256 };
    const e = elevationAt(mid.x, mid.y, SEED, 6);
    if (e <= SEA_LEVEL) continue;
    const biome = biomeAt(e, moistureAt(mid.x, mid.y, SEED));
    if (!dense && (biome === 'woodland' || biome === 'jungle') && countTrees(chunk) > 100) dense = { biome, chunk };
    if (!open && biome === 'meadow' && countTrees(chunk) < 60) open = { biome, chunk };
  }
}
assert.ok(dense, 'expected a woodland/jungle chunk with dense trees');
assert.ok(open, 'expected an open meadow chunk');
assert.ok(
  countTrees(dense.chunk) > countTrees(open.chunk),
  `dense biome should have more trees (${dense.biome} ${countTrees(dense.chunk)} vs ${open.biome} ${countTrees(open.chunk)})`,
);

// --- Seed changes ----------------------------------------------------------
const diffSeed = buildVegetationChunk({ seed: SEED + 1, cx, cy, chunkSize: CHUNK });
let changed = diffSeed.total !== a.total;
if (!changed) {
  outer: for (const k of Object.keys(a.instances)) {
    const A = a.instances[k];
    const B = diffSeed.instances[k];
    if (A.length !== B.length) {
      changed = true;
      break;
    }
    for (let i = 0; i < A.length; i++) {
      if (A[i] !== B[i]) {
        changed = true;
        break outer;
      }
    }
  }
}
assert.ok(changed, 'seed should change vegetation');

console.log('vegetation-test ok', {
  chunk: `${cx}:${cy}`,
  total: a.total,
  trees: countTrees(a),
  dense: `${dense.biome} ${countTrees(dense.chunk)}`,
  open: `${open.biome} ${countTrees(open.chunk)}`,
});

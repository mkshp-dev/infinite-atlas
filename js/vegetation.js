// Deterministic vegetation placement for 3D chunks.
//
// This module has no Three.js dependency. It samples the shared world API and
// returns compact typed arrays describing instance transforms for chunk-local
// vegetation. Placement is based on absolute world coordinates so chunk borders
// and regeneration order do not affect results.

import { clamp, hash2i, lerp, smoothstep, valueNoise2 } from './noise.js';
import { SEA_LEVEL, biomeAt, elevationAt, moistureAt } from './world.js';
import { TERRAIN3D_DEFAULTS } from './terrain3d-data.js';

export const VEGETATION_DEFAULTS = {
  cellSize: 12,
  // Unitless elevation gradient limit (d(elevation)/d(world unit)). This is
  // independent of heightScale, unlike a world-height slope.
  maxSlope: 0.0025,
  snowLine: 0.86,
  maxTrees: 2200,
  maxShrubs: 700,
  maxGrass: 2400,
};

const BIOME_RULES = {
  ocean: { trees: 0, grass: 0, shrubs: 0 },
  shallows: { trees: 0, grass: 0, shrubs: 0 },
  beach: { trees: 0.01, grass: 0.12, shrubs: 0.03 },
  meadow: { trees: 0.07, grass: 0.78, shrubs: 0.14 },
  woodland: { trees: 0.52, grass: 0.6, shrubs: 0.22 },
  jungle: { trees: 0.68, grass: 0.72, shrubs: 0.26 },
  rock: { trees: 0.02, grass: 0.08, shrubs: 0.03 },
  snow: { trees: 0, grass: 0, shrubs: 0 },
};

function hash3(x, y, z) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return (n ^ (n >>> 16)) >>> 0;
}

// Unitless gradient of the shared elevation field. Uses the same 5-octave
// sampling as the world's biome query; the 6-octave surface height is sampled
// separately at the exact instance position.
function slopeAt(wx, wy, seed) {
  const d = 2.5;
  const e = elevationAt(wx, wy, seed, 5);
  const ex = elevationAt(wx + d, wy, seed, 5);
  const ey = elevationAt(wx, wy + d, seed, 5);
  return Math.hypot(ex - e, ey - e) / d;
}

function pickTreeType(biome, r) {
  if (biome === 'jungle') return r < 0.5 ? 'tropical' : r < 0.82 ? 'broadleaf' : 'tall';
  if (biome === 'woodland') return r < 0.5 ? 'broadleaf' : r < 0.78 ? 'tall' : 'small';
  if (biome === 'meadow') return r < 0.72 ? 'small' : 'broadleaf';
  if (biome === 'beach') return 'small';
  return 'small';
}

function densityFor(biome, e, m, wx, wy, seed) {
  const base = BIOME_RULES[biome] || BIOME_RULES.meadow;
  const t = (e - SEA_LEVEL) / Math.max(1e-6, 1 - SEA_LEVEL);
  // Broad forest clumps plus local clearings. Both are smooth fields, so
  // density fades across biome borders instead of stopping at a hard line.
  const forestNoise = valueNoise2(wx / 240, wy / 240, seed ^ 0x71ee);
  const clearing = smoothstep(0.18, 0.55, forestNoise);
  const moistureBoost = smoothstep(0.35, 0.75, m);
  const altPenalty = smoothstep(0.72, 0.86, t);
  let trees = base.trees;
  if (biome === 'woodland' || biome === 'jungle') {
    trees *= lerp(0.45, 1.3, clearing) * lerp(0.8, 1.15, moistureBoost);
  } else if (biome === 'meadow') {
    trees *= lerp(0.4, 1.15, moistureBoost) * (1 - altPenalty * 0.6);
  } else {
    trees *= 1 - altPenalty;
  }
  const grass = base.grass * lerp(0.7, 1.2, moistureBoost) * (1 - altPenalty * 0.75);
  const shrubs = base.shrubs * lerp(0.75, 1.15, forestNoise) * (1 - altPenalty);
  return { trees: clamp(trees, 0, 1), grass: clamp(grass, 0, 1), shrubs: clamp(shrubs, 0, 1) };
}

function pushInstance(lists, type, x, y, z, scale, rot, colorVar, lodMask) {
  lists[type].push(x, y, z, scale, rot, colorVar, lodMask);
}

function lodMaskFor(r, kind) {
  // Near is always visible. Mid/far are probabilistic subsets, so distant
  // chunks keep the same world-space instances but render fewer of them.
  let mask = 1;
  if (kind === 'tree') {
    if (r < 0.74) mask |= 2;
    if (r < 0.38) mask |= 4;
  } else {
    if (r < 0.5) mask |= 2;
    if (r < 0.18) mask |= 4;
  }
  return mask;
}

export function buildVegetationChunk({
  seed,
  cx,
  cy,
  chunkSize = TERRAIN3D_DEFAULTS.chunkSize,
  heightScale = TERRAIN3D_DEFAULTS.heightScale,
  cellSize = VEGETATION_DEFAULTS.cellSize,
}) {
  const started = performance.now();
  const originX = cx * chunkSize;
  const originY = cy * chunkSize;
  const minCellX = Math.floor(originX / cellSize);
  const maxCellX = Math.floor((originX + chunkSize - 1e-6) / cellSize);
  const minCellY = Math.floor(originY / cellSize);
  const maxCellY = Math.floor((originY + chunkSize - 1e-6) / cellSize);
  const lists = {
    broadleaf: [], tall: [], tropical: [], small: [],
    grass: [], shrub: [],
  };
  let treeCount = 0;
  let shrubCount = 0;
  let grassCount = 0;

  for (let gcy = minCellY; gcy <= maxCellY; gcy++) {
    for (let gcx = minCellX; gcx <= maxCellX; gcx++) {
      const cellX = gcx * cellSize;
      const cellY = gcy * cellSize;
      const h = hash3(gcx, gcy, seed ^ 0x76656731);
      const jx = (h & 1023) / 1024;
      const jy = ((h >>> 10) & 1023) / 1024;
      const wx = cellX + jx * cellSize;
      const wy = cellY + jy * cellSize;
      if (wx < originX || wy < originY || wx >= originX + chunkSize || wy >= originY + chunkSize) continue;

      // Surface height must match the terrain mesh exactly: same seed and the
      // same 6-octave sampling used by buildTerrainChunk.
      const e = elevationAt(wx, wy, seed, 6);
      if (e <= SEA_LEVEL + 0.004) continue;
      const t = (e - SEA_LEVEL) / (1 - SEA_LEVEL);
      if (t > VEGETATION_DEFAULTS.snowLine) continue;
      if (slopeAt(wx, wy, seed) > VEGETATION_DEFAULTS.maxSlope) continue;

      const m = moistureAt(wx, wy, seed);
      const biome = biomeAt(e, m);
      const dens = densityFor(biome, e, m, wx, wy, seed);
      const r1 = hash3(gcx, gcy, seed ^ 0x76656732) / 4294967296;
      const r2 = hash3(gcx, gcy, seed ^ 0x76656733) / 4294967296;
      const r3 = hash3(gcx, gcy, seed ^ 0x76656734) / 4294967296;
      const r4 = hash3(gcx, gcy, seed ^ 0x76656735) / 4294967296;
      const r5 = hash3(gcx, gcy, seed ^ 0x76656736) / 4294967296;
      const surfaceY = (e - SEA_LEVEL) * heightScale;

      if (r1 < dens.trees && treeCount < VEGETATION_DEFAULTS.maxTrees) {
        const type = pickTreeType(biome, r2);
        const scale = lerp(0.75, 1.3, r3) * (biome === 'jungle' ? 1.12 : 1);
        const rot = r4 * Math.PI * 2;
        const colorVar = lerp(-0.08, 0.1, valueNoise2(wx / 60, wy / 60, seed ^ 0x0c01));
        pushInstance(lists, type, wx, surfaceY, wy, scale, rot, colorVar, lodMaskFor(r5, 'tree'));
        treeCount += 1;
      } else if (r1 < dens.trees + dens.shrubs * 0.5 && shrubCount < VEGETATION_DEFAULTS.maxShrubs) {
        const scale = lerp(0.55, 1.15, r3);
        const rot = r4 * Math.PI * 2;
        const colorVar = lerp(-0.06, 0.08, r2);
        pushInstance(lists, 'shrub', wx, surfaceY, wy, scale, rot, colorVar, lodMaskFor(r5, 'ground'));
        shrubCount += 1;
      }

      // Grass clumps. Only cells that pass the suitability checks get any, and
      // the count is capped so a single chunk cannot grow without bound.
      if (r2 < dens.grass) {
        const clumps = 1 + Math.floor(r3 * 2.4);
        for (let i = 0; i < clumps && grassCount < VEGETATION_DEFAULTS.maxGrass; i++) {
          const gr = hash3(gcx, gcy, seed ^ (0xabc0 + i * 97)) / 4294967296;
          const gr2 = hash3(gcx, gcy, seed ^ (0xdef0 + i * 131)) / 4294967296;
          const gr3 = hash3(gcx, gcy, seed ^ (0xf120 + i * 17)) / 4294967296;
          const ox = (gr - 0.5) * cellSize * 0.9;
          const oy = (gr2 - 0.5) * cellSize * 0.9;
          const gxw = wx + ox;
          const gyw = wy + oy;
          if (gxw < originX || gyw < originY || gxw >= originX + chunkSize || gyw >= originY + chunkSize) continue;
          const ge = elevationAt(gxw, gyw, seed, 6);
          if (ge <= SEA_LEVEL + 0.004) continue;
          const gt = (ge - SEA_LEVEL) / (1 - SEA_LEVEL);
          if (gt > 0.84) continue;
          const gh = (ge - SEA_LEVEL) * heightScale;
          const gs = lerp(0.55, 1.25, gr3);
          const grot = gr * Math.PI * 2;
          const gc = lerp(-0.05, 0.08, gr2);
          pushInstance(lists, 'grass', gxw, gh, gyw, gs, grot, gc, lodMaskFor(gr3, 'ground'));
          grassCount += 1;
        }
      }
    }
  }

  const out = {};
  let total = 0;
  for (const [type, arr] of Object.entries(lists)) {
    const floats = new Float32Array(arr);
    out[type] = floats;
    total += floats.length / 7;
  }

  return {
    type: 'vegetation',
    key: `${cx}:${cy}`,
    cx, cy,
    chunkSize,
    instances: out,
    total,
    counts: { trees: treeCount, shrubs: shrubCount, grass: grassCount },
    generationMs: performance.now() - started,
  };
}

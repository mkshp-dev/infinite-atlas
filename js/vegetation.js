// Deterministic vegetation placement for 3D chunks.
//
// This module has no Three.js dependency. It samples the shared world API and
// returns compact typed arrays describing instance transforms for chunk-local
// vegetation. Placement is based on absolute world coordinates so chunk borders
// and regeneration order do not affect results.

import { clamp, hash2i, lerp, smoothstep, valueNoise2 } from './noise.js';
import { SEA_LEVEL, elevationAt, moistureAt } from './world.js';
import { TERRAIN3D_DEFAULTS } from './terrain3d-data.js';

function hash3(x, y, z) {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return (n ^ (n >>> 16)) >>> 0;
}

export const VEGETATION_DEFAULTS = {
  cellSize: 18,
  maxSlope: 0.72,
  snowLine: 0.86,
  rockLine: 0.75,
};

const BIOME_RULES = {
  ocean: { trees: 0, grass: 0, shrubs: 0 },
  shallows: { trees: 0, grass: 0, shrubs: 0 },
  beach: { trees: 0.002, grass: 0.02, shrubs: 0.006 },
  meadow: { trees: 0.018, grass: 0.22, shrubs: 0.03 },
  woodland: { trees: 0.085, grass: 0.16, shrubs: 0.045 },
  jungle: { trees: 0.13, grass: 0.2, shrubs: 0.055 },
  rock: { trees: 0.006, grass: 0.02, shrubs: 0.008 },
  snow: { trees: 0, grass: 0, shrubs: 0 },
};

// Keep in sync with world.js thresholds, duplicated here to avoid extra imports
// and keep vegetation sampling cheap and explicit.
function biomeAt(e, m) {
  if (e < SEA_LEVEL) return (SEA_LEVEL - e) / SEA_LEVEL < 0.014 ? 'shallows' : 'ocean';
  const t = (e - SEA_LEVEL) / (1 - SEA_LEVEL);
  if (t < 0.022) return 'beach';
  if (t > 0.88) return 'snow';
  if (t > 0.76) return 'rock';
  if (m > 0.55) return 'jungle';
  if (m > 0.4) return 'woodland';
  return 'meadow';
}

function slopeAt(wx, wy, seed, heightScale) {
  const d = 2.5;
  const hL = (elevationAt(wx - d, wy, seed, 5) - SEA_LEVEL) * heightScale;
  const hR = (elevationAt(wx + d, wy, seed, 5) - SEA_LEVEL) * heightScale;
  const hD = (elevationAt(wx, wy - d, seed, 5) - SEA_LEVEL) * heightScale;
  const hU = (elevationAt(wx, wy + d, seed, 5) - SEA_LEVEL) * heightScale;
  return Math.hypot(hR - hL, hU - hD) / (d * 2);
}

function pickTreeType(biome, r) {
  if (biome === 'jungle') return r < 0.55 ? 'tropical' : r < 0.85 ? 'broadleaf' : 'tall';
  if (biome === 'woodland') return r < 0.55 ? 'broadleaf' : r < 0.8 ? 'tall' : 'small';
  if (biome === 'meadow') return r < 0.7 ? 'small' : 'broadleaf';
  if (biome === 'beach') return 'small';
  return 'small';
}

function densityFor(biome, e, m, wx, wy, seed) {
  const base = BIOME_RULES[biome] || BIOME_RULES.meadow;
  const t = (e - SEA_LEVEL) / Math.max(1e-6, 1 - SEA_LEVEL);
  const forestNoise = valueNoise2(wx / 220, wy / 220, seed ^ 0x71ee);
  const clearing = smoothstep(0.22, 0.5, forestNoise);
  const moistureBoost = smoothstep(0.35, 0.75, m);
  const altPenalty = smoothstep(0.72, 0.86, t);
  let trees = base.trees;
  if (biome === 'woodland' || biome === 'jungle') {
    trees *= lerp(0.35, 1.25, clearing) * lerp(0.75, 1.2, moistureBoost);
  } else if (biome === 'meadow') {
    trees *= lerp(0.4, 1.1, moistureBoost) * (1 - altPenalty * 0.6);
  } else {
    trees *= 1 - altPenalty;
  }
  const grass = base.grass * lerp(0.65, 1.25, moistureBoost) * (1 - altPenalty * 0.8);
  const shrubs = base.shrubs * lerp(0.7, 1.15, forestNoise) * (1 - altPenalty);
  return { trees: clamp(trees, 0, 1), grass: clamp(grass, 0, 1), shrubs: clamp(shrubs, 0, 1) };
}

function pushInstance(arrays, type, x, y, z, scale, rot, colorVar, lodMask = 0b111) {
  arrays[type].push(x, y, z, scale, rot, colorVar, lodMask);
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

      const e = elevationAt(wx, wy, seed, 5);
      if (e <= SEA_LEVEL + 0.004) continue;
      const m = moistureAt(wx, wy, seed);
      const biome = biomeAt(e, m);
      const t = (e - SEA_LEVEL) / (1 - SEA_LEVEL);
      if (t > VEGETATION_DEFAULTS.snowLine) continue;
      const slope = slopeAt(wx, wy, seed, heightScale);
      if (slope > VEGETATION_DEFAULTS.maxSlope) continue;

      const dens = densityFor(biome, e, m, wx, wy, seed);
      const r1 = hash3(gcx, gcy, seed ^ 0x76656732) / 4294967296;
      const r2 = hash3(gcx, gcy, seed ^ 0x76656733) / 4294967296;
      const r3 = hash3(gcx, gcy, seed ^ 0x76656734) / 4294967296;
      const r4 = hash3(gcx, gcy, seed ^ 0x76656735) / 4294967296;
      const surfaceY = (e - SEA_LEVEL) * heightScale;

      if (r1 < dens.trees) {
        const type = pickTreeType(biome, r2);
        const scale = lerp(0.7, 1.35, r3) * (biome === 'jungle' ? 1.15 : biome === 'small' ? 0.9 : 1);
        const rot = r4 * Math.PI * 2;
        const colorVar = lerp(-0.08, 0.1, valueNoise2(wx / 50, wy / 50, seed ^ 0x0c01));
        // LOD mask: near=bit0, mid=bit1, far=bit2
        const lodMask = biome === 'jungle' || biome === 'woodland' ? 0b111 : 0b011;
        pushInstance(lists, type, wx, surfaceY, wy, scale, rot, colorVar, lodMask);
      } else if (r1 < dens.trees + dens.shrubs * 0.35) {
        const scale = lerp(0.5, 1.1, r3);
        const rot = r4 * Math.PI * 2;
        const colorVar = lerp(-0.06, 0.08, r2);
        pushInstance(lists, 'shrub', wx, surfaceY, wy, scale, rot, colorVar, 0b011);
      }

      // Grass/ground cover: multiple clumps in same cell for dense biomes.
      const grassCount = Math.floor(dens.grass * 3 + (r2 < dens.grass ? 1 : 0));
      for (let i = 0; i < grassCount; i++) {
        const gr = hash3(gcx, gcy, seed ^ (0xabc0 + i * 97)) / 4294967296;
        const gr2 = hash3(gcx, gcy, seed ^ (0xdef0 + i * 131)) / 4294967296;
        const gr3 = hash3(gcx, gcy, seed ^ (0xf120 + i * 17)) / 4294967296;
        if (gr > dens.grass * 1.2) continue;
        const ox = (gr2 - 0.5) * cellSize * 0.9;
        const oy = (gr3 - 0.5) * cellSize * 0.9;
        const gxw = wx + ox;
        const gyw = wy + oy;
        if (gxw < originX || gyw < originY || gxw >= originX + chunkSize || gyw >= originY + chunkSize) continue;
        const ge = elevationAt(gxw, gyw, seed, 5);
        if (ge <= SEA_LEVEL + 0.004) continue;
        const gt = (ge - SEA_LEVEL) / (1 - SEA_LEVEL);
        if (gt > 0.84) continue;
        const gh = (ge - SEA_LEVEL) * heightScale;
        const gs = lerp(0.45, 1.1, gr);
        const grot = gr2 * Math.PI * 2;
        const gc = lerp(-0.05, 0.08, gr3);
        // grass only near/mid
        pushInstance(lists, 'grass', gxw, gh, gyw, gs, grot, gc, 0b011);
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
    generationMs: performance.now() - started,
  };
}

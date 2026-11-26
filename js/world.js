// World: the procedural landscape as a pure, rendering-independent function.
//
// The 2D atlas and the 3D terrain view both read from this module, so a seed
// means the same world to every renderer. Nothing here touches a canvas.

import { clamp, lerp, smoothstep, fbm, valueNoise2 } from './noise.js';

export const SEA_LEVEL = 0.5;

// Base wavelength of the continent shapes, in world units.
const BASE_SCALE = 1050;

// Elevation ------------------------------------------------------------------

export function elevationAt(x, y, seed, octaves = 6) {
  // A slow domain warp bends the coastline into bays and peninsulas instead of
  // letting the noise lattice show through.
  const wx = x + 340 * (valueNoise2(x / 2900, y / 2900, seed ^ 0x51ed) - 0.5);
  const wy = y + 340 * (valueNoise2(x / 2900, y / 2900, seed ^ 0xa17e) - 0.5);

  let e = fbm(wx / BASE_SCALE, wy / BASE_SCALE, seed, octaves);

  // fBm is naturally low-contrast; stretch it so we get real lowlands and peaks.
  e = 0.5 + (e - 0.5) * 1.75;
  // Compress the upper range: highlands stay special instead of covering half
  // the continent, which keeps the map green and the peaks worth reaching.
  if (e > 0.5) {
    const u = (e - 0.5) * 2;
    e = 0.5 + 0.5 * u * Math.sqrt(u);
  }
  return clamp(e, 0, 1);
}

export function moistureAt(x, y, seed) {
  // Two scales: broad climate belts plus local woodland/meadow patches.
  const broad = fbm(x / 2600 + 31.7, y / 2600 - 12.3, seed ^ 0x6d2b, 3);
  const local = fbm(x / 340 - 9.1, y / 340 + 4.4, seed ^ 0x3c91, 3);
  const m = broad * 0.62 + local * 0.38;
  return clamp(0.5 + (m - 0.5) * 2.1, 0, 1);
}

// Biomes ---------------------------------------------------------------------

export const BIOMES = ['ocean', 'shallows', 'beach', 'meadow', 'woodland', 'jungle', 'rock', 'snow'];

export function biomeAt(e, m) {
  if (e < SEA_LEVEL) {
    return (SEA_LEVEL - e) / SEA_LEVEL < 0.014 ? 'shallows' : 'ocean';
  }
  const t = (e - SEA_LEVEL) / (1 - SEA_LEVEL);
  if (t < 0.022) return 'beach';
  if (t > 0.88) return 'snow';
  if (t > 0.76) return 'rock';
  if (m > 0.55) return 'jungle';
  if (m > 0.4) return 'woodland';
  return 'meadow';
}

// A compact palette for the 3D renderer. The 2D map keeps its own cartographic
// shading, but both use the same elevation/moisture fields and biome thresholds.
const C = {
  abyss: [12, 34, 51],
  deep: [19, 60, 78],
  sea: [31, 96, 110],
  shoal: [66, 146, 144],
  sand: [199, 187, 150],
  sandWet: [186, 173, 143],
  grassDry: [166, 165, 116],
  grass: [122, 150, 90],
  grassWet: [92, 126, 78],
  forest: [62, 94, 61],
  forestDeep: [47, 75, 53],
  moor: [122, 125, 97],
  rock: [124, 121, 111],
  rockHigh: [132, 127, 116],
  snow: [228, 231, 231],
};

function mixInto(out, a, b, t) {
  out[0] = lerp(a[0], b[0], t);
  out[1] = lerp(a[1], b[1], t);
  out[2] = lerp(a[2], b[2], t);
}

// Write an RGB triple (0..255) for an elevation/moisture sample.
export function terrainColorAt(e, m, out = [0, 0, 0]) {
  if (e < SEA_LEVEL) {
    const depth = smoothstep(0, 0.75, (SEA_LEVEL - e) / SEA_LEVEL);
    if (depth < 0.18) mixInto(out, C.shoal, C.sea, depth / 0.18);
    else if (depth < 0.55) mixInto(out, C.sea, C.deep, (depth - 0.18) / 0.37);
    else mixInto(out, C.deep, C.abyss, (depth - 0.55) / 0.45);
    return out;
  }

  const t = (e - SEA_LEVEL) / (1 - SEA_LEVEL);

  // Sand at the waterline, grass and forest through the lowlands, then moor,
  // rock and snow on the high ground.
  if (t < 0.03) mixInto(out, C.sandWet, C.sand, smoothstep(0, 0.03, t));
  else if (t < 0.16) mixInto(out, C.sand, C.grassDry, smoothstep(0.03, 0.16, t));
  else if (t < 0.36) mixInto(out, C.grassDry, C.grass, smoothstep(0.16, 0.36, t));
  else if (t < 0.6) mixInto(out, C.grass, C.forest, smoothstep(0.36, 0.6, t));
  else if (t < 0.76) mixInto(out, C.forest, C.moor, smoothstep(0.6, 0.76, t));
  else if (t < 0.9) mixInto(out, C.moor, C.rockHigh, smoothstep(0.76, 0.9, t));
  else mixInto(out, C.rockHigh, C.snow, smoothstep(0.9, 0.99, t));

  // Moisture darkens and greens the lowlands. Snow and bare rock ignore it.
  const veg = smoothstep(0.04, 0.22, t) * (1 - smoothstep(0.62, 0.8, t));
  const wet = smoothstep(0.34, 0.72, m) * veg;
  mixInto(out, out, m > 0.55 ? C.forestDeep : C.grassWet, wet * 0.5);
  return out;
}

// Shared world handle --------------------------------------------------------

export function createWorld(seed) {
  return {
    seed,
    elevationAt: (x, y, octaves = 6) => elevationAt(x, y, seed, octaves),
    moistureAt: (x, y) => moistureAt(x, y, seed),
    biomeAt: (x, y) => biomeAt(elevationAt(x, y, seed, 5), moistureAt(x, y, seed)),
    colorAt: (x, y, out) => terrainColorAt(elevationAt(x, y, seed, 5), moistureAt(x, y, seed), out),
  };
}

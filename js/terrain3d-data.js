// Terrain mesh data for the 3D view.
//
// This module is shared by the terrain worker and the main-thread fallback. It
// samples the same world functions as the 2D atlas and returns plain typed
// arrays, so no Three.js object is created off the main thread.

import { clamp, valueNoise2 } from './noise.js';
import { SEA_LEVEL, elevationAt, moistureAt, terrainColorAt } from './world.js';

export const TERRAIN3D_DEFAULTS = {
  // Legacy single-patch defaults kept for compatibility with older tools/tests.
  size: 3000,
  segments: 192,
  heightScale: 1250,
  // Chunked terrain defaults.
  chunkSize: 512,
  maxLod: 2,
  // Segments per LOD level, highest detail first. Powers of two so coarser
  // edges are a subset of finer edges.
  lodSegments: [64, 32, 16],
};

const sRGBToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function chunkKey(cx, cy, lod) {
  return `${lod}:${cx}:${cy}`;
}

export function chunkOrigin(cx, cy, chunkSize = TERRAIN3D_DEFAULTS.chunkSize) {
  return { x: cx * chunkSize, y: cy * chunkSize };
}

export function buildTerrainChunk({
  seed,
  cx,
  cy,
  lod = 0,
  chunkSize = TERRAIN3D_DEFAULTS.chunkSize,
  segments = TERRAIN3D_DEFAULTS.lodSegments[lod] ?? TERRAIN3D_DEFAULTS.lodSegments.at(-1),
  heightScale = TERRAIN3D_DEFAULTS.heightScale,
  skirtDepth = Math.max(140, heightScale * 0.4),
  skirts = true,
}) {
  const started = performance.now();
  const n = segments + 1;
  const count = n * n;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const indices = new Uint32Array(segments * segments * 6);

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  const rgb = [0, 0, 0];
  const originX = cx * chunkSize;
  const originY = cy * chunkSize;
  const step = chunkSize / segments;

  for (let j = 0; j < n; j++) {
    const wy = originY + j * step;
    for (let i = 0; i < n; i++) {
      const wx = originX + i * step;
      const e = elevationAt(wx, wy, seed, 6);
      const m = moistureAt(wx, wy, seed);
      const h = (e - SEA_LEVEL) * heightScale;
      const k = j * n + i;
      const o = k * 3;

      positions[o] = wx;
      positions[o + 1] = h;
      positions[o + 2] = wy;

      terrainColorAt(e, m, rgb);

      // A little broad mottling stops the vertex colours reading as smooth
      // gradients across the whole mesh.
      const tex =
        valueNoise2(wx / 46, wy / 46, seed ^ 0x3f17) * 0.6 +
        valueNoise2(wx / 17, wy / 17, seed ^ 0x173f) * 0.4;
      const k2 = 1 + (tex - 0.5) * 0.16;
      colors[o] = sRGBToLinear(clamp((rgb[0] * k2) / 255, 0, 1));
      colors[o + 1] = sRGBToLinear(clamp((rgb[1] * k2) / 255, 0, 1));
      colors[o + 2] = sRGBToLinear(clamp((rgb[2] * k2) / 255, 0, 1));

      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  let t = 0;
  for (let j = 0; j < segments; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[t++] = a;
      indices[t++] = c;
      indices[t++] = b;
      indices[t++] = b;
      indices[t++] = c;
      indices[t++] = d;
    }
  }

  const center = (segments >> 1) * n + (segments >> 1);
  const skirt = skirts
    ? buildSkirt({ positions, colors, segments, minHeight, skirtDepth })
    : null;

  return {
    type: 'chunk',
    key: chunkKey(cx, cy, lod),
    cx,
    cy,
    lod,
    originX,
    originY,
    chunkSize,
    segments,
    heightScale,
    positions,
    colors,
    indices,
    skirtPositions: skirt?.positions ?? null,
    skirtColors: skirt?.colors ?? null,
    skirtIndices: skirt?.indices ?? null,
    minHeight,
    maxHeight,
    centerHeight: positions[center * 3 + 1],
    generationMs: performance.now() - started,
  };
}

function buildSkirt({ positions, colors, segments, minHeight, skirtDepth }) {
  const n = segments + 1;
  const bottomY = Math.min(0, minHeight) - skirtDepth;
  const ring = [];
  for (let i = 0; i < n; i++) ring.push(i);
  for (let j = 1; j < n; j++) ring.push(j * n + (n - 1));
  for (let i = n - 2; i >= 0; i--) ring.push((n - 1) * n + i);
  for (let j = n - 2; j >= 1; j--) ring.push(j * n);

  const count = ring.length;
  const skirtPositions = new Float32Array(count * 6);
  const skirtColors = new Float32Array(count * 6);
  const skirtIndices = new Uint32Array(count * 6);
  const deep = [0.008, 0.035, 0.055];

  for (let k = 0; k < count; k++) {
    const source = ring[k] * 3;
    const o = k * 6;
    skirtPositions[o] = positions[source];
    skirtPositions[o + 1] = positions[source + 1];
    skirtPositions[o + 2] = positions[source + 2];
    skirtPositions[o + 3] = positions[source];
    skirtPositions[o + 4] = bottomY;
    skirtPositions[o + 5] = positions[source + 2];

    skirtColors[o] = colors[source];
    skirtColors[o + 1] = colors[source + 1];
    skirtColors[o + 2] = colors[source + 2];
    skirtColors[o + 3] = deep[0];
    skirtColors[o + 4] = deep[1];
    skirtColors[o + 5] = deep[2];
  }

  for (let k = 0; k < count; k++) {
    const next = (k + 1) % count;
    const a = k * 2;
    const b = a + 1;
    const c = next * 2;
    const d = c + 1;
    const o = k * 6;
    skirtIndices[o] = a;
    skirtIndices[o + 1] = b;
    skirtIndices[o + 2] = c;
    skirtIndices[o + 3] = c;
    skirtIndices[o + 4] = b;
    skirtIndices[o + 5] = d;
  }

  return { positions: skirtPositions, colors: skirtColors, indices: skirtIndices };
}

// Backward-compatible wrapper for the original single-patch 3D view/tests.
export function buildTerrainGrid({
  seed,
  centerX,
  centerY,
  size = TERRAIN3D_DEFAULTS.size,
  segments = TERRAIN3D_DEFAULTS.segments,
  heightScale = TERRAIN3D_DEFAULTS.heightScale,
}) {
  const chunk = buildTerrainChunk({
    seed,
    cx: 0,
    cy: 0,
    lod: 0,
    chunkSize: size,
    segments,
    heightScale,
    skirts: false,
  });
  const half = size / 2;
  const positions = chunk.positions.slice();
  const count = (segments + 1) * (segments + 1);
  for (let i = 0; i < count; i++) {
    positions[i * 3] -= half;
    positions[i * 3 + 2] -= half;
  }
  return {
    ...chunk,
    positions,
    size,
    originX: centerX - half,
    originY: centerY - half,
  };
}

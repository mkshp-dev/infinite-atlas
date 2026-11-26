// Terrain mesh data for the 3D view.
//
// This module is shared by the terrain worker and the main-thread fallback. It
// samples the same world functions as the 2D atlas and returns plain typed
// arrays, so no Three.js object is created off the main thread.

import { clamp, valueNoise2 } from './noise.js';
import { SEA_LEVEL, elevationAt, moistureAt, terrainColorAt } from './world.js';

export const TERRAIN3D_DEFAULTS = {
  size: 3000,
  segments: 192,
  heightScale: 1250,
};

const sRGBToLinear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function buildTerrainGrid({
  seed,
  centerX,
  centerY,
  size = TERRAIN3D_DEFAULTS.size,
  segments = TERRAIN3D_DEFAULTS.segments,
  heightScale = TERRAIN3D_DEFAULTS.heightScale,
}) {
  const started = performance.now();
  const n = segments + 1;
  const count = n * n;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const indices = new Uint32Array(segments * segments * 6);

  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let centerHeight = 0;
  let centerIndex = -1;
  const rgb = [0, 0, 0];
  const half = size / 2;
  const step = size / segments;

  for (let j = 0; j < n; j++) {
    const vz = j * step - half;
    const wy = centerY + vz;
    for (let i = 0; i < n; i++) {
      const vx = i * step - half;
      const wx = centerX + vx;
      const e = elevationAt(wx, wy, seed, 6);
      const m = moistureAt(wx, wy, seed);
      const h = (e - SEA_LEVEL) * heightScale;
      const k = j * n + i;
      const o = k * 3;

      positions[o] = vx;
      positions[o + 1] = h;
      positions[o + 2] = vz;

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
      if (i === segments >> 1 && j === segments >> 1) {
        centerHeight = h;
        centerIndex = k;
      }
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

  return {
    positions,
    colors,
    indices,
    minHeight,
    maxHeight,
    centerHeight,
    centerIndex,
    segments,
    size,
    heightScale,
    generationMs: performance.now() - started,
  };
}

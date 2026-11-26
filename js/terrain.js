// Terrain: the whole world as a pure function of (x, y, seed).
//
// renderRegion() paints an arbitrary rectangle of world space into RGBA pixels.
// The tile layer calls it with tile-sized rectangles; the preview tool calls it
// with whole-screen rectangles. Nothing is stored between calls, so the map is
// infinite in every direction and identical for a given seed.

import { clamp, lerp, smoothstep, valueNoise2, hash2i } from './noise.js';
import { SEA_LEVEL, elevationAt, moistureAt } from './world.js';

// Keep the historical terrain.js exports working for the tile pipeline and the
// preview tool while the shared world module owns the generation itself.
export { SEA_LEVEL, elevationAt, moistureAt };

export const TILE_SIZE = 256;

// Detail octaves follow the zoom level, so each pixel sees roughly the same
// amount of structure and hill shading stays legible at every scale.
export function octavesForWorldPerPixel(worldPerPixel) {
  const level = Math.round(Math.log2(1 / worldPerPixel));
  return clamp(8 + level, 5, 15);
}

// Palette --------------------------------------------------------------------

const C = {
  abyss: [12, 34, 51],
  deep: [19, 60, 78],
  sea: [31, 96, 110],
  shoal: [66, 146, 144],
  foam: [196, 221, 205],

  sandWet: [186, 173, 143],
  sand: [199, 187, 150],

  grassDry: [166, 165, 116],
  grass: [122, 150, 90],
  grassWet: [92, 126, 78],

  forest: [62, 94, 61],
  forestDeep: [47, 75, 53],

  moor: [122, 125, 97],
  rock: [124, 121, 111],
  rockHigh: [132, 127, 116],
  rockPeak: [148, 143, 131],
  snow: [228, 231, 231],
};

// Stops are [elevation 0..1, colour]. Colours are interpolated in between.
const LAND_STOPS = [
  [0.0, C.grass],
  [0.34, C.forest],
  [0.62, C.moor],
  [0.78, C.rock],
  [0.9, C.rockHigh],
  [1.0, C.rockPeak],
];

const WATER_STOPS = [
  [0.0, C.shoal],
  [0.1, C.sea],
  [0.45, C.deep],
  [1.0, C.abyss],
];

function gradientInto(stops, t, out) {
  if (t <= stops[0][0]) {
    out[0] = stops[0][1][0];
    out[1] = stops[0][1][1];
    out[2] = stops[0][1][2];
    return;
  }
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0);
      out[0] = lerp(c0[0], c1[0], k);
      out[1] = lerp(c0[1], c1[1], k);
      out[2] = lerp(c0[2], c1[2], k);
      return;
    }
  }
  const last = stops[stops.length - 1][1];
  out[0] = last[0];
  out[1] = last[1];
  out[2] = last[2];
}

// Bilinear sampling of the half-resolution moisture buffer.
function sampleMoisture(grid, gw, gh, u, v) {
  const x0 = clamp(Math.floor(u), 0, gw - 1);
  const y0 = clamp(Math.floor(v), 0, gh - 1);
  const x1 = Math.min(x0 + 1, gw - 1);
  const y1 = Math.min(y0 + 1, gh - 1);
  const fx = clamp(u - x0, 0, 1);
  const fy = clamp(v - y0, 0, 1);
  const a = grid[y0 * gw + x0];
  const b = grid[y0 * gw + x1];
  const c = grid[y1 * gw + x0];
  const d = grid[y1 * gw + x1];
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fy;
}

const SHADE_STRENGTH = 105;

// Tiles are painted independently, so anything that looks at a neighbouring
// pixel (blur, hill-shade gradient, contour edge detection) would otherwise see
// a clamped edge and leave a visible grid seam. Render a small border of extra
// world around each tile and crop it away again.
const PAD = 4;

export function renderRegion({
  x0,
  y0,
  width,
  height,
  worldPerPixel,
  seed,
  shading = true,
  contours = true,
  grain = true,
}) {
  const W = width + PAD * 2;
  const H = height + PAD * 2;
  const x0p = x0 - PAD * worldPerPixel;
  const y0p = y0 - PAD * worldPerPixel;
  const count = W * H;
  const heights = new Float32Array(count);
  const level = Math.round(Math.log2(1 / worldPerPixel));
  const octaves = octavesForWorldPerPixel(worldPerPixel);
  const gradStep = level >= 2 ? 2 : 3;
  // Exaggerate micro-relief as we zoom in; otherwise a plain at 10x looks
  // like a flat green screen. The clamp keeps it from turning into noise.
  const shadeStrength = SHADE_STRENGTH * (1 + Math.max(0, level) * 0.3);

  // Pass 1: elevation at full resolution (needed for contours + hill shading).
  // At close range we add a couple of high-frequency detail fields. They are
  // pure functions of world position too, just too small to see when zoomed out.
  const addFine = level >= 1;
  const addFinest = level >= 4;
  // Rolling micro-relief for close views: too small to matter when zoomed out,
  // but it stops lowlands from turning into a flat green wall at 8x-16x.
  const addRolling = level >= 2;
  for (let j = 0; j < H; j++) {
    const wy = y0p + (j + 0.5) * worldPerPixel;
    const row = j * W;
    for (let i = 0; i < W; i++) {
      const wx = x0p + (i + 0.5) * worldPerPixel;
      let e = elevationAt(wx, wy, seed, octaves);
      if (addRolling) {
        const rolling =
          valueNoise2(wx / 95, wy / 95, seed ^ 0x2a1f) * 0.6 +
          valueNoise2(wx / 34, wy / 34, seed ^ 0x1f2a) * 0.4;
        e += (rolling - 0.5) * 0.032;
      }
      if (addFine) {
        const fine =
          valueNoise2(wx / 3.4, wy / 3.4, seed ^ 0x6f1d) * 0.62 +
          valueNoise2(wx / 1.7, wy / 1.7, seed ^ 0x1d6f) * 0.38;
        e += (fine - 0.5) * 0.0075;
        if (addFinest) {
          const finest =
            valueNoise2(wx / 0.9, wy / 0.9, seed ^ 0x3b71) * 0.6 +
            valueNoise2(wx / 0.45, wy / 0.45, seed ^ 0x71b3) * 0.4;
          e += (finest - 0.5) * 0.005;
        }
        e = clamp(e, 0, 1);
      }
      heights[row + i] = e;
    }
  }

  // Moisture only drives colour, so sample it at half resolution and blur it
  // with bilinear lookup. Four times cheaper, visually identical.
  const mw = Math.ceil(W / 2);
  const mh = Math.ceil(H / 2);
  const moisture = new Float32Array(mw * mh);
  for (let j = 0; j < mh; j++) {
    const wy = y0p + (j * 2 + 1) * worldPerPixel;
    for (let i = 0; i < mw; i++) {
      const wx = x0p + (i * 2 + 1) * worldPerPixel;
      moisture[j * mw + i] = moistureAt(wx, wy, seed);
    }
  }

  // A light blur of the height field gives hill shading the look of broad
  // landforms instead of per-pixel static.
  let shadeHeights = heights;
  if (shading) {
    shadeHeights = new Float32Array(count);
    for (let j = 0; j < H; j++) {
      const row = j * W;
      for (let i = 0; i < W; i++) {
        const xm = i > 0 ? i - 1 : 0;
        const xp = i < W - 1 ? i + 1 : W - 1;
        const ym = j > 0 ? j - 1 : 0;
        const yp = j < H - 1 ? j + 1 : H - 1;
        const a = heights[ym * W + xm] + 2 * heights[ym * W + i] + heights[ym * W + xp];
        const b = heights[row + xm] + 2 * heights[row + i] + heights[row + xp];
        const c = heights[yp * W + xm] + 2 * heights[yp * W + i] + heights[yp * W + xp];
        shadeHeights[row + i] = (a + 2 * b + c) / 16;
      }
    }
  }

  const out = new Uint8ClampedArray(width * height * 4);
  const rgb = [0, 0, 0];
  const pixelX0 = Math.round(x0p / worldPerPixel);
  const pixelY0 = Math.round(y0p / worldPerPixel);

  const contourStep = 0.045;
  const waterStep = 0.06;
  // At far zoom a constant-width beach reads as a bright outline around every
  // island, so tone it down (cartographic generalisation).
  const beachStrength = level <= -2 ? 0.4 : level === -1 ? 0.85 : 1;
  const foamStrength = level <= -2 ? 0.11 : 0.2;

  for (let j = 0; j < height; j++) {
    const pj = j + PAD;
    const row = pj * W;
    const my = pj * 0.5 - 0.25;
    for (let i = 0; i < width; i++) {
      const pi = i + PAD;
      const idx = row + pi;
      const e = heights[idx];
      const m = sampleMoisture(moisture, mw, mh, pi * 0.5 - 0.25, my);

      let r;
      let g;
      let b;
      let isWater = false;

      const xm = pi - gradStep;
      const xp = pi + gradStep;
      const ym = pj - gradStep;
      const yp = pj + gradStep;
      const gx = (shadeHeights[row + xp] - shadeHeights[row + xm]) / (xp - xm);
      const gy = (shadeHeights[yp * W + pi] - shadeHeights[ym * W + pi]) / (yp - ym);

      if (e < SEA_LEVEL) {
        isWater = true;
        const depth = (SEA_LEVEL - e) / SEA_LEVEL;
        gradientInto(WATER_STOPS, smoothstep(0, 0.75, depth), rgb);
        r = rgb[0];
        g = rgb[1];
        b = rgb[2];

        // A pale line of surf right at the waterline.
        if (e > SEA_LEVEL - 0.0045) {
          const k = foamStrength;
          r = lerp(r, C.foam[0], k);
          g = lerp(g, C.foam[1], k);
          b = lerp(b, C.foam[2], k);
        }
      } else {
        const t = (e - SEA_LEVEL) / (1 - SEA_LEVEL);

        // Moisture picks the vegetation along the same elevation gradient.
        const vegDry = 0.07;
        const vegWet = 0.3;
        gradientInto(LAND_STOPS, t, rgb);
        r = rgb[0];
        g = rgb[1];
        b = rgb[2];

        if (t > vegDry && t < vegWet + 0.15) {
          const k = smoothstep(vegDry, vegWet, t) * (1 - smoothstep(0.4, 0.55, t));
          const wet = m;
          const vr = lerp(C.grassDry[0], C.grassWet[0], wet);
          const vg = lerp(C.grassDry[1], C.grassWet[1], wet);
          const vb = lerp(C.grassDry[2], C.grassWet[2], wet);
          const fr = lerp(C.forest[0], C.forestDeep[0], wet);
          const fg = lerp(C.forest[1], C.forestDeep[1], wet);
          const fb = lerp(C.forest[2], C.forestDeep[2], wet);
          const mixK = smoothstep(0.16, 0.36, t);
          r = lerp(r, lerp(vr, fr, mixK), k);
          g = lerp(g, lerp(vg, fg, mixK), k);
          b = lerp(b, lerp(vb, fb, mixK), k);
        }

        // Beach width in pixels, estimated as height above sea divided by the
        // local slope. Flat ground just above sea level stays meadow instead of
        // smearing into a giant sand flat, and steep coasts get a thin strip.
        const shoreDistance = (e - SEA_LEVEL) / (Math.abs(gx) + Math.abs(gy) + 1e-5);
        if (shoreDistance < 3.2) {
          const sandK = (1 - smoothstep(0.5, 3.2, shoreDistance)) * beachStrength;
          const wetK = 1 - smoothstep(0.15, 0.9, shoreDistance);
          r = lerp(r, lerp(C.sand[0], C.sandWet[0], wetK), sandK);
          g = lerp(g, lerp(C.sand[1], C.sandWet[1], wetK), sandK);
          b = lerp(b, lerp(C.sand[2], C.sandWet[2], wetK), sandK);
        }

        // Snow cap: broken into patches so high ground reads as rock and snow
        // rather than a flat white plateau.
        const snowLine = 0.91 + (m - 0.5) * 0.04;
        if (t > snowLine - 0.1) {
          const wx = x0p + (pi + 0.5) * worldPerPixel;
          const wy = y0p + (pj + 0.5) * worldPerPixel;
          // Snow is not a single threshold: broad fields, carved rock ribs and
          // fine drift texture all vary the coverage so peaks don't read as a
          // flat white sticker on the map.
          const broad = valueNoise2(wx / 90, wy / 90, seed ^ 0x2f1d);
          // Rotate the rib field so its cells don't line up with the map axes
          // (that reads as a checkerboard of square snow patches).
          const rx = wx * 0.8 - wy * 0.6;
          const ry = wx * 0.6 + wy * 0.8;
          const ribs = smoothstep(
            0.32,
            0.68,
            valueNoise2(rx / 26, ry / 26, seed ^ 0x4d21) * 0.66 +
              valueNoise2(rx / 11, ry / 11, seed ^ 0x21d4) * 0.34,
          );
          const drift = valueNoise2(wx / 7, wy / 7, seed ^ 0x7a3c);
          const patch = clamp((0.32 + 0.68 * broad) * (0.36 + 0.64 * ribs) * (0.8 + 0.4 * drift), 0, 1);
          // Steep faces stay rocky, which keeps peaks from looking like clouds.
          const slope = Math.min(1, (Math.abs(gx) + Math.abs(gy)) * 320);
          const base = smoothstep(snowLine, snowLine + 0.13, t);
          const snow = clamp(base * patch * (1 - slope * 0.82), 0, 0.92);
          r = lerp(r, C.snow[0], snow);
          g = lerp(g, C.snow[1], snow);
          b = lerp(b, C.snow[2], snow);
        }

        // Contour lines from the raw height field.
        if (contours) {
          const band = Math.floor((e - SEA_LEVEL) / contourStep);
          const right = heights[idx + 1];
          const down = heights[idx + W];
          const rightBand = Math.floor((right - SEA_LEVEL) / contourStep);
          const downBand = Math.floor((down - SEA_LEVEL) / contourStep);
          if (band !== rightBand || band !== downBand) {
            const major = ((band % 4) + 4) % 4 === 0;
            const k = major ? 0.64 : 0.83;
            r *= k;
            g *= k;
            b *= k;
          }
        }
      }

      if (isWater && contours) {
        const band = Math.floor((SEA_LEVEL - e) / waterStep);
        const right = heights[idx + 1];
        const down = heights[idx + W];
        const rightBand = Math.floor((SEA_LEVEL - right) / waterStep);
        const downBand = Math.floor((SEA_LEVEL - down) / waterStep);
        if (band !== rightBand || band !== downBand) {
          const major = band % 3 === 0;
          const k = major ? 0.9 : 0.95;
          r *= k;
          g *= k;
          b *= k;
        }
      }

      if (!isWater && shading) {
        // High-frequency residual of the height field adds vegetation mottling
        // without needing another noise lookup.
        const mottle = clamp((e - shadeHeights[idx]) * 22, -0.1, 0.1);
        r *= 1 + mottle;
        g *= 1 + mottle;
        b *= 1 + mottle;
      }

      if (!isWater && level >= 2) {
        const wx = x0p + (pi + 0.5) * worldPerPixel;
        const wy = y0p + (pj + 0.5) * worldPerPixel;
        const tex =
          valueNoise2(wx / 11, wy / 11, seed ^ 0x5c1d) * 0.55 +
          valueNoise2(wx / 4.2, wy / 4.2, seed ^ 0x1d5c) * 0.45;
        const k = 1 + (tex - 0.5) * 0.11;
        r *= k;
        g *= k;
        b *= k;
      }

      if (shading) {
        let shade = 1 + (gx + gy) * shadeStrength;
        shade = clamp(shade, 0.62, 1.38);
        // Water gets a hint of relief so shoals still read, but stays flat.
        const strength = isWater ? 0.18 : 1;
        const s = 1 + (shade - 1) * strength;
        r *= s;
        g *= s;
        b *= s;
      }

      if (grain) {
        const n = hash2i(pixelX0 + pi, pixelY0 + pj, seed ^ 0x51f3);
        const k = 1 + (n - 0.5) * 0.07;
        r *= k;
        g *= k;
        b *= k;
      }

      const o = (j * width + i) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }

  return out;
}

// Pick a pleasant starting view: a coastline with a mix of land and water.
// `preferLand` keeps the centre inland, which is what the descent wants: a
// mostly-terrain view with water at the edges rather than open ocean below.
export function findStart(seed, viewWorldSize = 2400, preferLand = false) {
  const samples = 8;
  const step = viewWorldSize / samples;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const rotation = ((seed >>> 3) % 4096) / 4096 * Math.PI * 2;
  const candidates = [];

  for (let c = 1; c < 90; c++) {
    const radius = 620 * Math.sqrt(c);
    const angle = c * golden + rotation;
    const cx = Math.cos(angle) * radius;
    const cy = Math.sin(angle) * radius;

    let water = 0;
    let sum = 0;
    let sumSq = 0;
    for (let j = 0; j < samples; j++) {
      for (let i = 0; i < samples; i++) {
        const e = elevationAt(cx + (i - samples / 2) * step, cy + (j - samples / 2) * step, seed, 5);
        if (e < SEA_LEVEL) water++;
        sum += e;
        sumSq += e * e;
      }
    }
    const n = samples * samples;
    const waterFraction = water / n;
    const landFraction = 1 - waterFraction;
    const variance = sumSq / n - (sum / n) ** 2;
    const centreE = elevationAt(cx, cy, seed, 5);

    const score = preferLand
      ? landFraction * 2.6 +
        Math.min(variance, 0.02) * 18 +
        (centreE >= SEA_LEVEL ? 0.35 : -0.8) -
        Math.abs(landFraction - 0.82) * 1.4
      : // Favour a coastline with some relief to look at.
        -Math.abs(waterFraction - 0.44) * 5 +
        Math.min(variance, 0.02) * 10 +
        (waterFraction > 0.2 && waterFraction < 0.7 ? 0.04 : 0);
    candidates.push({ x: cx, y: cy, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  // Many candidates tie on the coarse score; choose among the near-best ones
  // deterministically so different seeds don't all open on the same beach.
  const best = candidates[0].score;
  const top = candidates.filter((candidate) => candidate.score >= best - 0.02);
  return top[seed % top.length];
}

// Small, dependency-free noise toolkit.
// Everything here is a pure function of its inputs, which is what makes the
// world reproducible: no state, no stored map, just coordinates in, values out.

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export const lerp = (a, b, t) => a + (b - a) * t;

export const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

// Integer hash -> [0, 1). Fast avalanche mix based on xxHash/Murmur constants.
export function hash2i(ix, iy, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ (seed | 0);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Classic value noise with quintic interpolation.
export function valueNoise2(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

  const a = hash2i(xi, yi, seed);
  const b = hash2i(xi + 1, yi, seed);
  const c = hash2i(xi, yi + 1, seed);
  const d = hash2i(xi + 1, yi + 1, seed);

  const ab = a + (b - a) * u;
  const cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

// Fractal Brownian motion. Each octave is rotated slightly so the integer
// lattice of the value noise never lines up and reads as blocky.
export function fbm(x, y, seed, octaves, gain = 0.5) {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let px = x;
  let py = y;

  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(px, py, seed + o * 0x9e3779b9);
    norm += amp;
    amp *= gain;

    const nx = (px * 0.8 - py * 0.6) * 2.02;
    py = (px * 0.6 + py * 0.8) * 2.02;
    px = nx;
  }

  return sum / norm;
}

// FNV-1a, used to turn a human seed ("quiet-harbor-42") into a numeric seed.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

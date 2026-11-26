// Worker entry for the 3D terrain mesh.
//
// Sampling 37k elevation points is the one part of the 3D view that can stall a
// frame, so it happens here and the typed arrays are transferred back.

import { buildTerrainGrid } from './terrain3d-data.js';

self.onmessage = (event) => {
  const { id, ...options } = event.data || {};
  try {
    const data = buildTerrainGrid(options);
    self.postMessage(
      {
        id,
        positions: data.positions,
        colors: data.colors,
        indices: data.indices,
        minHeight: data.minHeight,
        maxHeight: data.maxHeight,
        centerHeight: data.centerHeight,
        segments: data.segments,
        size: data.size,
        heightScale: data.heightScale,
        generationMs: data.generationMs,
      },
      [data.positions.buffer, data.colors.buffer, data.indices.buffer],
    );
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};

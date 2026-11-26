// Worker entry for 3D terrain chunks.
//
// Chunk generation is deterministic and CPU-heavy, so it runs here and typed
// arrays are transferred back to the main thread.

import { buildTerrainChunk, buildTerrainGrid } from './terrain3d-data.js';

self.onmessage = (event) => {
  const { id, kind = 'chunk', ...options } = event.data || {};
  try {
    const data =
      kind === 'grid' ? buildTerrainGrid(options) : buildTerrainChunk(options);
    const transfer = [data.positions.buffer, data.colors.buffer, data.indices.buffer];
    if (data.skirtPositions) {
      transfer.push(
        data.skirtPositions.buffer,
        data.skirtColors.buffer,
        data.skirtIndices.buffer,
      );
    }
    self.postMessage({ id, epoch: options.epoch, ...data }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};

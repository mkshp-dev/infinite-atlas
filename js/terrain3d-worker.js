// Worker entry for 3D terrain chunks.
//
// Chunk generation is deterministic and CPU-heavy, so it runs here and typed
// arrays are transferred back to the main thread.

import { buildTerrainChunk, buildTerrainGrid } from './terrain3d-data.js';
import { buildVegetationChunk } from './vegetation.js';

self.onmessage = (event) => {
  const { id, kind = 'chunk', ...options } = event.data || {};
  try {
    if (kind === 'vegetation') {
      const data = buildVegetationChunk(options);
      const transfer = Object.values(data.instances).map((a) => a.buffer);
      self.postMessage({ id, epoch: options.epoch, ...data }, transfer);
      return;
    }
    const data =
      kind === 'grid' ? buildTerrainGrid(options) : buildTerrainChunk(options);
    let vegetation = null;
    if (kind === 'chunk' && options.withVegetation !== false) {
      vegetation = buildVegetationChunk(options);
    }
    const transfer = [data.positions.buffer, data.colors.buffer, data.indices.buffer];
    if (data.skirtPositions) {
      transfer.push(
        data.skirtPositions.buffer,
        data.skirtColors.buffer,
        data.skirtIndices.buffer,
      );
    }
    if (vegetation) {
      for (const a of Object.values(vegetation.instances)) transfer.push(a.buffer);
    }
    self.postMessage({ id, epoch: options.epoch, ...data, vegetation }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error && error.message ? error.message : error) });
  }
};

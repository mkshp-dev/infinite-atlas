// Each worker paints one tile and hands back an ImageBitmap.
// This file is loaded as a module worker.

import { TILE_SIZE, renderRegion } from './terrain.js';

self.onmessage = async (event) => {
  const job = event.data;

  try {
    const worldSize = TILE_SIZE / 2 ** job.level;
    const x0 = job.tx * worldSize;
    const y0 = job.ty * worldSize;

    const pixels = renderRegion({
      x0,
      y0,
      width: job.pixelSize,
      height: job.pixelSize,
      worldPerPixel: worldSize / job.pixelSize,
      seed: job.seed,
      ...job.options,
    });

    const bitmap = await createImageBitmap(new ImageData(pixels, job.pixelSize, job.pixelSize));
    self.postMessage({ epoch: job.epoch, key: job.key, bitmap }, [bitmap]);
  } catch (error) {
    self.postMessage({
      epoch: job.epoch,
      key: job.key,
      error: error && error.stack ? error.stack : String(error),
    });
  }
};

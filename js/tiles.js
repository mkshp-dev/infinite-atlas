// Tile engine: turns the pure terrain function into a cached pyramid of
// bitmaps, generated off the main thread.
//
// Tiles are addressed by (level, tx, ty) where one tile is 256 CSS pixels wide
// at zoom 2^level. That makes the grid stable while panning and keeps the
// amount of work proportional to what is actually on screen.

import { TILE_SIZE } from './terrain.js';

export class TileEngine {
  constructor({ dpr = 1, workerCount = 4, maxTiles = 128, onTileReady } = {}) {
    this.dpr = dpr;
    this.pixelSize = Math.max(1, Math.round(TILE_SIZE * dpr));
    this.maxTiles = maxTiles;
    this.onTileReady = onTileReady;

    this.epoch = 0;
    this.seed = 0;
    this.options = { shading: true, contours: true, grain: true };

    this.cache = new Map();
    this.inflight = new Map();
    this.failed = new Set();
    this.queue = [];
    this.wanted = new Map();
    this.frame = 0;
    this.jobId = 0;

    this.workers = [];
    const count = Math.max(1, workerCount | 0);
    for (let i = 0; i < count; i++) this.workers.push(this.#spawn());
  }

  #spawn() {
    const worker = new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' });
    const slot = { worker, busy: false, key: null };

    worker.onmessage = (event) => this.#onMessage(slot, event.data);
    worker.onerror = (event) => {
      console.error('Tile worker crashed:', event.message || event);
      if (slot.key) {
        this.inflight.delete(slot.key);
        this.failed.add(slot.key);
      }
      slot.busy = false;
      slot.key = null;
      this.dispatch();
    };

    return slot;
  }

  #onMessage(slot, message) {
    slot.busy = false;
    slot.key = null;
    const key = message.key;
    if (key) this.inflight.delete(key);

    if (message.epoch !== this.epoch) {
      message.bitmap?.close?.();
      this.dispatch();
      return;
    }

    if (message.error) {
      console.error('Tile failed to render:', message.error);
      if (key) this.failed.add(key);
      this.dispatch();
      return;
    }

    if (message.bitmap) {
      this.cache.set(key, {
        bitmap: message.bitmap,
        used: this.frame,
        born: performance.now(),
      });
      this.onTileReady?.(key);
    }

    this.dispatch();
  }

  configure({ seed, options } = {}) {
    if (seed !== undefined) this.seed = seed;
    if (options) this.options = { ...this.options, ...options };

    // Invalidate every bitmap and drop jobs from the previous world.
    this.epoch++;
    this.queue.length = 0;
    this.wanted.clear();
    this.inflight.clear();
    this.failed.clear();
    for (const entry of this.cache.values()) entry.bitmap?.close?.();
    this.cache.clear();
  }

  beginFrame() {
    this.frame++;
    this.wanted.clear();
  }

  // Returns the cached tile, or null and schedules generation.
  request(level, tx, ty) {
    const key = `${level}/${tx}/${ty}`;
    const cached = this.cache.get(key);
    if (cached) {
      cached.used = this.frame;
      return cached;
    }
    if (!this.failed.has(key) && !this.inflight.has(key) && !this.wanted.has(key)) {
      this.wanted.set(key, { key, level, tx, ty });
    }
    return null;
  }

  // Look up a tile without scheduling it (used for parent/child fallbacks).
  peek(level, tx, ty) {
    const entry = this.cache.get(`${level}/${tx}/${ty}`);
    if (entry) entry.used = this.frame;
    return entry || null;
  }

  endFrame(center = null) {
    this.queue = Array.from(this.wanted.values());
    if (center) {
      const { tx, ty } = center;
      this.queue.sort(
        (a, b) =>
          (a.tx - tx) ** 2 + (a.ty - ty) ** 2 - ((b.tx - tx) ** 2 + (b.ty - ty) ** 2),
      );
    }
    this.wanted.clear();
    this.dispatch();
    this.evict();
  }

  dispatch() {
    if (!this.queue.length) return;

    for (const slot of this.workers) {
      if (!this.queue.length) break;
      if (slot.busy) continue;

      let job = this.queue.shift();
      while (job && (this.cache.has(job.key) || this.inflight.has(job.key) || this.failed.has(job.key))) {
        job = this.queue.shift();
      }
      if (!job) break;

      slot.busy = true;
      slot.key = job.key;
      this.inflight.set(job.key, slot);

      slot.worker.postMessage({
        id: ++this.jobId,
        epoch: this.epoch,
        key: job.key,
        level: job.level,
        tx: job.tx,
        ty: job.ty,
        pixelSize: this.pixelSize,
        seed: this.seed,
        options: this.options,
      });
    }
  }

  evict() {
    if (this.cache.size <= this.maxTiles) return;

    const entries = Array.from(this.cache.entries()).sort((a, b) => a[1].used - b[1].used);
    for (const [key, entry] of entries) {
      if (this.cache.size <= this.maxTiles) break;
      if (entry.used === this.frame) continue;
      this.cache.delete(key);
      entry.bitmap?.close?.();
    }
  }

  get pending() {
    return this.inflight.size + this.queue.length;
  }

  get cached() {
    return this.cache.size;
  }

  get workerCount() {
    return this.workers.length;
  }

  dispose() {
    for (const slot of this.workers) slot.worker.terminate();
    for (const entry of this.cache.values()) entry.bitmap?.close?.();
    this.cache.clear();
    this.workers.length = 0;
  }
}

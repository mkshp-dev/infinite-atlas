// 3D terrain view: chunked local terrain rendered with Three.js.
//
// The renderer is intentionally isolated from the 2D atlas. It owns its canvas,
// scene, camera, workers and chunk meshes, and disposes all of them when the
// view is left.

import * as THREE from '../vendor/three/three.module.min.js';
import { buildTerrainChunk, chunkKey, TERRAIN3D_DEFAULTS } from './terrain3d-data.js';

const SKY = 0xb9cbc6;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function makeWorker() {
  return new Worker(new URL('./terrain3d-worker.js', import.meta.url), { type: 'module' });
}

export class TerrainView3D {
  constructor({ canvas, seed, centerX, centerY, onStatus }) {
    this.canvas = canvas;
    this.seed = seed;
    this.centerX = centerX;
    this.centerY = centerY;
    this.onStatus = onStatus;

    this.chunkSize = TERRAIN3D_DEFAULTS.chunkSize;
    this.lodSegments = TERRAIN3D_DEFAULTS.lodSegments;
    this.heightScale = TERRAIN3D_DEFAULTS.heightScale;
    this.maxLod = this.lodSegments.length - 1;
    this.visibleRadius = window.innerWidth <= 720 ? 4 : 6;
    this.maxChunks = window.innerWidth <= 720 ? 56 : 96;
    this.maxWorkers = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 4) > 4 ? 2 : 1));

    this.ready = false;
    this.status = 'building';
    this.error = null;
    this.generationMs = 0;
    this.lastGenerationMs = 0;
    this.triangles = 0;
    this.fps = 0;

    this.yaw = 0.72;
    this.pitch = 0.62;
    this.distance = this.chunkSize * 2.8;
    this.target = new THREE.Vector3(centerX, 0, centerY);

    this.pointers = new Map();
    this.lastPinch = 0;
    this.lastPinchMid = null;
    this.dragging = false;
    this.panning = false;
    this.running = false;
    this.raf = 0;
    this.lastFrame = 0;
    this.disposed = false;

    this.chunks = new Map();
    this.inFlight = new Map();
    this.queue = [];
    this.workers = [];
    this.idleWorkers = [];
    this.requestId = 0;
    this.epoch = 0;
    this.completedJobs = 0;
    this.evictedChunks = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, this.chunkSize * 3.2, this.chunkSize * 11);

    this.camera = new THREE.PerspectiveCamera(52, 1, 1, this.chunkSize * 40);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.#setupLights();
    this.#setupWater();
    this.#bindEvents();
    this.resize();
    this.#updateCamera();
    this.#refreshChunks(true);
    this.start();
  }

  // Compatibility: expose a representative terrain mesh for old tests/tools.
  get terrain() {
    let best = null;
    for (const chunk of this.chunks.values()) {
      if (!chunk.mesh) continue;
      if (!best || chunk.lod < best.lod) best = chunk;
    }
    return best?.mesh ?? null;
  }

  #setupLights() {
    const hemi = new THREE.HemisphereLight(0xe6f1f2, 0x38452f, 1.5);
    this.scene.add(hemi);

    const az = (((this.seed >>> 0) % 4096) / 4096) * Math.PI * 2;
    const sun = new THREE.DirectionalLight(0xfff2d4, 2.4);
    sun.position.set(Math.cos(az) * 7000, 6000, Math.sin(az) * 7000);
    sun.target.position.set(0, 0, 0);
    this.scene.add(sun.target);
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x9fc4d8, 0.55);
    fill.position.set(-5000, 3000, -3500);
    this.scene.add(fill);
  }

  #setupWater() {
    const geometry = new THREE.PlaneGeometry(this.chunkSize * 40, this.chunkSize * 40, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshLambertMaterial({
      color: 0x2d6f7e,
      transparent: true,
      opacity: 0.78,
    });
    this.water = new THREE.Mesh(geometry, material);
    this.water.position.y = 0.02;
    this.water.renderOrder = 1;
    this.scene.add(this.water);
  }

  // --- Chunk management -----------------------------------------------------

  #desiredLod(distance) {
    if (distance <= this.chunkSize * 1.35) return 0;
    if (distance <= this.chunkSize * 2.8) return Math.min(1, this.maxLod);
    return this.maxLod;
  }

  #skirtDepthForLod(lod) {
    // Coarser chunks get deeper skirts to hide T-junctions against finer ones.
    return Math.max(120, this.heightScale * 0.35) + lod * 90;
  }

  #refreshChunks(force = false) {
    if (this.disposed) return;
    const targetChunkX = Math.floor(this.target.x / this.chunkSize);
    const targetChunkY = Math.floor(this.target.z / this.chunkSize);

    const wanted = new Map();
    for (let dy = -this.visibleRadius; dy <= this.visibleRadius; dy++) {
      for (let dx = -this.visibleRadius; dx <= this.visibleRadius; dx++) {
        const cx = targetChunkX + dx;
        const cy = targetChunkY + dy;
        const centerX = (cx + 0.5) * this.chunkSize;
        const centerY = (cy + 0.5) * this.chunkSize;
        const distance = Math.hypot(centerX - this.target.x, centerY - this.target.z);
        if (distance > this.visibleRadius * this.chunkSize * 1.08) continue;
        let lod = this.#desiredLod(distance);
        const existing = this.#getExistingChunk(cx, cy);
        if (existing) {
          // Hysteresis to prevent LOD oscillation at boundaries.
          const near = this.chunkSize * (lod === 0 ? 1.15 : 2.5);
          const far = this.chunkSize * (lod <= 1 ? 3.15 : 99);
          if (existing.lod < lod && distance < far) lod = existing.lod;
          if (existing.lod > lod && distance > near) lod = existing.lod;
        }
        wanted.set(`${cx}:${cy}`, { cx, cy, lod, distance, key: chunkKey(cx, cy, lod) });
      }
    }

    // Enforce neighbor LOD difference <= 1 by promoting coarser neighbors.
    let changed = true;
    for (let pass = 0; pass < 4 && changed; pass++) {
      changed = false;
      for (const req of wanted.values()) {
        for (const [nx, ny] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nReq = wanted.get(`${req.cx + nx}:${req.cy + ny}`);
          if (!nReq) continue;
          if (nReq.lod - req.lod > 1) {
            nReq.lod = req.lod + 1;
            nReq.key = chunkKey(nReq.cx, nReq.cy, nReq.lod);
            changed = true;
          }
        }
      }
    }

    const wantedByKey = new Map();
    for (const req of wanted.values()) wantedByKey.set(req.key, req);

    // Cancel stale in-flight requests.
    for (const [key, job] of Array.from(this.inFlight.entries())) {
      const req = wantedByKey.get(key);
      if (req) continue;
      this.inFlight.delete(key);
    }
    this.queue = this.queue.filter((job) => wantedByKey.has(job.key));

    // Schedule missing wanted chunks.
    for (const req of wantedByKey.values()) {
      if (this.chunks.has(req.key) || this.inFlight.has(req.key)) continue;
      for (const [key, job] of Array.from(this.inFlight.entries())) {
        if (job.cx === req.cx && job.cy === req.cy && key !== req.key) this.inFlight.delete(key);
      }
      this.#enqueue(req);
    }

    // Reconcile orphaned in-flight jobs (kept in inFlight, dropped from queue,
    // not currently on a worker) so refresh churn cannot strand requests.
    const busyKeys = new Set(this.workers.map((w) => w.__job?.key).filter(Boolean));
    const queuedKeys = new Set(this.queue.map((j) => j.key));
    for (const [key, job] of this.inFlight.entries()) {
      if (!wantedByKey.has(key)) { this.inFlight.delete(key); continue; }
      if (busyKeys.has(key) || queuedKeys.has(key)) continue;
      this.queue.push(job);
    }
    this.queue.sort((a, b) => a.priority - b.priority);
    this.#pumpQueue();

    this.#evictIfNeeded(wantedByKey);
    this.#updateStatus(force);
  }

  #getExistingChunk(cx, cy) {
    for (const chunk of this.chunks.values()) if (chunk.cx === cx && chunk.cy === cy) return chunk;
    for (const job of this.inFlight.values()) if (job.cx === cx && job.cy === cy) return job;
    return null;
  }

  #neighborLod(cx, cy) {
    for (const chunk of this.chunks.values()) if (chunk.cx === cx && chunk.cy === cy) return chunk.lod;
    return null;
  }

  #stitchedIndexArray(data) {
    const seg = data.segments;
    const n = seg + 1;
    const idx = [];
    const V = (i, j) => j * n + i;
    const N = this.#neighborLod(data.cx, data.cy - 1);
    const S = this.#neighborLod(data.cx, data.cy + 1);
    const W = this.#neighborLod(data.cx - 1, data.cy);
    const E = this.#neighborLod(data.cx + 1, data.cy);
    const stitchN = N !== null && N === data.lod + 1;
    const stitchS = S !== null && S === data.lod + 1;
    const stitchW = W !== null && W === data.lod + 1;
    const stitchE = E !== null && E === data.lod + 1;
    // Interior full-resolution cells, excluding boundary strips that need stitching.
    const i0 = stitchW ? 1 : 0;
    const i1 = stitchE ? seg - 1 : seg;
    const j0 = stitchN ? 1 : 0;
    const j1 = stitchS ? seg - 1 : seg;
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const a = V(i, j), b = V(i + 1, j), c = V(i, j + 1), d = V(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
    // Edge stitching: coarser neighbor has one vertex per 2 fine segments.
    // North edge j==0, stitch against row 0/1 strip.
    if (stitchN) {
      for (let i = 0; i < seg; i += 2) {
        const i2 = i + 2;
        const a = V(i, 0), m = V(i + 1, 0), b = V(i2, 0);
        const c = V(i, 1), d = V(i + 1, 1), e = V(i2, 1);
        // fan from coarse edge a,b on row 0 to fine row 1
        idx.push(a, c, m, m, c, d, m, d, b, b, d, e);
      }
    }
    if (stitchS) {
      const j = seg - 1;
      for (let i = 0; i < seg; i += 2) {
        const i2 = i + 2;
        const a = V(i, j), b = V(i + 1, j), c = V(i2, j);
        const d = V(i, j + 1), m = V(i + 1, j + 1), e = V(i2, j + 1);
        idx.push(a, d, b, b, d, m, b, m, c, c, m, e);
      }
    }
    if (stitchW) {
      const js = stitchN ? 1 : 0;
      const je = stitchS ? seg - 1 : seg;
      for (let j = js; j < je; j += 2) {
        const j2 = j + 2;
        const a = V(0, j), b = V(0, j + 1), c = V(0, j2);
        const d = V(1, j), e = V(1, j + 1), f = V(1, j2);
        idx.push(a, b, d, b, e, d, b, c, e, c, f, e);
      }
    }
    if (stitchE) {
      const i = seg - 1;
      const js = stitchN ? 1 : 0;
      const je = stitchS ? seg - 1 : seg;
      for (let j = js; j < je; j += 2) {
        const j2 = j + 2;
        const a = V(i, j), b = V(i, j + 1), c = V(i, j2);
        const d = V(i + 1, j), e = V(i + 1, j + 1), f = V(i + 1, j2);
        idx.push(a, b, d, d, b, e, b, c, e, e, c, f);
      }
    }
    // Corners where stitched edge strips meet interior: fill remaining corner quads.
    // The strip logic leaves corners at (0,0),(seg-1,0),(0,seg-1),(seg-1,seg-1) when both adjacent edges stitched.
    // Handle by filling any unfilled boundary cells not covered above.
    // Simpler: fill all 1x1 cells in boundary strips except those in stitched directions; stitched functions already cover their strips fully.
    // For W stitch, we covered js..je rows, col 0-1 strip. N/S stitch covered full width row 0-1 / seg-1-seg. Overlap at corners: N+W corner cell (0,0)-(1,1) covered by N? N covers i=0..seg so includes i==0. Yes. So corners are fine.
    return new Uint32Array(idx);
  }

  #rebuildChunkIndex(chunk) {
    if (!chunk?.sourceData) return;
    const index = this.#stitchedIndexArray(chunk.sourceData);
    chunk.mesh.geometry.setIndex(new THREE.BufferAttribute(index, 1));
    chunk.mesh.geometry.computeVertexNormals();
    chunk.triangles = index.length / 3 + (chunk.skirt?.geometry.index?.count || 0);
  }

  #rebuildNeighborEdges(cx, cy) {
    const coords = [[cx, cy], [cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
    for (const [nx, ny] of coords) {
      for (const chunk of this.chunks.values()) {
        if (chunk.cx === nx && chunk.cy === ny) this.#rebuildChunkIndex(chunk);
      }
    }
    this.#recomputeBounds();
  }

  #enqueue(req) {
    const job = {
      ...req,
      id: ++this.requestId,
      epoch: this.epoch,
      seed: this.seed,
      priority: req.distance + req.lod * this.chunkSize * 0.5,
    };
    this.inFlight.set(job.key, job);
    this.queue.push(job);
    this.queue.sort((a, b) => a.priority - b.priority);
    this.#pumpQueue();
  }

  #ensureWorkers() {
    while (this.workers.length < this.maxWorkers) {
      try {
        const worker = makeWorker();
        worker.onmessage = (event) => this.#onWorkerMessage(worker, event.data);
        worker.onerror = (event) => this.#onWorkerError(worker, event);
        this.workers.push(worker);
        this.idleWorkers.push(worker);
      } catch (error) {
        console.warn('Could not start terrain chunk worker:', error);
        break;
      }
    }
  }

  #pumpQueue() {
    if (this.disposed) return;
    this.#ensureWorkers();
    if (this.workers.length === 0) {
      // Main-thread bounded fallback: process a few jobs per pump.
      const budget = 2;
      for (let i = 0; i < budget && this.queue.length; i++) {
        const job = this.queue.shift();
        if (!job || !this.inFlight.has(job.key) || job.epoch !== this.epoch) continue;
        try {
          const data = buildTerrainChunk({
            seed: job.seed,
            cx: job.cx,
            cy: job.cy,
            lod: job.lod,
            chunkSize: this.chunkSize,
            segments: this.lodSegments[job.lod],
            heightScale: this.heightScale,
            skirtDepth: this.#skirtDepthForLod(job.lod),
          });
          this.#applyChunk({ ...data, id: job.id, epoch: job.epoch });
        } catch (error) {
          console.error('Chunk fallback failed:', error);
        }
      }
      this.#updateStatus();
      return;
    }

    while (this.idleWorkers.length && this.queue.length) {
      const worker = this.idleWorkers.pop();
      const job = this.queue.shift();
      if (!job || !this.inFlight.has(job.key) || job.epoch !== this.epoch) {
        this.idleWorkers.push(worker);
        continue;
      }
      worker.__job = job;
      worker.postMessage({
        id: job.id,
        epoch: job.epoch,
        kind: 'chunk',
        seed: job.seed,
        cx: job.cx,
        cy: job.cy,
        lod: job.lod,
        chunkSize: this.chunkSize,
        segments: this.lodSegments[job.lod],
        heightScale: this.heightScale,
        skirtDepth: this.#skirtDepthForLod(job.lod),
      });
    }
  }

  #onWorkerMessage(worker, message) {
    if (worker.__job && message?.id === worker.__job.id) worker.__job = null;
    if (!this.idleWorkers.includes(worker)) this.idleWorkers.push(worker);
    if (this.disposed || !message) return;
    if (message.error) {
      console.warn('Chunk worker error:', message.error);
      this.inFlight.delete(message.key);
      this.#pumpQueue();
      this.#updateStatus();
      return;
    }
    this.#applyChunk(message);
    this.#pumpQueue();
  }

  #onWorkerError(worker, event) {
    console.warn('Terrain chunk worker failed:', event.message);
    const job = worker.__job;
    worker.__job = null;
    worker.terminate();
    this.workers = this.workers.filter((w) => w !== worker);
    this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
    if (job && job.epoch === this.epoch && this.inFlight.has(job.key)) {
      // Retry on main thread/fresh worker.
      this.queue.unshift(job);
    }
    this.#pumpQueue();
  }

  #applyChunk(data) {
    if (this.disposed) return;
    const key = data.key || chunkKey(data.cx, data.cy, data.lod);
    const pending = this.inFlight.get(key);
    if (!pending || pending.id !== data.id) return;
    if (data.epoch !== undefined && data.epoch !== this.epoch) return;
    this.inFlight.delete(key);
    this.completedJobs += 1;
    this.lastGenerationMs = data.generationMs ?? 0;
    this.generationMs = this.generationMs ? this.generationMs * 0.8 + this.lastGenerationMs * 0.2 : this.lastGenerationMs;

    // Remove any other LOD for same coord.
    const coord = `${data.cx}:${data.cy}`;
    for (const [otherKey, other] of Array.from(this.chunks.entries())) {
      if (`${other.cx}:${other.cy}` === coord && otherKey !== key) {
        this.#disposeChunk(otherKey);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = true;
    this.group.add(mesh);

    let skirt = null;
    if (data.skirtPositions && data.skirtIndices) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(data.skirtPositions, 3));
      sg.setAttribute('color', new THREE.BufferAttribute(data.skirtColors, 3));
      sg.setIndex(new THREE.BufferAttribute(data.skirtIndices, 1));
      sg.computeVertexNormals();
      const sm = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      skirt = new THREE.Mesh(sg, sm);
      this.group.add(skirt);
    }

    const chunk = {
      key,
      cx: data.cx,
      cy: data.cy,
      lod: data.lod,
      segments: data.segments,
      minHeight: data.minHeight,
      maxHeight: data.maxHeight,
      centerHeight: data.centerHeight,
      mesh,
      skirt,
      lastUsed: performance.now(),
      triangles: geometry.index.count / 3 + (data.skirtIndices ? data.skirtIndices.length / 3 : 0),
    };
    this.chunks.set(key, chunk);
    this.#recomputeBounds();
    this.ready = this.chunks.size > 0;
    this.status = this.ready ? 'ready' : 'building';
    this.#updateStatus();
  }

  #disposeChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    const { cx, cy } = chunk;
    for (const obj of [chunk.mesh, chunk.skirt]) {
      if (!obj) continue;
      this.group.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    this.chunks.delete(key);
    this.evictedChunks += 1;
    this.#rebuildNeighborEdges(cx, cy);
  }

  #evictIfNeeded(wanted) {
    if (this.chunks.size <= this.maxChunks) return;
    const wantedCoords = new Set();
    for (const req of wanted.values()) wantedCoords.add(`${req.cx}:${req.cy}`);
    const hasCoord = new Set();
    for (const c of this.chunks.values()) hasCoord.add(`${c.cx}:${c.cy}`);

    const entries = Array.from(this.chunks.values())
      .map((c) => {
        const coord = `${c.cx}:${c.cy}`;
        const wantedKey = wanted.has(c.key);
        const coordWanted = wantedCoords.has(coord);
        // Keep if it's the only chunk covering a wanted coord.
        const onlyCoverage = coordWanted && !Array.from(this.chunks.values()).some((o) => o !== c && `${o.cx}:${o.cy}` === coord);
        return { chunk: c, wantedKey, coordWanted, onlyCoverage };
      })
      .filter((e) => !e.wantedKey && !e.onlyCoverage)
      .map((e) => {
        const c = e.chunk;
        const centerX = (c.cx + 0.5) * this.chunkSize;
        const centerY = (c.cy + 0.5) * this.chunkSize;
        const distance = Math.hypot(centerX - this.target.x, centerY - this.target.z);
        return { key: c.key, score: distance + (e.coordWanted ? -this.chunkSize * 4 : 0) + c.lod * this.chunkSize * 0.2 };
      })
      .sort((a, b) => b.score - a.score);
    for (const entry of entries) {
      if (this.chunks.size <= this.maxChunks) break;
      this.#disposeChunk(entry.key);
    }
  }

  #recomputeBounds() {
    let minH = Infinity;
    let maxH = -Infinity;
    let tris = 0;
    for (const chunk of this.chunks.values()) {
      minH = Math.min(minH, chunk.minHeight);
      maxH = Math.max(maxH, chunk.maxHeight);
      tris += chunk.triangles;
    }
    this.minHeight = Number.isFinite(minH) ? minH : 0;
    this.maxHeight = Number.isFinite(maxH) ? maxH : 0;
    this.triangles = tris;
  }

  #updateStatus(force = false) {
    this.ready = this.chunks.size > 0;
    this.status = this.error ? 'error' : this.ready ? 'ready' : 'building';
    this.centerX = this.target.x;
    this.centerY = this.target.z;
    this.water.position.x = this.target.x;
    this.water.position.z = this.target.z;
    if (force || this.ready) this.onStatus?.(this.status);
  }

  get stats() {
    const lodCounts = [0, 0, 0, 0];
    for (const c of this.chunks.values()) lodCounts[c.lod] = (lodCounts[c.lod] || 0) + 1;
    return {
      activeChunks: this.chunks.size,
      pendingChunks: this.inFlight.size,
      queuedChunks: this.queue.length,
      triangleCount: this.triangles,
      lodCounts,
      generationMs: this.lastGenerationMs,
      evictedChunks: this.evictedChunks,
      completedJobs: this.completedJobs,
    };
  }

  // --- World / camera -------------------------------------------------------

  setWorld(seed, centerX, centerY) {
    this.seed = seed;
    this.epoch += 1;
    this.queue = [];
    this.inFlight.clear();
    for (const key of Array.from(this.chunks.keys())) this.#disposeChunk(key);
    this.target.set(centerX, 0, centerY);
    this.centerX = centerX;
    this.centerY = centerY;
    this.ready = false;
    this.status = 'building';
    this.error = null;
    this.generationMs = 0;
    this.#updateStatus(true);
    this.#refreshChunks(true);
  }

  resetCamera() {
    this.yaw = 0.72;
    this.pitch = 0.62;
    this.distance = this.chunkSize * 2.8;
    this.#updateCamera();
  }

  #updateCamera() {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const x = this.target.x + this.distance * cp * Math.sin(this.yaw);
    const y = this.target.y + this.distance * sp;
    const z = this.target.z + this.distance * cp * Math.cos(this.yaw);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  panTargetByPixels(dx, dy) {
    // Move target in ground plane relative to camera yaw.
    const panScale = this.distance * 0.0015;
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const rightX = cos;
    const rightZ = -sin;
    const forwardX = -sin;
    const forwardZ = -cos;
    this.target.x += (-dx * rightX + dy * forwardX) * panScale;
    this.target.z += (-dx * rightZ + dy * forwardZ) * panScale;
    this.#updateCamera();
    this.#refreshChunks();
  }

  getHeading() { return this.yaw; }
  getCenter() { return { x: this.target.x, y: this.target.z }; }
  getCameraTarget() { return { x: this.target.x, y: this.target.z }; }

  resize() {
    const width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 1;
    const height = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  // --- Input ----------------------------------------------------------------

  #bindEvents() {
    this.onPointerDown = (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 2) return;
      this.canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.dragging = this.pointers.size === 1 && event.button !== 2 && !event.shiftKey;
      this.panning = this.pointers.size === 1 && (event.button === 2 || event.shiftKey);
      this.lastPinch = 0;
      this.lastPinchMid = null;
      this.canvas.classList.add('dragging');
    };

    this.onPointerMove = (event) => {
      const previous = this.pointers.get(event.pointerId);
      if (!previous) return;
      const current = { x: event.clientX, y: event.clientY };
      this.pointers.set(event.pointerId, current);

      if (this.pointers.size >= 2) {
        const [a, b] = Array.from(this.pointers.values());
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (this.lastPinch > 0 && distance > 0) {
          this.distance = clamp(this.distance * (this.lastPinch / distance), this.chunkSize * 0.35, this.chunkSize * 10);
        }
        if (this.lastPinchMid) {
          this.panTargetByPixels(mid.x - this.lastPinchMid.x, mid.y - this.lastPinchMid.y);
        }
        this.lastPinch = distance;
        this.lastPinchMid = mid;
        return;
      }

      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      if (this.panning) {
        this.panTargetByPixels(dx, dy);
      } else if (this.dragging) {
        this.yaw -= dx * 0.0045;
        this.pitch = clamp(this.pitch + dy * 0.0035, 0.08, 1.42);
        this.#updateCamera();
      }
    };

    this.onPointerUp = (event) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) { this.lastPinch = 0; this.lastPinchMid = null; }
      if (this.pointers.size === 0) {
        this.dragging = false;
        this.panning = false;
        this.canvas.classList.remove('dragging');
      }
    };

    this.onWheel = (event) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      if (event.shiftKey) {
        this.panTargetByPixels(-event.deltaX * unit * 0.35, -event.deltaY * unit * 0.35);
        return;
      }
      this.distance = clamp(
        this.distance * Math.exp(event.deltaY * unit * 0.0011),
        this.chunkSize * 0.35,
        this.chunkSize * 10,
      );
      this.#updateCamera();
    };

    this.onDoubleClick = () => this.resetCamera();
    this.onContextMenu = (event) => event.preventDefault();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
  }

  // --- Loop and lifecycle ---------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const tick = (now) => {
      if (!this.running) return;
      const dt = Math.max(0, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      if (dt > 0) this.fps = this.fps * 0.92 + (1 / dt) * 0.08;
      this.#updateCamera();
      this.#refreshChunks();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose() {
    this.disposed = true;
    this.stop();
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idleWorkers = [];
    this.queue = [];
    this.inFlight.clear();

    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);

    for (const key of Array.from(this.chunks.keys())) this.#disposeChunk(key);
    this.water?.geometry.dispose();
    this.water?.material.dispose();
    this.water = null;

    this.scene.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
    this.scene.clear();
    this.renderer.dispose();
    this.pointers.clear();
  }
}

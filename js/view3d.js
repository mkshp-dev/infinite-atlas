// 3D terrain view: chunked local terrain rendered with Three.js.
//
// The renderer is intentionally isolated from the 2D atlas. It owns its canvas,
// scene, camera, workers and chunk meshes, and disposes all of them when the
// view is left.

import * as THREE from '../vendor/three/three.module.min.js';
import { buildTerrainChunk, chunkKey, TERRAIN3D_DEFAULTS } from './terrain3d-data.js';
import { buildVegetationChunk } from './vegetation.js';
import { SEA_LEVEL, elevationAt } from './world.js';
import { valueNoise2 } from './noise.js';

const SKY = 0xb9cbc6;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function makeWorker() {
  return new Worker(new URL('./terrain3d-worker.js', import.meta.url), { type: 'module' });
}

export class TerrainView3D {
  constructor({ canvas, seed, centerX, centerY, onStatus, onDescent }) {
    this.canvas = canvas;
    this.seed = seed;
    this.centerX = centerX;
    this.centerY = centerY;
    this.onStatus = onStatus;
    this.onDescent = onDescent;

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

    // Parachute descent state. While active the camera is a first-person eye
    // above the ground, drifting with wind and steering, and the chunk ring is
    // clipped to the forward cone the subject can actually see.
    this.descent = {
      active: false,
      landed: false,
      x: centerX,
      z: centerY,
      startX: centerX,
      startZ: centerY,
      altitude: 0,
      startAltitude: 0,
      groundY: 0,
      yaw: 0.72,
      baseYaw: 0.72,
      pitch: -0.55,
      maxYaw: 0.85,
      vx: 0,
      vz: 0,
      time: 0,
      windAngle: 0,
      windStrength: 8,
      input: { x: 0, y: 0, dive: false },
    };

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
    this.vegetationGroup = new THREE.Group();
    this.scene.add(this.vegetationGroup);

    this.#setupLights();
    this.#setupWater();
    this.#setupVegetation();
    this.#setupClouds();
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

  // Soft procedural cloud sheet. No external image: a small canvas is filled
  // with wrapped radial blobs and repeated across a few horizontal layers.
  #makeCloudTexture() {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    let state = (this.seed >>> 0) || 1;
    const rand = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    for (let i = 0; i < 26; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const radius = 16 + rand() * 44;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cx = x + ox * size;
          const cy = y + oy * size;
          const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
          gradient.addColorStop(0, 'rgba(255,255,255,0.5)');
          gradient.addColorStop(0.55, 'rgba(255,255,255,0.2)');
          gradient.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2.4, 2.4);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  #setupClouds() {
    this.cloudTexture = this.#makeCloudTexture();
    this.cloudGroup = new THREE.Group();
    const size = this.chunkSize * 26;
    for (const [index, altitude] of [170, 340, 540].entries()) {
      const geometry = new THREE.PlaneGeometry(size, size, 1, 1);
      geometry.rotateX(-Math.PI / 2);
      const material = new THREE.MeshBasicMaterial({
        map: this.cloudTexture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.altitude = altitude;
      mesh.userData.drift = 0.0015 + index * 0.0008;
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      this.cloudGroup.add(mesh);
    }
    this.cloudGroup.visible = false;
    this.scene.add(this.cloudGroup);
  }

  #updateClouds(dt) {
    if (!this.cloudGroup) return;
    const d = this.descent;
    const altitude = d.active
      ? d.altitude
      : Math.max(0, this.camera.position.y - this.target.y);
    // Cloud sheets belong to the canopy experience; free roam stays clear.
    this.cloudGroup.visible = d.active && altitude > 45;
    if (!this.cloudGroup.visible) return;
    let anyVisible = false;
    for (const mesh of this.cloudGroup.children) {
      const rel = altitude - mesh.userData.altitude;
      // Each sheet is a band the subject passes through: it fades in just
      // above the eye, peaks while the camera is inside the layer, and is gone
      // once the camera has dropped well below it. Only one band is strong at
      // a time, so the veil never stacks into white-out.
      const rise = smoothstep(15, 55, rel);
      const fall = 1 - smoothstep(160, 320, rel);
      const opacity = 0.15 * rise * fall;
      mesh.material.opacity = opacity;
      mesh.visible = opacity > 0.005;
      anyVisible = anyVisible || mesh.visible;
      mesh.position.set(this.target.x, this.target.y + mesh.userData.altitude, this.target.z);
      mesh.rotation.y += dt * mesh.userData.drift;
    }
    this.cloudGroup.visible = anyVisible;
  }

  #setupVegetation() {
    this.vegGeometries = this.#createVegetationGeometries();
    this.vegMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.vegetationStats = { treeInstances: 0, groundInstances: 0, chunks: 0, generationMs: 0, batches: 0, lodDist: [0, 0, 0], approxMemoryMB: 0 };
  }

  #createVegetationGeometries() {
    // Low-poly archetypes sized in world metres. Parts are baked into one
    // vertex-coloured geometry per archetype so each chunk needs one
    // InstancedMesh per vegetation type instead of one per material part.
    const tint = (geometry, hex) => {
      const c = new THREE.Color(hex).convertSRGBToLinear();
      const count = geometry.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      return geometry;
    };

    const merge = (parts) => {
      let vertexCount = 0;
      let indexCount = 0;
      for (const g of parts) {
        vertexCount += g.attributes.position.count;
        indexCount += g.index ? g.index.count : g.attributes.position.count;
      }
      const pos = new Float32Array(vertexCount * 3);
      const norm = new Float32Array(vertexCount * 3);
      const col = new Float32Array(vertexCount * 3);
      const idx = new Uint32Array(indexCount);
      let vOff = 0;
      let iOff = 0;
      for (const g of parts) {
        pos.set(g.attributes.position.array, vOff * 3);
        norm.set(g.attributes.normal.array, vOff * 3);
        col.set(g.attributes.color.array, vOff * 3);
        const src = g.index ? g.index.array : null;
        const n = g.index ? g.index.count : g.attributes.position.count;
        for (let i = 0; i < n; i++) idx[iOff + i] = (src ? src[i] : i) + vOff;
        vOff += g.attributes.position.count;
        iOff += n;
      }
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
      out.setAttribute('color', new THREE.BufferAttribute(col, 3));
      out.setIndex(new THREE.BufferAttribute(idx, 1));
      out.computeBoundingSphere();
      return out;
    };

    const trunk = (rTop, rBottom, height, segments = 6) => {
      const g = new THREE.CylinderGeometry(rTop, rBottom, height, segments);
      g.translate(0, height / 2, 0);
      return g;
    };

    const broadleaf = merge([
      tint(trunk(0.35, 0.55, 6.2), 0x7a6248),
      tint((() => { const g = new THREE.IcosahedronGeometry(3.2, 1); g.translate(0, 8.2, 0); return g; })(), 0x6fa05a),
    ]);

    const tall = merge([
      tint(trunk(0.28, 0.46, 9.2), 0x6b563e),
      tint((() => { const g = new THREE.ConeGeometry(2.7, 6.2, 7); g.translate(0, 10.4, 0); return g; })(), 0x527f58),
      tint((() => { const g = new THREE.ConeGeometry(2.0, 4.6, 7); g.translate(0, 14.0, 0); return g; })(), 0x5b8a5e),
    ]);

    const tropical = merge([
      tint(trunk(0.32, 0.52, 8.0), 0x6b5334),
      tint((() => {
        const g = new THREE.SphereGeometry(3.6, 8, 6);
        g.scale(1.25, 0.7, 1.25);
        g.translate(0, 9.1, 0);
        return g;
      })(), 0x549a4a),
    ]);

    const small = merge([
      tint(trunk(0.22, 0.36, 3.6, 5), 0x6a5138),
      tint((() => { const g = new THREE.SphereGeometry(1.9, 7, 6); g.translate(0, 4.5, 0); return g; })(), 0x86a95e),
    ]);

    const shrub = tint((() => {
      const g = new THREE.SphereGeometry(1.2, 6, 5);
      g.scale(1.1, 0.8, 1.1);
      g.translate(0, 0.9, 0);
      return g;
    })(), 0x74a05a);

    const grass = tint((() => {
      const g = new THREE.ConeGeometry(0.45, 1.2, 5);
      g.translate(0, 0.6, 0);
      return g;
    })(), 0x93b064);

    return { broadleaf, tall, tropical, small, shrub, grass };
  }

  // --- Chunk management -----------------------------------------------------

  // In descent the visible disc shrinks as the subject nears the ground: the
  // horizon is closer, the fog closes in and the chunk ring can be smaller.
  // This is the 3D version of the 2D descent's altitude -> zoom rule.
  #activeRadius() {
    if (!this.descent.active) return this.visibleRadius;
    const altitude = this.descent.altitude;
    const radius = Math.ceil(2 + (altitude / this.chunkSize) * 3.2);
    return clamp(radius, 2, this.visibleRadius);
  }

  #updateFog() {
    if (!this.scene.fog) return;
    if (!this.descent.active) {
      this.scene.fog.near = this.chunkSize * 3.2;
      this.scene.fog.far = this.chunkSize * 11;
      return;
    }
    const radius = this.#activeRadius();
    const far = radius * this.chunkSize * 1.15;
    this.scene.fog.near = far * 0.34;
    this.scene.fog.far = far;
  }

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

    const radius = this.#activeRadius();
    const wanted = new Map();
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const cx = targetChunkX + dx;
        const cy = targetChunkY + dy;
        const centerX = (cx + 0.5) * this.chunkSize;
        const centerY = (cy + 0.5) * this.chunkSize;
        const distance = Math.hypot(centerX - this.target.x, centerY - this.target.z);
        if (distance > radius * this.chunkSize * 1.08) continue;
        if (!this.#inDescentView(cx, cy, distance)) continue;
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

    // Shrinking the ring on the way down should actually free the far chunks,
    // not just stop asking for them. They are already almost fully fogged.
    if (this.descent.active) {
      const cull = radius * this.chunkSize * 1.15;
      for (const chunk of Array.from(this.chunks.values())) {
        const cx = (chunk.cx + 0.5) * this.chunkSize;
        const cy = (chunk.cy + 0.5) * this.chunkSize;
        if (Math.hypot(cx - this.target.x, cy - this.target.z) > cull) {
          this.#disposeChunk(chunk.key);
        }
      }
    }

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

  // Chunks in front of the camera are worth more than chunks behind it. This
  // is only a scheduling bias: every chunk in the ring is still generated, so
  // turning the camera never reveals a hole.
  #viewBias(cx, cy) {
    const dx = (cx + 0.5) * this.chunkSize - this.target.x;
    const dz = (cy + 0.5) * this.chunkSize - this.target.z;
    const length = Math.hypot(dx, dz) || 1;
    const descent = this.descent.active;
    const forwardX = descent ? Math.sin(this.yaw) : -Math.sin(this.yaw);
    const forwardZ = descent ? Math.cos(this.yaw) : -Math.cos(this.yaw);
    const dot = (dx * forwardX + dz * forwardZ) / length;
    return -dot * this.chunkSize * 0.75;
  }

  #enqueue(req) {
    const job = {
      ...req,
      id: ++this.requestId,
      epoch: this.epoch,
      seed: this.seed,
      priority:
        req.distance +
        req.lod * this.chunkSize * 0.5 +
        this.#viewBias(req.cx, req.cy),
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
          const vegetation = buildVegetationChunk({
            seed: job.seed, cx: job.cx, cy: job.cy,
            chunkSize: this.chunkSize, heightScale: this.heightScale,
          });
          this.#applyChunk({ ...data, vegetation, id: job.id, epoch: job.epoch });
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
      // Find the request by id (the worker does not know the cache key) and
      // put it back so one bad chunk does not stall the stream.
      for (const [key, job] of Array.from(this.inFlight.entries())) {
        if (job.id !== message.id) continue;
        job.attempts = (job.attempts || 0) + 1;
        if (job.attempts > 2) {
          this.inFlight.delete(key);
        } else if (job.epoch === this.epoch && !this.queue.includes(job)) {
          this.queue.push(job);
        }
        break;
      }
      this.queue.sort((a, b) => a.priority - b.priority);
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
      vegetation: null,
      vegetationData: data.vegetation || null,
      sourceData: data,
      lastUsed: performance.now(),
      triangles: geometry.index.count / 3 + (data.skirtIndices ? data.skirtIndices.length / 3 : 0),
    };
    this.chunks.set(key, chunk);
    this.#rebuildNeighborEdges(chunk.cx, chunk.cy);
    if (chunk.vegetationData) this.#applyVegetation(chunk, chunk.vegetationData);
    this.#recomputeBounds();
    this.ready = this.chunks.size > 0;
    this.status = this.ready ? 'ready' : 'building';
    this.#updateStatus();
  }

  #disposeChunk(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    const { cx, cy } = chunk;
    this.#disposeVegetation(chunk);
    for (const obj of [chunk.mesh, chunk.skirt]) {
      if (!obj) continue;
      this.group.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    this.chunks.delete(key);
    this.evictedChunks += 1;
    this.#updateVegetationStats();
    this.#rebuildNeighborEdges(cx, cy);
  }

  #disposeVegetation(chunk) {
    if (!chunk?.vegetation) return;
    for (const mesh of chunk.vegetation.meshes) {
      this.vegetationGroup.remove(mesh);
      mesh.dispose?.();
    }
    chunk.vegetation = null;
  }

  #applyVegetation(chunk, vegetationData) {
    this.#disposeVegetation(chunk);
    if (!vegetationData?.instances) return;
    const meshes = [];
    let treeInstances = 0;
    let groundInstances = 0;
    const lodLevel = this.#vegetationLodForChunk(chunk);
    const dummy = this._vegDummy || (this._vegDummy = new THREE.Object3D());
    const color = this._vegColor || (this._vegColor = new THREE.Color());
    const hasColor = THREE.InstancedMesh.prototype.setColorAt !== undefined;

    for (const [type, arr] of Object.entries(vegetationData.instances)) {
      const count = arr.length / 7;
      if (count === 0) continue;
      const geometry = this.vegGeometries[type];
      if (!geometry) continue;
      let visible = 0;
      for (let i = 0; i < count; i++) {
        if ((arr[i * 7 + 6] || 7) & (1 << lodLevel)) visible += 1;
      }
      if (visible === 0) continue;

      const mesh = new THREE.InstancedMesh(geometry, this.vegMaterial, visible);
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      let j = 0;
      for (let i = 0; i < count; i++) {
        const o = i * 7;
        if (!((arr[o + 6] || 7) & (1 << lodLevel))) continue;
        const v = arr[o + 5] || 0;
        dummy.position.set(arr[o], arr[o + 1], arr[o + 2]);
        dummy.rotation.set(0, arr[o + 4], 0);
        const s = arr[o + 3];
        if (type === 'grass' || type === 'shrub') {
          dummy.scale.set(s, s * (1 + v * 0.6), s);
        } else {
          // Slight per-tree height/width variation keeps a stand from looking
          // like clones without another instance attribute.
          dummy.scale.set(s * (1 - v * 0.35), s * (1 + v * 0.7), s * (1 - v * 0.35));
        }
        dummy.updateMatrix();
        mesh.setMatrixAt(j, dummy.matrix);
        if (hasColor) {
          color.setRGB(1 + v, 1 + v * 0.9, 1 + v * 0.7);
          mesh.setColorAt(j, color);
        }
        j += 1;
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere?.();
      mesh.frustumCulled = true;
      mesh.userData.vegType = type;
      mesh.userData.lodLevel = lodLevel;
      this.vegetationGroup.add(mesh);
      meshes.push(mesh);
      if (type === 'grass' || type === 'shrub') groundInstances += visible;
      else treeInstances += visible;
    }
    chunk.vegetation = {
      meshes,
      treeInstances,
      groundInstances,
      lodLevel,
      generationMs: vegetationData.generationMs || 0,
    };
    this.#updateVegetationStats();
  }

  // Detail bands are tied to how high the camera is, not just to the chunk
  // grid: high above the ground you see a lot of terrain but little detail,
  // and as the camera drops the near band tightens and more instances appear.
  // Hysteresis keeps slow motion from flipping a chunk back and forth.
  #vegetationLodForChunk(chunk) {
    const centerX = (chunk.cx + 0.5) * this.chunkSize;
    const centerY = (chunk.cy + 0.5) * this.chunkSize;
    const d = Math.hypot(centerX - this.target.x, centerY - this.target.z);
    const altitude = Math.max(this.chunkSize * 0.3, this.camera.position.y - this.target.y);
    // The full-detail band always covers at least the chunk under the camera,
    // then grows slowly with height. Scaling it straight off altitude made the
    // foreground lose detail exactly as the camera dropped towards it.
    const near = this.chunkSize * 0.9 + altitude * 0.25;
    const mid = this.chunkSize * 2.0 + altitude * 0.6;
    const pad = Math.max(48, altitude * 0.12);
    const current = chunk.vegetation?.lodLevel;
    if (current === 0) {
      if (d > mid + pad) return 2;
      if (d > near + pad) return 1;
      return 0;
    }
    if (current === 1) {
      if (d < near - pad) return 0;
      if (d > mid + pad) return 2;
      return 1;
    }
    if (current === 2) {
      if (d < near - pad) return 0;
      if (d < mid - pad) return 1;
      return 2;
    }
    if (d <= near) return 0;
    if (d <= mid) return 1;
    return 2;
  }

  #updateVegetationLods() {
    let changed = false;
    for (const chunk of this.chunks.values()) {
      if (!chunk.vegetationData) continue;
      const lodLevel = this.#vegetationLodForChunk(chunk);
      if (chunk.vegetation?.lodLevel === lodLevel) continue;
      this.#applyVegetation(chunk, chunk.vegetationData);
      changed = true;
    }
    if (changed) this.#updateVegetationStats();
  }

  #updateVegetationStats() {
    let treeInstances = 0;
    let groundInstances = 0;
    let chunks = 0;
    let generationMs = 0;
    let batches = 0;
    const lodDist = [0, 0, 0];
    for (const c of this.chunks.values()) {
      if (!c.vegetation) continue;
      chunks += 1;
      treeInstances += c.vegetation.treeInstances;
      groundInstances += c.vegetation.groundInstances;
      generationMs += c.vegetation.generationMs || 0;
      batches += c.vegetation.meshes.length;
      lodDist[c.vegetation.lodLevel || 0] += c.vegetation.treeInstances + c.vegetation.groundInstances;
    }
    // 16 floats per instance matrix + 3 per instance colour, plus JS overhead.
    const approxMemoryMB = ((treeInstances + groundInstances) * 76) / (1024 * 1024);
    this.vegetationStats = {
      treeInstances,
      groundInstances,
      chunks,
      generationMs,
      batches,
      lodDist,
      approxMemoryMB,
    };
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
      radius: this.#activeRadius(),
      evictedChunks: this.evictedChunks,
      completedJobs: this.completedJobs,
      vegetation: this.vegetationStats || { treeInstances: 0, groundInstances: 0, chunks: 0, generationMs: 0, batches: 0, lodDist: [0, 0, 0], approxMemoryMB: 0 },
      descent: this.getDescent(),
    };
  }

  // --- World / camera -------------------------------------------------------

  setWorld(seed, centerX, centerY) {
    this.seed = seed;
    this.descent.active = false;
    this.descent.landed = false;
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
    if (this.descent.active) this.stopDescent();
    this.yaw = 0.72;
    this.pitch = 0.62;
    this.distance = this.chunkSize * 2.8;
    this.#updateCamera();
    this.#refreshChunks(true);
  }

  #groundHeight(x, z) {
    return (elevationAt(x, z, this.seed, 6) - SEA_LEVEL) * this.heightScale;
  }

  #updateCamera() {
    // Keep the orbit centred on the ground and the camera above the surface.
    // Without this the camera can slip inside a hill, which shows the skirt
    // walls and makes near vegetation impossible to judge.
    const targetGround = this.#groundHeight(this.target.x, this.target.z);
    this.target.y += (targetGround - this.target.y) * 0.2;

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const x = this.target.x + this.distance * cp * Math.sin(this.yaw);
    const z = this.target.z + this.distance * cp * Math.cos(this.yaw);
    let y = this.target.y + this.distance * sp;
    const floor = this.#groundHeight(x, z) + Math.max(6, this.heightScale * 0.01);
    if (y < floor) y = floor;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  panTargetByPixels(dx, dy) {
    // The canopy view has no free pan: the subject can look around inside a
    // cone and steer the drift, but cannot slide the whole world sideways.
    if (this.descent.active) return;
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

  // --- Parachute descent ----------------------------------------------------

  getDescent() {
    const d = this.descent;
    return {
      active: d.active,
      landed: d.landed,
      altitude: d.altitude,
      startAltitude: d.startAltitude,
      x: d.x,
      y: d.z,
      groundY: d.groundY,
      yaw: d.yaw,
      baseYaw: d.baseYaw,
      maxYaw: d.maxYaw,
    };
  }

  setDescentInput(input = {}) {
    this.descent.input = {
      x: clamp(Number(input.x) || 0, -1, 1),
      y: clamp(Number(input.y) || 0, -1, 1),
      dive: Boolean(input.dive),
    };
  }

  startDescent({ x, y, altitude = 640 } = {}) {
    const d = this.descent;
    const startX = Number.isFinite(x) ? x : this.target.x;
    const startZ = Number.isFinite(y) ? y : this.target.z;
    d.active = true;
    d.landed = false;
    d.x = startX;
    d.z = startZ;
    d.startX = startX;
    d.startZ = startZ;
    d.altitude = Math.max(60, Number(altitude) || 640);
    d.startAltitude = d.altitude;
    d.groundY = this.#groundHeight(startX, startZ);
    // Orbit forward is (-sin(yaw), -cos(yaw)); the canopy looks along
    // (+sin, +cos), so add half a turn to keep the view continuous.
    d.baseYaw = this.yaw + Math.PI;
    d.yaw = d.baseYaw;
    d.pitch = -0.55;
    d.vx = 0;
    d.vz = 0;
    d.time = 0;
    d.windAngle = ((this.seed >>> 0) % 6283) / 1000;
    d.windStrength = 8;
    d.input = { x: 0, y: 0, dive: false };
    this.target.set(startX, d.groundY, startZ);
    this.#updateDescentCamera(0);
    this.#refreshChunks(true);
    this.#updateStatus(true);
    this.onDescent?.({ type: 'start', ...this.getDescent() });
  }

  stopDescent({ land = false } = {}) {
    const d = this.descent;
    if (!d.active && !d.landed) return;
    const wasActive = d.active;
    d.active = false;
    d.landed = Boolean(land);
    this.target.set(d.x, this.#groundHeight(d.x, d.z), d.z);
    // Orbit yaw places the camera opposite its forward direction, so flip it
    // to keep looking the way the canopy was facing instead of snapping round.
    this.yaw = d.yaw + Math.PI;
    this.pitch = land ? 0.38 : 0.55;
    this.distance = this.chunkSize * (land ? 0.85 : 1.7);
    this.#updateCamera();
    this.#updateFog();
    this.#refreshChunks(true);
    this.#updateStatus(true);
    if (wasActive || land) this.onDescent?.({ type: land ? 'land' : 'stop', ...this.getDescent() });
  }

  toggleDescent(options) {
    if (this.descent.active) this.stopDescent();
    else this.startDescent(options);
  }

  #inDescentView(cx, cy, distance) {
    if (!this.descent.active) return true;
    // A forward cone plus a small all-round collar: turning the head inside
    // the allowed yaw range can never expose an ungenerated chunk, but the
    // ring behind the subject is not paid for.
    if (distance < this.chunkSize * 1.8) return true;
    const dx = (cx + 0.5) * this.chunkSize - this.descent.x;
    const dz = (cy + 0.5) * this.chunkSize - this.descent.z;
    const length = Math.hypot(dx, dz) || 1;
    const dot = (dx * Math.sin(this.descent.baseYaw) + dz * Math.cos(this.descent.baseYaw)) / length;
    return dot > 0.12;
  }

  #updateDescentCamera(dt) {
    const d = this.descent;
    if (!d.active) return;
    d.time += dt;

    const ground = this.#groundHeight(d.x, d.z);
    d.groundY = ground;

    const wander = valueNoise2(d.time * 0.035, 4.2, this.seed ^ 0x9e37);
    d.windAngle = ((this.seed >>> 0) % 6283) / 1000 + (wander - 0.5) * 1.6;
    d.windStrength = 7 + 9 * valueNoise2(d.time * 0.045, 9.1, this.seed ^ 0x51a7);
    const windX = Math.cos(d.windAngle) * d.windStrength;
    const windZ = Math.sin(d.windAngle) * d.windStrength;

    const steer = d.input;
    const accel = 18;
    // Steering is relative to where the canopy is facing, so W always drifts
    // towards the view and A/D strafe across it.
    const forward = -steer.y;
    const right = steer.x;
    d.vx += (Math.sin(d.yaw) * forward + Math.cos(d.yaw) * right) * accel * dt;
    d.vz += (Math.cos(d.yaw) * forward - Math.sin(d.yaw) * right) * accel * dt;
    const drag = 1 - Math.exp(-dt * 0.85);
    d.vx += (windX - d.vx) * drag * 0.6;
    d.vz += (windZ - d.vz) * drag * 0.6;
    const speed = Math.hypot(d.vx, d.vz);
    const maxSpeed = 22;
    if (speed > maxSpeed) {
      d.vx *= maxSpeed / speed;
      d.vz *= maxSpeed / speed;
    }
    d.x += d.vx * dt;
    d.z += d.vz * dt;

    const fall = 13 * (steer.dive ? 1.95 : 1) * (1 + Math.min(0.3, speed / 120));
    d.altitude = Math.max(0, d.altitude - fall * dt);

    this.target.set(d.x, ground, d.z);
    this.yaw = d.yaw;

    const eyeY = ground + d.altitude;
    this.camera.position.set(d.x, eyeY, d.z);
    const cp = Math.cos(d.pitch);
    const lookDistance = 140;
    this.camera.lookAt(
      d.x + Math.sin(d.yaw) * cp * lookDistance,
      eyeY + Math.sin(d.pitch) * lookDistance,
      d.z + Math.cos(d.yaw) * cp * lookDistance,
    );

    if (d.altitude <= 0) {
      d.altitude = 0;
      this.stopDescent({ land: true });
    }
  }

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

      if (this.descent.active) {
        if (this.pointers.size >= 2) return;
        const d = this.descent;
        d.yaw = clamp(
          d.yaw - (current.x - previous.x) * 0.0032,
          d.baseYaw - d.maxYaw,
          d.baseYaw + d.maxYaw,
        );
        d.pitch = clamp(d.pitch - (current.y - previous.y) * 0.0026, -0.95, -0.12);
        return;
      }

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
      if (this.descent.active) return;
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
      // Cap dt so a background tab or a long hitch cannot teleport the
      // descent (or spin the wind model) forward by seconds at once.
      const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      if (dt > 0) this.fps = this.fps * 0.92 + (1 / dt) * 0.08;
      if (this.descent.active) this.#updateDescentCamera(dt);
      else this.#updateCamera();
      this.#updateFog();
      this.#updateClouds(dt);
      this.#refreshChunks();
      this._vegLodTick = (this._vegLodTick || 0) + 1;
      if (this._vegLodTick % 30 === 0) this.#updateVegetationLods();
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
    for (const geometry of Object.values(this.vegGeometries || {})) geometry.dispose();
    this.vegGeometries = null;
    this.vegMaterial?.dispose();
    this.vegMaterial = null;
    this.water?.geometry.dispose();
    this.water?.material.dispose();
    this.water = null;

    if (this.cloudGroup) {
      for (const mesh of this.cloudGroup.children) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      this.cloudGroup.clear();
      this.cloudGroup = null;
    }
    this.cloudTexture?.dispose();
    this.cloudTexture = null;

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

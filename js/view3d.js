// 3D terrain view: a bounded local landscape rendered with Three.js.
//
// The renderer is intentionally isolated from the 2D atlas. It owns its canvas,
// scene, camera and worker, and disposes all of them when the view is left.

import * as THREE from '../vendor/three/three.module.min.js';
import { buildTerrainGrid, TERRAIN3D_DEFAULTS } from './terrain3d-data.js';

const SKY = 0xb9cbc6;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export class TerrainView3D {
  constructor({ canvas, seed, centerX, centerY, onStatus }) {
    this.canvas = canvas;
    this.seed = seed;
    this.centerX = centerX;
    this.centerY = centerY;
    this.onStatus = onStatus;

    this.size = TERRAIN3D_DEFAULTS.size;
    this.segments =
      window.innerWidth <= 720 ? 128 : TERRAIN3D_DEFAULTS.segments;
    this.heightScale = TERRAIN3D_DEFAULTS.heightScale;

    this.ready = false;
    this.status = 'building';
    this.error = null;
    this.generationMs = 0;
    this.triangles = 0;
    this.minHeight = 0;
    this.maxHeight = 0;
    this.fps = 0;

    this.yaw = 0.72;
    this.pitch = 0.62;
    this.distance = this.size * 0.72;
    this.target = new THREE.Vector3(0, 0, 0);
    this.pointers = new Map();
    this.lastPinch = 0;
    this.dragging = false;
    this.running = false;
    this.raf = 0;
    this.lastFrame = 0;
    this.requestId = 0;
    this.disposed = false;
    this.worker = null;
    this.terrain = null;
    this.skirt = null;

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
    this.scene.fog = new THREE.Fog(SKY, this.size * 0.85, this.size * 2.8);

    this.camera = new THREE.PerspectiveCamera(52, 1, 1, this.size * 10);

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.#setupLights();
    this.#setupWater();
    this.#bindEvents();
    this.resize();
    this.#updateCamera();
    this.load();
    this.start();
  }

  // --- Scene setup ----------------------------------------------------------

  #setupLights() {
    const hemi = new THREE.HemisphereLight(0xe6f1f2, 0x38452f, 1.5);
    this.scene.add(hemi);

    // A stable sun, derived from the seed, so the same world is lit the same
    // way every time it is opened.
    const az = (((this.seed >>> 0) % 4096) / 4096) * Math.PI * 2;
    const sun = new THREE.DirectionalLight(0xfff2d4, 2.4);
    sun.position.set(
      Math.cos(az) * this.size * 0.9,
      this.size * 0.85,
      Math.sin(az) * this.size * 0.9,
    );
    sun.target.position.set(0, 0, 0);
    this.scene.add(sun.target);
    this.scene.add(sun);
    this.sun = sun;

    const fill = new THREE.DirectionalLight(0x9fc4d8, 0.55);
    fill.position.set(-this.size * 0.8, this.size * 0.45, -this.size * 0.5);
    this.scene.add(fill);
  }

  #setupWater() {
    const geometry = new THREE.PlaneGeometry(this.size * 6, this.size * 6, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshLambertMaterial({
      color: 0x2d6f7e,
      transparent: true,
      opacity: 0.78,
    });
    this.water = new THREE.Mesh(geometry, material);
    this.water.position.y = 0.02;
    this.water.renderOrder = 1;
    this.group.add(this.water);
  }

  // --- Terrain data ---------------------------------------------------------

  load() {
    this.ready = false;
    this.status = 'building';
    this.error = null;
    this.onStatus?.('building');
    this.requestId += 1;
    const id = this.requestId;

    this.worker?.terminate();
    this.worker = null;

    try {
      const worker = new Worker(new URL('./terrain3d-worker.js', import.meta.url), {
        type: 'module',
      });
      this.worker = worker;
      worker.onmessage = (event) => {
        const message = event.data;
        if (this.disposed || !message || message.id !== id) return;
        if (message.error) {
          this.status = 'error';
          this.error = message.error;
          this.onStatus?.('error');
          return;
        }
        this.#applyData(message);
      };
      worker.onerror = (event) => {
        if (this.disposed) return;
        console.warn('3D terrain worker failed, building on the main thread:', event.message);
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        this.#fallback(id);
      };
      worker.postMessage({
        id,
        seed: this.seed,
        centerX: this.centerX,
        centerY: this.centerY,
        size: this.size,
        segments: this.segments,
        heightScale: this.heightScale,
      });
    } catch (error) {
      console.warn('Could not start 3D terrain worker:', error);
      this.#fallback(id);
    }
  }

  #fallback(id) {
    if (this.disposed) return;
    try {
      const data = buildTerrainGrid({
        seed: this.seed,
        centerX: this.centerX,
        centerY: this.centerY,
        size: this.size,
        segments: this.segments,
        heightScale: this.heightScale,
      });
      if (id === this.requestId && !this.disposed) this.#applyData(data);
    } catch (error) {
      this.status = 'error';
      this.error = String(error && error.message ? error.message : error);
      this.onStatus?.('error');
    }
  }

  #applyData(data) {
    if (this.disposed) return;
    const first = !this.terrain;
    this.#disposeTerrain();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: false,
    });

    this.terrain = new THREE.Mesh(geometry, material);
    this.group.add(this.terrain);
    this.#buildSkirt(data);

    this.size = data.size;
    this.segments = data.segments;
    this.heightScale = data.heightScale;
    this.minHeight = data.minHeight;
    this.maxHeight = data.maxHeight;
    this.triangles = data.indices.length / 3;
    this.generationMs = data.generationMs;

    this.target.set(0, Math.max(0, data.centerHeight), 0);
    if (first) this.distance = this.size * 0.72;

    this.scene.fog.near = this.size * 0.85;
    this.scene.fog.far = this.size * 2.8;

    this.ready = true;
    this.status = 'ready';
    this.onStatus?.('ready');
  }

  // The terrain is a bounded local patch. A skirt closes its four sides down
  // below sea level so the patch reads as a solid piece of ground rather than a
  // floating sheet with a visible cut edge.
  #buildSkirt(data) {
    const n = data.segments + 1;
    const top = data.positions;
    const topColors = data.colors;
    const bottomY = Math.min(0, data.minHeight) - Math.max(140, data.heightScale * 0.4);

    const ring = [];
    for (let i = 0; i < n; i++) ring.push(i);
    for (let j = 1; j < n; j++) ring.push(j * n + (n - 1));
    for (let i = n - 2; i >= 0; i--) ring.push((n - 1) * n + i);
    for (let j = n - 2; j >= 1; j--) ring.push(j * n);

    const count = ring.length;
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const indices = new Uint32Array(count * 6);
    const deep = [0.008, 0.035, 0.055];

    for (let k = 0; k < count; k++) {
      const source = ring[k] * 3;
      const o = k * 6;
      positions[o] = top[source];
      positions[o + 1] = top[source + 1];
      positions[o + 2] = top[source + 2];
      positions[o + 3] = top[source];
      positions[o + 4] = bottomY;
      positions[o + 5] = top[source + 2];

      colors[o] = topColors[source];
      colors[o + 1] = topColors[source + 1];
      colors[o + 2] = topColors[source + 2];
      colors[o + 3] = deep[0];
      colors[o + 4] = deep[1];
      colors[o + 5] = deep[2];
    }

    for (let k = 0; k < count; k++) {
      const next = (k + 1) % count;
      const a = k * 2;
      const b = a + 1;
      const c = next * 2;
      const d = c + 1;
      const o = k * 6;
      indices[o] = a;
      indices[o + 1] = b;
      indices[o + 2] = c;
      indices[o + 3] = c;
      indices[o + 4] = b;
      indices[o + 5] = d;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();

    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    this.skirt = new THREE.Mesh(geometry, material);
    this.group.add(this.skirt);
  }

  #disposeTerrain() {
    if (this.skirt) {
      this.group.remove(this.skirt);
      this.skirt.geometry.dispose();
      this.skirt.material.dispose();
      this.skirt = null;
    }
    if (!this.terrain) return;
    this.group.remove(this.terrain);
    this.terrain.geometry.dispose();
    this.terrain.material.dispose();
    this.terrain = null;
  }

  setWorld(seed, centerX, centerY) {
    this.seed = seed;
    this.centerX = centerX;
    this.centerY = centerY;
    this.yaw = 0.72;
    this.pitch = 0.62;
    this.load();
  }

  resetCamera() {
    this.yaw = 0.72;
    this.pitch = 0.62;
    this.distance = this.size * 0.72;
    this.#updateCamera();
  }

  // --- Camera ---------------------------------------------------------------

  #updateCamera() {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const x = this.target.x + this.distance * cp * Math.sin(this.yaw);
    const y = this.target.y + this.distance * sp;
    const z = this.target.z + this.distance * cp * Math.cos(this.yaw);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  getHeading() {
    return this.yaw;
  }

  getCenter() {
    return { x: this.centerX, y: this.centerY };
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
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      this.canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.dragging = this.pointers.size === 1;
      this.lastPinch = 0;
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
        if (this.lastPinch > 0 && distance > 0) {
          this.distance = clamp(
            this.distance * (this.lastPinch / distance),
            this.size * 0.16,
            this.size * 2.4,
          );
        }
        this.lastPinch = distance;
        return;
      }

      if (!this.dragging) return;
      const dx = current.x - previous.x;
      const dy = current.y - previous.y;
      this.yaw -= dx * 0.0045;
      this.pitch = clamp(this.pitch + dy * 0.0035, 0.08, 1.42);
      this.#updateCamera();
    };

    this.onPointerUp = (event) => {
      this.pointers.delete(event.pointerId);
      if (this.pointers.size < 2) this.lastPinch = 0;
      if (this.pointers.size === 0) {
        this.dragging = false;
        this.canvas.classList.remove('dragging');
      }
    };

    this.onWheel = (event) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      this.distance = clamp(
        this.distance * Math.exp(event.deltaY * unit * 0.0011),
        this.size * 0.16,
        this.size * 2.4,
      );
      this.#updateCamera();
    };

    this.onDoubleClick = () => this.resetCamera();

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', this.onDoubleClick);

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
    this.worker?.terminate();
    this.worker = null;
    this.requestId += 1;

    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('dblclick', this.onDoubleClick);

    this.#disposeTerrain();
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

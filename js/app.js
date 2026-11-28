// App shell: camera, input, tile drawing and HUD.
// All generation happens in workers; this file only decides what is on screen.

import { TILE_SIZE, findStart } from './terrain.js';
import { clamp, hashString } from './noise.js';
import { TileEngine } from './tiles.js';
import { DescentAudio } from './audio.js';
import {
  Descent,
  START_ALTITUDE,
  altitudeToScale,
  scaleToAltitude,
  drawDescentScene,
} from './descent.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 32;
const START_VIEW_WORLD = 2600;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const WORKER_COUNT = Math.min(Math.max((navigator.hardwareConcurrency || 4) - 1, 2), 6);
const MAX_TILES = DPR > 1.5 ? 72 : 160;

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d', { alpha: false });

const seedInput = $('seed');
const posEl = $('stat-pos');
const altEl = $('stat-alt');
const scaleEl = $('stat-scale');
const levelEl = $('stat-level');
const fpsEl = $('stat-fps');
const statusEl = $('status');
const scaleLine = $('scale-line');
const scaleLabel = $('scale-label');
const flashEl = $('flash');
const toastEl = $('toast');
const hintEl = $('hint');
const viewSwitch = $('view-switch');
const modeDescentBtn = $('mode-descent');
const modeAtlasBtn = $('mode-atlas');
const mode3dBtn = $('mode-3d');
const descend3dBtn = $('descend-3d');
const soundBtn = $('sound');
const canvas3d = $('terrain3d');
const viewThirdBtn = $('view-third');
const viewFirstBtn = $('view-first');
const compassEl = document.querySelector('.compass');

const ADJECTIVES = ['quiet', 'amber', 'hollow', 'frost', 'ember', 'salt', 'moss', 'pale', 'wild', 'dusk', 'iron', 'glass', 'slow', 'north', 'burnt', 'silver'];
const NOUNS = ['harbor', 'ridge', 'marsh', 'delta', 'basin', 'vale', 'reach', 'strand', 'mesa', 'fen', 'cove', 'field', 'isles', 'point', 'creek', 'heath'];

const formatNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function randomSeed() {
  const a = ADJECTIVES[(Math.random() * ADJECTIVES.length) | 0];
  const b = NOUNS[(Math.random() * NOUNS.length) | 0];
  return `${a}-${b}-${10 + ((Math.random() * 90) | 0)}`;
}

// --- Initial state ----------------------------------------------------------

const params = new URLSearchParams(location.hash.replace(/^#/, ''));
const seedText = (params.get('seed') || '').trim() || randomSeed();
const seed = hashString(seedText);

const urlX = parseFloat(params.get('x'));
const urlY = parseFloat(params.get('y'));
const urlZ = parseFloat(params.get('z'));
const hasView = Number.isFinite(urlX) && Number.isFinite(urlY) && Number.isFinite(urlZ);

// On a phone the viewport is much narrower, so a fixed zoom would open on a
// tiny slice of the chosen coastline. Fit roughly the same amount of world.
function startScale() {
  const width = canvas.clientWidth || window.innerWidth || 1440;
  return clamp(width / START_VIEW_WORLD, 0.22, 0.7);
}

// Descent is the default experience: a parachutist drifts down and the world
// resolves as the altitude drops. Atlas is the original free-roam view, and 3D
// is a separate bounded terrain renderer over the same world.
const requestedMode = params.get('mode');
const startMode =
  requestedMode === 'atlas' ? 'atlas' : requestedMode === '3d' ? '3d' : 'descent';
const startView = params.get('view') === 'first' ? 'first' : 'third';

const start = hasView
  ? { x: urlX, y: urlY, scale: clamp(urlZ, MIN_SCALE, MAX_SCALE) }
  : (() => {
      const spot = findStart(seed, START_VIEW_WORLD, startMode !== 'atlas');
      return { x: spot.x, y: spot.y, scale: startScale() };
    })();

const descent = new Descent({
  seed,
  x: start.x,
  y: start.y,
  // A shared view stores scale in z; in descent the altitude is the source of
  // truth, so convert back rather than trusting both.
  altitude:
    startMode === 'descent' && hasView
      ? scaleToAltitude(clamp(urlZ, MIN_SCALE, MAX_SCALE))
      : START_ALTITUDE,
});

const startCam =
  startMode === 'descent'
    ? { x: descent.x, y: descent.y, scale: altitudeToScale(descent.altitude) }
    : { x: start.x, y: start.y, scale: start.scale };

const state = {
  seedText,
  seed,
  mode: startMode,
  view: startView,
  descent,
  cam: { x: startCam.x, y: startCam.y, scale: startCam.scale },
  target: { x: startCam.x, y: startCam.y, scale: startCam.scale },
  options: { shading: true, contours: true, grain: true },
  level: 0,
  landed: descent.landed,
  // The 3D view is created lazily and owns its own canvas and render loop.
  view3d: null,
  view3dStatus: 'idle',
  // Hold the drop until the opening view has tiles, so the first thing seen is
  // the world at 1×, then the descent begins.
  dropping: false,
};

let engine;
try {
  engine = new TileEngine({
    dpr: DPR,
    workerCount: WORKER_COUNT,
    maxTiles: MAX_TILES,
  });
} catch (error) {
  console.error('Could not start tile workers:', error);
  statusEl.textContent = 'workers unavailable';
}

if (engine) engine.configure({ seed: state.seed, options: state.options });

// Audio is procedural and starts on the first user gesture. It follows the
// descent rather than the renderer, so it works in both 2D and 3D.
const audio = new DescentAudio();

// Handy for debugging from the console and for the screenshot harness.
window.__atlas = { state, engine, audio };

seedInput.value = state.seedText;
document.title = `Infinite Atlas — ${state.seedText}`;

// --- Camera helpers ---------------------------------------------------------

function setView(x, y, scale) {
  state.target.x = x;
  state.target.y = y;
  state.target.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
  state.cam.x = state.target.x;
  state.cam.y = state.target.y;
  state.cam.scale = state.target.scale;
}

function zoomAt(clientX, clientY, factor) {
  const rect = canvas.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const scale = state.target.scale;

  const worldX = state.target.x + (px - rect.width / 2) / scale;
  const worldY = state.target.y + (py - rect.height / 2) / scale;

  state.target.scale = clamp(scale * factor, MIN_SCALE, MAX_SCALE);

  state.target.x = worldX - (px - rect.width / 2) / state.target.scale;
  state.target.y = worldY - (py - rect.height / 2) / state.target.scale;
}

// On a phone the control panel spans the top of the screen, so the subject is
// pushed down from the exact centre. Everything that maps screen space back to
// the subject (camera and steering) uses this same offset.
function descentDrop() {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  return width <= 720 ? Math.min(220, height * 0.24) : 0;
}

// In descent the subject owns the camera. Altitude maps to zoom, so the view
// gets closer and more detailed without any extra world data being stored.
function syncDescentCamera() {
  const d = state.descent;
  const scale = altitudeToScale(d.altitude);
  const drop = descentDrop();

  state.cam.x = d.x;
  state.cam.y = d.y - drop / scale;
  state.cam.scale = scale;
  state.target.x = state.cam.x;
  state.target.y = state.cam.y;
  state.target.scale = state.cam.scale;
}

// Pointer steering is a virtual stick around the subject: hold near it for a
// gentle nudge, push toward an edge to lean into it.
function pointerSteer() {
  if (pointers.size === 0) return null;
  const rect = canvas.getBoundingClientRect();
  const [pointer] = pointers.values();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2 + descentDrop();
  const nx = (pointer.x - cx) / (rect.width * 0.34);
  const ny = (pointer.y - cy) / (rect.height * 0.34);
  const length = Math.hypot(nx, ny);
  if (length < 0.12) return { x: 0, y: 0 };
  const amount = Math.min(1, length);
  return { x: (nx / length) * amount, y: (ny / length) * amount };
}

const HINTS = {
  descent:
    'drag or <kbd>WASD</kbd> to steer · <kbd>shift</kbd> dive · <kbd>V</kbd> view · <kbd>M</kbd> atlas · <kbd>3</kbd> 3D · <kbd>0</kbd> drop again',
  atlas:
    'drag to pan · scroll to zoom · <kbd>WASD</kbd> move · <kbd>R</kbd> new world · <kbd>0</kbd> reset · <kbd>3</kbd> 3D · <kbd>M</kbd> descent',
  three:
    'drag to orbit · right-drag to pan · scroll to zoom · <kbd>F</kbd> descend · <kbd>M</kbd> or <kbd>3</kbd> atlas · <kbd>0</kbd> reset camera',
  threeDescent:
    'drag to look · <kbd>WASD</kbd> steer · <kbd>shift</kbd> dive · <kbd>F</kbd> land · <kbd>M</kbd> atlas · <kbd>0</kbd> reset',
};

function syncModeUi() {
  const descending = state.mode === 'descent';
  const is3d = state.mode === '3d';

  document.body.classList.toggle('is-descent', descending);
  document.body.classList.toggle('is-3d', is3d);
  canvas3d.hidden = !is3d;

  modeDescentBtn.classList.toggle('is-active', descending);
  modeAtlasBtn.classList.toggle('is-active', state.mode === 'atlas');
  mode3dBtn.classList.toggle('is-active', is3d);
  modeDescentBtn.setAttribute('aria-pressed', String(descending));
  modeAtlasBtn.setAttribute('aria-pressed', String(state.mode === 'atlas'));
  mode3dBtn.setAttribute('aria-pressed', String(is3d));

  viewSwitch.hidden = !descending;
  const first = state.view === 'first';
  viewThirdBtn.classList.toggle('is-active', !first);
  viewFirstBtn.classList.toggle('is-active', first);
  viewThirdBtn.setAttribute('aria-pressed', String(!first));
  viewFirstBtn.setAttribute('aria-pressed', String(first));

  const descent3d = is3d && Boolean(state.view3d?.getDescent?.().active);
  hintEl.innerHTML = is3d
    ? descent3d
      ? HINTS.threeDescent
      : HINTS.three
    : descending
      ? HINTS.descent
      : HINTS.atlas;

  descend3dBtn.hidden = !is3d;
  descend3dBtn.classList.toggle('is-active', descent3d);
  descend3dBtn.setAttribute('aria-pressed', String(descent3d));
  descend3dBtn.textContent = descent3d ? 'stop descent' : 'descend from sky';

  $('reset').title = is3d
    ? descent3d
      ? 'End the descent and return to orbit (0)'
      : 'Return the 3D camera to the start (0)'
    : descending
      ? 'Drop again from the start (0)'
      : 'Return to the starting view (0)';
  canvas.setAttribute('aria-hidden', String(is3d));
  canvas.setAttribute(
    'aria-label',
    descending
      ? 'Infinite procedural terrain, parachute descent'
      : 'Infinite procedural terrain map',
  );
  canvas3d.setAttribute('aria-label', '3D terrain of the procedural world');
}

function syncSoundUi() {
  const on = audio.enabled;
  soundBtn.hidden = !audio.supported;
  soundBtn.textContent = on ? 'sound on' : 'sound off';
  soundBtn.classList.toggle('is-off', !on);
  soundBtn.setAttribute('aria-pressed', String(on));
  soundBtn.title = on ? 'Mute descent sound (U)' : 'Enable descent sound (U)';
}

// The Three.js bundle is loaded only when the 3D view is first opened, so the
// atlas and descent keep their fast start.
let view3dPromise = null;

async function enter3d() {
  state.view3dStatus = 'building';
  if (state.view3d) {
    state.view3d.setWorld(state.seed, state.cam.x, state.cam.y);
    state.view3d.start();
    applyPending3dDescent();
    return;
  }

  if (!view3dPromise) view3dPromise = import('./view3d.js');
  let module;
  try {
    module = await view3dPromise;
  } catch (error) {
    view3dPromise = null;
    console.error('Could not load the 3D view:', error);
    state.view3dStatus = 'error';
    toast('3D view unavailable');
    return;
  }

  // The person may have left while the module was loading.
  if (state.mode !== '3d' || state.view3d) return;

  try {
    state.view3d = new module.TerrainView3D({
      canvas: canvas3d,
      seed: state.seed,
      centerX: state.cam.x,
      centerY: state.cam.y,
      onStatus: (status) => {
        state.view3dStatus = status;
      },
      onDescent: (event) => {
        if (event.type === 'land') {
          toast('touchdown — 3D free roam');
          audio.land();
        }
        syncModeUi();
      },
    });
    syncModeUi();
    applyPending3dDescent();
  } catch (error) {
    console.error('Could not start the 3D view:', error);
    state.view3dStatus = 'error';
    toast('3D view unavailable');
  }
}

function leave3d() {
  if (!state.view3d) return;
  const center = state.view3d.getCenter();
  state.cam.x = center.x;
  state.cam.y = center.y;
  state.target.x = center.x;
  state.target.y = center.y;
  state.target.scale = state.cam.scale;
  state.view3d.dispose();
  state.view3d = null;
  state.view3dStatus = 'idle';
}

function toggle3dDescent() {
  const view = state.view3d;
  if (!view) return;
  const descent = view.getDescent();
  if (descent.active) {
    view.stopDescent();
    toast('3D free roam');
  } else {
    const center = view.getCenter();
    view.startDescent({ x: center.x, y: center.y, altitude: START_ALTITUDE });
    toast('descending in 3D');
  }
  syncModeUi();
}

function setMode(mode) {
  if (mode === state.mode) return;

  if (mode === '3d') {
    // Center the 3D patch on the subject, not on the mobile camera offset.
    const fromDescent = state.mode === 'descent';
    if (fromDescent) {
      state.cam.x = state.descent.x;
      state.cam.y = state.descent.y;
    }
    pending3dDescent = fromDescent ? { altitude: scaleToAltitude(state.cam.scale) } : null;
    state.mode = '3d';
    syncModeUi();
    flash();
    toast('3D terrain');
    updateHash(true);
    enter3d();
    return;
  }

  leave3d();
  if (mode === 'descent') {
    // Climb back to the top and drop over wherever the atlas was left.
    state.descent.seed = state.seed;
    state.descent.reset(state.cam.x, state.cam.y, START_ALTITUDE);
    state.landed = false;
    state.dropping = true;
    syncDescentCamera();
  } else {
    state.target.x = state.cam.x;
    state.target.y = state.cam.y;
    state.target.scale = state.cam.scale;
  }

  state.mode = mode;
  syncModeUi();
  flash();
  toast(mode === 'descent' ? 'descending' : 'free roam');
  updateHash(true);
}

function setViewMode(view) {
  if (view === state.view) return;
  state.view = view;
  syncModeUi();
  updateHash(true);
}

function flash() {
  flashEl.classList.remove('run');
  void flashEl.offsetWidth;
  flashEl.classList.add('run');
}

function applySeed(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;

  state.seedText = trimmed;
  state.seed = hashString(trimmed);
  seedInput.value = trimmed;
  seedInput.blur();
  document.title = `Infinite Atlas — ${trimmed}`;

  const spot = findStart(state.seed, START_VIEW_WORLD, state.mode !== 'atlas');
  if (state.mode === '3d') {
    state.cam.x = spot.x;
    state.cam.y = spot.y;
    state.target.x = spot.x;
    state.target.y = spot.y;
    state.target.scale = state.cam.scale;
    if (state.view3d) state.view3d.setWorld(state.seed, spot.x, spot.y);
    else enter3d();
  } else if (state.mode === 'descent') {
    state.descent.seed = state.seed;
    state.descent.reset(spot.x, spot.y, START_ALTITUDE);
    state.landed = false;
    state.dropping = true;
    syncDescentCamera();
  } else {
    setView(spot.x, spot.y, startScale());
  }
  engine?.configure({ seed: state.seed, options: state.options });
  // A new seed resets the 3D view to orbit, so refresh the canopy controls.
  syncModeUi();

  flash();
  updateHash(true);
}

function resetView() {
  if (state.mode === '3d') {
    state.view3d?.resetCamera();
    flash();
    return;
  }
  const spot = findStart(state.seed, START_VIEW_WORLD, state.mode === 'descent');
  if (state.mode === 'descent') {
    state.descent.reset(spot.x, spot.y, START_ALTITUDE);
    state.landed = false;
    state.dropping = true;
    syncDescentCamera();
  } else {
    setView(spot.x, spot.y, startScale());
  }
  flash();
}

// --- URL state --------------------------------------------------------------

// When the person jumps from the 2D descent into 3D, keep falling instead of
// dumping them into an orbit view. The view may still be lazy-loading, so the
// request waits until it exists.
let pending3dDescent = null;

function applyPending3dDescent() {
  if (!pending3dDescent || !state.view3d) return;
  const { altitude } = pending3dDescent;
  pending3dDescent = null;
  state.view3d.startDescent({ x: state.cam.x, y: state.cam.y, altitude });
  syncModeUi();
}

let lastHashAt = 0;
let lastWrittenHash = location.hash;

function updateHash(force = false) {
  const now = performance.now();
  if (!force && now - lastHashAt < 500) return;
  lastHashAt = now;

  const next = new URLSearchParams();
  const is3d = state.mode === '3d';
  const viewCenter = is3d ? state.view3d?.getCenter() : null;
  next.set('seed', state.seedText);
  next.set('mode', state.mode);
  next.set('view', state.view);
  next.set(
    'x',
    (is3d && viewCenter ? viewCenter.x : state.mode === 'descent' ? state.descent.x : state.cam.x).toFixed(1),
  );
  next.set(
    'y',
    (is3d && viewCenter ? viewCenter.y : state.mode === 'descent' ? state.descent.y : state.cam.y).toFixed(1),
  );
  next.set('z', (is3d ? 1 : state.cam.scale).toFixed(3));
  const hash = `#${next.toString()}`;
  // A shared link pasted into the address bar changes location.hash before the
  // hashchange event runs. Do not stomp on it with the state we are about to
  // replace; let the handler apply it instead.
  if (location.hash && location.hash !== lastWrittenHash && location.hash !== hash) return;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  lastWrittenHash = hash;
}

let toastTimer = 0;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
}

async function copyLink() {
  updateHash(true);
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast('link copied');
  } catch {
    const field = document.createElement('textarea');
    field.value = url;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    try {
      document.execCommand('copy');
      toast('link copied');
    } catch {
      toast('copy failed');
    }
    field.remove();
  }
}

// --- Input ------------------------------------------------------------------

const pointers = new Map();
let drag = null;
let pinch = null;

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (state.mode === 'descent') {
    // Dragging steers the canopy; the frame loop reads the pointer position.
    drag = null;
    pinch = null;
    canvas.classList.add('dragging');
    return;
  }

  if (pointers.size === 1) {
    drag = { x: event.clientX, y: event.clientY };
    canvas.classList.add('dragging');
  } else {
    drag = null;
    pinch = null;
  }
});

canvas.addEventListener('pointermove', (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (state.mode === 'descent') return;

  if (pointers.size === 1 && drag) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag = { x: event.clientX, y: event.clientY };
    state.target.x -= dx / state.target.scale;
    state.target.y -= dy / state.target.scale;
    state.cam.x = state.target.x;
    state.cam.y = state.target.y;
    return;
  }

  if (pointers.size >= 2) {
    const [a, b] = Array.from(pointers.values());
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    if (pinch) {
      const factor = distance / Math.max(pinch.distance, 1);
      zoomAt(midX, midY, factor);
      state.target.x -= (midX - pinch.midX) / state.target.scale;
      state.target.y -= (midY - pinch.midY) / state.target.scale;
      state.cam.x = state.target.x;
      state.cam.y = state.target.y;
      state.cam.scale = state.target.scale;
    }
    pinch = { distance, midX, midY };
  }
});

function endPointer(event) {
  pointers.delete(event.pointerId);
  if (pointers.size === 1) {
    const [remaining] = pointers.values();
    drag = { x: remaining.x, y: remaining.y };
  } else {
    drag = null;
  }
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) canvas.classList.remove('dragging');
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    if (state.mode === 'descent') return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.008 : 0.0016));
    zoomAt(event.clientX, event.clientY, factor);
  },
  { passive: false },
);

canvas.addEventListener('dblclick', (event) => {
  if (state.mode === 'descent') return;
  zoomAt(event.clientX, event.clientY, 2);
});

const heldKeys = new Set();

window.addEventListener('keydown', (event) => {
  const tag = event.target instanceof HTMLElement ? event.target.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  const key = event.key.toLowerCase();
  if (key === 'r') {
    applySeed(randomSeed());
  } else if (key === '0') {
    resetView();
  } else if (key === 'm') {
    setMode(state.mode === 'atlas' ? 'descent' : 'atlas');
  } else if (key === '3') {
    setMode(state.mode === '3d' ? 'atlas' : '3d');
  } else if (key === 'f') {
    if (state.mode === '3d') toggle3dDescent();
  } else if (key === 'v') {
    if (state.mode === 'descent') setViewMode(state.view === 'first' ? 'third' : 'first');
  } else if (key === 'h') {
    $('opt-shading').click();
  } else if (key === 'c') {
    $('opt-contours').click();
  } else if (key === 'g') {
    $('opt-grain').click();
  } else if (key === 'u') {
    audio.toggle();
    syncSoundUi();
  } else if (key === 'shift') {
    heldKeys.add('shift');
  } else if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', '+', '=', '-', '_'].includes(key)) {
    heldKeys.add(key);
    event.preventDefault();
  }
});

window.addEventListener('keyup', (event) => {
  heldKeys.delete(event.key.toLowerCase());
});

window.addEventListener('blur', () => heldKeys.clear());

window.addEventListener('hashchange', () => {
  const next = new URLSearchParams(location.hash.replace(/^#/, ''));
  const text = (next.get('seed') || '').trim();
  if (!text) return;

  const x = parseFloat(next.get('x'));
  const y = parseFloat(next.get('y'));
  const z = parseFloat(next.get('z'));
  const hasSharedView = Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
  const requested = next.get('mode');
  const mode = requested === 'atlas' ? 'atlas' : requested === '3d' ? '3d' : 'descent';
  const view = next.get('view') === 'first' ? 'first' : 'third';

  const seedChanged = text !== state.seedText;
  if (seedChanged) {
    state.seedText = text;
    state.seed = hashString(text);
    seedInput.value = text;
    document.title = `Infinite Atlas — ${text}`;
    engine?.configure({ seed: state.seed, options: state.options });
  }

  if (mode !== '3d') leave3d();
  state.mode = mode;
  state.view = view;
  // Unhide the 3D canvas before the renderer measures it.
  syncModeUi();

  if (mode === '3d') {
    const spot = hasSharedView ? { x, y } : findStart(state.seed, START_VIEW_WORLD, true);
    state.cam.x = spot.x;
    state.cam.y = spot.y;
    state.target.x = spot.x;
    state.target.y = spot.y;
    state.target.scale = state.cam.scale;
    if (state.view3d) state.view3d.setWorld(state.seed, spot.x, spot.y);
    else enter3d();
  } else if (mode === 'descent') {
    const spot = hasSharedView ? { x, y } : findStart(state.seed, START_VIEW_WORLD, true);
    const altitude = hasSharedView
      ? scaleToAltitude(clamp(z, MIN_SCALE, MAX_SCALE))
      : START_ALTITUDE;
    state.descent.seed = state.seed;
    state.descent.reset(spot.x, spot.y, altitude);
    state.landed = state.descent.landed;
    state.dropping = true;
    syncDescentCamera();
  } else if (hasSharedView) {
    setView(x, y, z);
  } else if (seedChanged) {
    const spot = findStart(state.seed, START_VIEW_WORLD, false);
    setView(spot.x, spot.y, startScale());
  }

  // From here on the hash is ours again, so normal updates may rewrite it.
  lastWrittenHash = location.hash;
  syncModeUi();
  flash();
});

// --- UI wiring --------------------------------------------------------------

seedInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    applySeed(seedInput.value);
  } else if (event.key === 'Escape') {
    seedInput.value = state.seedText;
    seedInput.blur();
  }
});

$('new-seed').addEventListener('click', () => applySeed(randomSeed()));
$('share').addEventListener('click', copyLink);
$('reset').addEventListener('click', resetView);
soundBtn.addEventListener('click', () => {
  audio.toggle();
  syncSoundUi();
});

modeDescentBtn.addEventListener('click', () => setMode('descent'));
modeAtlasBtn.addEventListener('click', () => setMode('atlas'));
mode3dBtn.addEventListener('click', () => setMode('3d'));
descend3dBtn.addEventListener('click', toggle3dDescent);
viewThirdBtn.addEventListener('click', () => setViewMode('third'));
viewFirstBtn.addEventListener('click', () => setViewMode('first'));
syncModeUi();
syncSoundUi();
if (startMode === '3d') enter3d();

for (const [id, option] of [
  ['opt-shading', 'shading'],
  ['opt-contours', 'contours'],
  ['opt-grain', 'grain'],
]) {
  const input = $(id);
  input.checked = state.options[option];
  input.addEventListener('change', () => {
    state.options[option] = input.checked;
    engine?.configure({ seed: state.seed, options: state.options });
  });
}

// --- Rendering --------------------------------------------------------------

function drawFallback(level, tx, ty, dx, dy, dw, dh) {
  // Zooming in: reuse a coarser ancestor, cropped to this tile's quadrant.
  for (let up = 1; up <= 4; up++) {
    const factor = 1 << up;
    const parent = engine.peek(level - up, Math.floor(tx / factor), Math.floor(ty / factor));
    if (!parent) continue;
    const source = engine.pixelSize / factor;
    const sx = (tx - Math.floor(tx / factor) * factor) * source;
    const sy = (ty - Math.floor(ty / factor) * factor) * source;
    ctx.drawImage(parent.bitmap, sx, sy, source, source, dx, dy, dw, dh);
    return true;
  }

  // Zooming out: stitch the four children, if any are cached.
  let drew = false;
  const halfW = dw / 2;
  const halfH = dh / 2;
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const child = engine.peek(level + 1, tx * 2 + cx, ty * 2 + cy);
      if (!child) continue;
      ctx.drawImage(child.bitmap, dx + cx * halfW, dy + cy * halfH, halfW, halfH);
      drew = true;
    }
  }
  return drew;
}

function render(now) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;

  const pixelWidth = Math.round(width * DPR);
  const pixelHeight = Math.round(height * DPR);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#0a1d29';
  ctx.fillRect(0, 0, width, height);

  const { x, y, scale } = state.cam;
  const level = clamp(Math.round(Math.log2(scale)), -6, 8);
  state.level = level;

  const worldSize = TILE_SIZE / 2 ** level;
  const tileScreen = worldSize * scale;
  const left = x - width / (2 * scale);
  const top = y - height / (2 * scale);

  const tx0 = Math.floor(left / worldSize);
  const tx1 = Math.floor((left + width / scale) / worldSize);
  const ty0 = Math.floor(top / worldSize);
  const ty1 = Math.floor((top + height / scale) / worldSize);

  engine?.beginFrame();

  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const screenX = (tx * worldSize - left) * scale;
      const screenY = (ty * worldSize - top) * scale;
      const dx = screenX;
      const dy = screenY;
      const dw = tileScreen;
      const dh = tileScreen;

      const entry = engine?.request(level, tx, ty);
      if (!engine) continue;

      if (!entry) {
        drawFallback(level, tx, ty, dx, dy, dw, dh);
        continue;
      }

      // Cross-fade a freshly rendered tile over whatever fallback is already
      // there. With nothing underneath, draw it opaque: fading against the
      // dark canvas would show every tile as a darker square.
      const age = now - entry.born;
      let faded = false;
      if (age < 220) faded = drawFallback(level, tx, ty, dx, dy, dw, dh);
      if (faded) ctx.globalAlpha = 0.2 + 0.8 * (age / 220);
      ctx.drawImage(entry.bitmap, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
    }
  }

  engine?.endFrame({ tx: Math.floor((x - left) / worldSize), ty: Math.floor((y - top) / worldSize) });

  if (state.mode === 'descent') {
    const d = state.descent;
    drawDescentScene(ctx, {
      sx: (d.x - left) * scale,
      sy: (d.y - top) * scale,
      width,
      height,
      time: now / 1000,
      view: state.view,
      altitude: d.altitude,
      landed: d.landed,
      windAngle: d.windAngle,
      windStrength: d.windStrength,
      dpr: DPR,
    });
  }
}

// --- HUD --------------------------------------------------------------------

let fps = 60;
let lastHud = 0;

function niceDistance(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const step of [1, 2, 5, 10]) {
    if (step * power >= raw) return step * power;
  }
  return 10 * power;
}

function formatDistance(units) {
  if (units >= 1000) {
    const km = units / 1000;
    return `${km >= 10 ? Math.round(km) : km.toFixed(1)} km`;
  }
  return `${Math.round(units)} m`;
}

function updateHud(now) {
  const pending = engine ? engine.pending : 0;
  if (now - lastHud < 140) return;
  lastHud = now;

  if (state.mode === '3d') {
    const view = state.view3d;
    const center = view?.getCenter() || { x: state.cam.x, y: state.cam.y };
    const stats = view?.stats;
    const descent = view?.getDescent?.();
    posEl.textContent = `${formatNumber.format(center.x)}, ${formatNumber.format(center.y)}`;
    altEl.textContent = descent?.active ? `${Math.round(descent.altitude)} m` : '—';
    scaleEl.textContent = '3D';
    scaleEl.title = stats
      ? `chunks ${stats.activeChunks} · pending ${stats.pendingChunks} · LOD ${stats.lodCounts.slice(0, 3).join('/')}`
      : 'chunked local terrain';
    levelEl.textContent = view?.ready ? `${Math.round(view.triangles / 1000)}k` : '—';
    fpsEl.textContent = `${Math.round(view?.fps || fps)}`;

    if (state.view3dStatus === 'error' || view?.status === 'error') {
      statusEl.textContent = '3D unavailable';
      statusEl.classList.remove('busy');
    } else if (!view || !view.ready) {
      statusEl.textContent = 'building 3D terrain';
      statusEl.classList.add('busy');
    } else {
      const pending = stats?.pendingChunks ?? 0;
      const veg = stats?.vegetation;
      const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);
      const vegTxt = veg
        ? ` · ${compact(veg.treeInstances)} trees · ${compact(veg.groundInstances)} ground`
        : '';
      if (descent?.active) {
        statusEl.textContent =
          `descending · ${Math.round(descent.altitude)} m · ${stats.activeChunks} chunks${vegTxt}`;
      } else if (descent?.landed) {
        statusEl.textContent = `landed · ${stats.activeChunks} chunks${vegTxt}`;
      } else {
        statusEl.textContent = pending > 0
          ? `streaming ${stats.activeChunks} chunks · ${pending} pending${vegTxt}`
          : `3D ready · ${stats?.activeChunks ?? 0} chunks · ${Math.round(view.generationMs)} ms${vegTxt}`;
      }
      statusEl.title = veg
        ? `vegetation: ${veg.chunks} chunks · ${veg.batches} batches · ` +
          `${Math.round(veg.generationMs)} ms · ${veg.approxMemoryMB.toFixed(2)} MB · ` +
          `LOD near/mid/far ${veg.lodDist.join('/')}`
        : '';
      statusEl.classList.toggle('busy', pending > 0);
    }

    compassEl.style.transform = `rotate(${view ? view.getHeading() : 0}rad)`;
    return;
  }

  compassEl.style.transform = '';

  posEl.textContent = `${formatNumber.format(state.cam.x)}, ${formatNumber.format(state.cam.y)}`;
  altEl.textContent =
    state.mode === 'descent' ? `${formatNumber.format(state.descent.altitude)} m` : '—';
  scaleEl.textContent = `${state.cam.scale.toFixed(2)}×`;
  levelEl.textContent = `L${state.level}`;
  fpsEl.textContent = `${Math.round(fps)}`;

  const metresPerPixel = 1 / state.cam.scale;
  scaleEl.title = `${metresPerPixel.toFixed(2)} m per pixel`;

  if (!engine) {
    statusEl.textContent = 'workers unavailable';
    statusEl.classList.remove('busy');
    return;
  }

  if (engine.cached === 0 && now > 8000) {
    statusEl.textContent = 'no tiles — serve over http';
    statusEl.classList.remove('busy');
  } else if (pending > 0) {
    statusEl.textContent = `generating ${pending} tile${pending === 1 ? '' : 's'}`;
    statusEl.classList.add('busy');
  } else if (state.mode === 'descent' && state.descent.landed) {
    statusEl.textContent = 'landed — M for atlas';
    statusEl.classList.remove('busy');
  } else {
    statusEl.textContent = 'world ready';
    statusEl.classList.remove('busy');
  }

  const distance = niceDistance(115 / state.cam.scale);
  scaleLine.style.width = `${Math.round(distance * state.cam.scale)}px`;
  scaleLabel.textContent = formatDistance(distance);
}

// --- Main loop --------------------------------------------------------------

// Feed the audio engine from whichever descent is active. The 2D model and the
// 3D canopy expose the same fall/airspeed information, so the wind follows the
// subject rather than the renderer.
function updateAudio() {
  if (state.mode === '3d') {
    const descent = state.view3d?.getDescent?.();
    if (descent?.active) {
      audio.update({
        active: true,
        altitude: descent.altitude,
        fallRate: descent.fallRate ?? 0,
        speed: descent.speed ?? Math.hypot(descent.vx || 0, descent.vz || 0),
        dive: Boolean(descent.dive),
      });
    } else {
      audio.update({ active: false });
    }
    return;
  }

  if (state.mode === 'descent' && !state.descent.landed) {
    const d = state.descent;
    audio.update({
      active: true,
      altitude: d.altitude,
      fallRate: d.fallRate,
      speed: Math.hypot(d.vx, d.vy),
      dive: heldKeys.has('shift'),
    });
    return;
  }

  audio.update({ active: false });
}

let lastTime = performance.now();

function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
  lastTime = now;

  if (dt > 0) fps = fps * 0.92 + (1 / dt) * 0.08;
  updateAudio();

  if (state.mode === '3d') {
    // The 3D view owns its own render loop and canvas. Feed it the steering
    // intent while a canopy descent is active.
    const view = state.view3d;
    if (view?.getDescent().active) {
      let steerX = 0;
      let steerY = 0;
      if (heldKeys.has('a') || heldKeys.has('arrowleft')) steerX -= 1;
      if (heldKeys.has('d') || heldKeys.has('arrowright')) steerX += 1;
      if (heldKeys.has('w') || heldKeys.has('arrowup')) steerY -= 1;
      if (heldKeys.has('s') || heldKeys.has('arrowdown')) steerY += 1;
      const length = Math.hypot(steerX, steerY);
      if (length > 0) {
        steerX /= length;
        steerY /= length;
      }
      view.setDescentInput({ x: steerX, y: steerY, dive: heldKeys.has('shift') });
    }
  } else if (state.mode === 'descent') {
    const d = state.descent;

    // Wait for the opening view before letting gravity take over.
    if (!state.dropping && engine && engine.pending === 0 && engine.cached > 0) {
      state.dropping = true;
    }

    if (state.dropping) {
      let steerX = 0;
      let steerY = 0;
      if (heldKeys.has('a') || heldKeys.has('arrowleft')) steerX -= 1;
      if (heldKeys.has('d') || heldKeys.has('arrowright')) steerX += 1;
      if (heldKeys.has('w') || heldKeys.has('arrowup')) steerY -= 1;
      if (heldKeys.has('s') || heldKeys.has('arrowdown')) steerY += 1;
      const length = Math.hypot(steerX, steerY);
      if (length > 0) {
        steerX /= length;
        steerY /= length;
      }

      const pointer = pointerSteer();
      if (pointer && (pointer.x !== 0 || pointer.y !== 0)) {
        steerX = pointer.x;
        steerY = pointer.y;
      }

      const wasLanded = d.landed;
      d.update(dt, { x: steerX, y: steerY }, heldKeys.has('shift'));
      if (d.landed && !wasLanded) {
        toast('touchdown — press M for the atlas');
        audio.land();
      }
      state.landed = d.landed;
    }

    syncDescentCamera();
  } else {
    // Smoothly chase the target camera.
    const ease = 1 - Math.exp(-dt * 16);
    state.cam.x += (state.target.x - state.cam.x) * ease;
    state.cam.y += (state.target.y - state.cam.y) * ease;
    state.cam.scale *= Math.pow(state.target.scale / state.cam.scale, ease);

    // Keyboard panning.
    let moveX = 0;
    let moveY = 0;
    if (heldKeys.has('a') || heldKeys.has('arrowleft')) moveX -= 1;
    if (heldKeys.has('d') || heldKeys.has('arrowright')) moveX += 1;
    if (heldKeys.has('w') || heldKeys.has('arrowup')) moveY -= 1;
    if (heldKeys.has('s') || heldKeys.has('arrowdown')) moveY += 1;

    if (moveX || moveY) {
      const length = Math.hypot(moveX, moveY);
      const speed = 760 / state.cam.scale;
      state.target.x += (moveX / length) * speed * dt;
      state.target.y += (moveY / length) * speed * dt;
    }

    if (heldKeys.has('+') || heldKeys.has('=')) {
      zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 + dt * 2.2);
    }
    if (heldKeys.has('-') || heldKeys.has('_')) {
      zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / (1 + dt * 2.2));
    }
  }

  if (engine && state.mode !== '3d') render(now);
  updateHud(now);
  updateHash();
  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => {
  // The canvas size is reconciled in render(); this just keeps the transform
  // correct for the next frame.
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
});

requestAnimationFrame(frame);

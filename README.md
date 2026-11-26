# Infinite Atlas

An endless procedural world that you fall into. A parachutist drifts down over
terrain generated entirely in the browser: as the canopy loses altitude the view
tightens and more detail resolves, and only the tiles around the subject are
ever computed. There is no world file and no server — every pixel is a pure
function of `(x, y, seed)`.

The same world can be explored free-roam in **atlas** mode, which keeps the
original slippy-map tile pyramid. Web Workers paint 256 px tiles off the main
thread, the page keeps an LRU cache of `ImageBitmap`s, and parent/child tiles
stand in during zoom transitions.

A third **3D** view turns a bounded patch of the same world into a lit,
fogged terrain mesh with Three.js. It reads the same elevation and moisture
fields, so switching renderers never changes the landscape under a seed. The
2D atlas remains the default experience and is untouched by the 3D renderer.

The pre-descent free-roam release is tagged [`v1.0.0`](https://github.com/mkshp-dev/infinite-atlas/releases/tag/v1.0.0).

## Run it

It is plain HTML, CSS and ES modules — no build step and nothing to install.
The 3D view uses a vendored copy of Three.js (`vendor/three/`, MIT), loaded
lazily only when that view is opened. Because the app uses module workers, it
needs to be served over HTTP (opening `index.html` directly will not work):

```bash
cd procedural
python3 -m http.server 8123
```

Then open <http://127.0.0.1:8123/>.

### Docker (optional)

A minimal nginx container is included in `deploy/` and serves only the public
site files (read-only). It expects an external Docker network named
`homelab-network`; adjust or remove the `networks` block for another host.

```bash
docker compose -f deploy/docker-compose.yml up -d
```

The container sets `Cache-Control: no-cache`, so changes to the bind-mounted
files appear on the next request.

## The descent

- **The drop starts at 640 m**, which maps to roughly `1×` zoom. The first
  frame waits for the opening tiles, so you see the world before gravity wins.
- **Altitude is zoom.** `altitudeToScale()` spreads 640 m down to `1×` and the
  ground up to about `19×`, so the world resolves more detail as you descend.
- **Wind moves you; steering only leans.** The canopy has mass and drag, and a
  seed-dependent wind keeps pushing it. `WASD`, arrows or a drag steer it, but
  cannot take over completely.
- **Only the viewport is generated.** The camera is anchored to the subject, so
  the tile engine requests exactly the tiles that enter the window.
- **Two views.** Third person draws the canopy and figure over the map; canopy
  cam hides the figure and frames the view with the fabric rim.
- **Touchdown.** At 0 m the canopy collapses and the status line offers the
  atlas. Press `M` (or the mode switch) to keep exploring on foot at ground
  level.

## The 3D view

The **3D** button (or `3`) opens a chunked perspective view of the same world.
It is a local Cartesian terrain, not a planet renderer: chunks stream around the
camera target as you pan.

- **Same world, second renderer.** `js/world.js` is the rendering-independent
  world API (`elevationAt`, `moistureAt`, `biomeAt`, `colorAt`). The 2D atlas,
  the descent and the 3D mesh all read from it, so a seed and coordinate mean
  the same terrain everywhere.
- **Deterministic chunks.** Each chunk identity is `(seed, chunkX, chunkY, lod)`
  on a fixed world-space grid. Heights are sampled at absolute world coordinates,
  so shared edges match regardless of generation order or LOD.
- **LOD and streaming.** Nearby chunks use finer grids, distant chunks coarser
  ones. Selection uses distance with hysteresis and enforces <=1 LOD difference
  between adjacent chunks; edge stitching hides LOD T-junctions.
- **Generated off the main thread.** `js/terrain3d-worker.js` builds per-chunk
  typed arrays (positions, colours, indices, skirts, bounds) and returns
  transferable buffers. Three.js objects are created/disposed only on the main
  thread. A bounded main-thread fallback keeps it working without workers.
- **Procedural vegetation.** Trees, shrubs and ground cover are placed
  deterministically per terrain chunk from biome/elevation/moisture/slope rules.
  Instances are rendered with `InstancedMesh`, use distance-based LOD/density
  reduction, and are disposed/cached with their chunk lifecycle.
- **Bounded and disposable.** Chunk generation has bounded worker concurrency,
  stale-request ignoring, duplicate in-flight prevention, cache/eviction, and
  GPU geometry/material disposal. Leaving 3D mode tears down renderer, workers,
  terrain and vegetation resources.
- **Diagnostics.** The HUD/status reports active chunks, pending work, triangle
  count, LOD mix, vegetation counts/batches, generation time, and FPS.

**Controls.** Drag to orbit, right-drag/shift-drag to pan the terrain target,
scroll or pinch to dolly, double-click or `0` to reset the camera. `M` or `3`
returns to the atlas and the seed box rebuilds the 3D world around the new seed.

## Controls

### Descent

| Input | Action |
| --- | --- |
| drag / one-finger drag | steer, using a virtual stick around the subject |
| `W` `A` `S` `D` or arrow keys | steer |
| `Shift` | dive faster |
| `V` | toggle third person / canopy cam |
| `M` | switch to atlas |
| `3` | switch to 3D terrain |
| `R` | new random world and a fresh drop |
| `0` | drop again from the start |
| `H` / `C` / `G` | toggle relief / contours / grain |

### Atlas

| Input | Action |
| --- | --- |
| drag / one-finger drag | pan |
| scroll / pinch | zoom at the cursor |
| double-click | zoom in |
| `W` `A` `S` `D` or arrow keys | move |
| `+` / `-` | zoom |
| `M` | switch back to descent |
| `3` | switch to 3D terrain |
| `R` | new random world |
| `0` | reset to the generated starting view |
| `H` / `C` / `G` | toggle relief / contours / grain |

### 3D terrain

| Input | Action |
| --- | --- |
| drag / one-finger drag | orbit around the patch |
| scroll / pinch | dolly in and out |
| double-click | reset the camera |
| `0` | reset the camera |
| `M` | switch to atlas |
| `3` | return to the atlas |
| `R` | new random world and mesh |

Type any text in the seed box and press <kbd>Enter</kbd> to jump to that world.
`copy link` puts the seed, mode, view and camera position in the URL hash
(`#seed=…&mode=…&view=…&x=…&y=…&z=…`). In descent, `z` is the scale and is
converted back to altitude when the link is opened, so a shared drop resumes at
the same height. In 3D, `x`/`y` are the centre of the terrain patch and `z` is
ignored.

## How it works

- **Terrain is a pure function.** `js/world.js` exposes
  `elevationAt(x, y, seed)`, which layers rotated, domain-warped value-noise
  fBm. A contrast stretch and a highland compression curve turn the
  low-contrast noise into continents, lowlands and occasional peaks. Moisture is
  a second, independent field that selects grassland, woodland and dry
  vegetation. `createWorld(seed)` binds those functions to a seed for any
  renderer.
- **Nothing is stored.** `renderRegion()` samples any rectangle of world space
  into RGBA pixels. The same rectangle and seed always produce the same pixels.
- **Tiles and level of detail.** Zoom `z` maps to tile level
  `L = round(log2(z))`; a level-`L` tile covers `256 / 2^L` world units. Octave
  count and hill-shade strength scale with the level, and close views add
  rolling micro-relief plus fine vegetation texture, so detail stays legible at
  every zoom without changing the world at a distance.
- **Workers, not the main thread.** `js/tiles.js` runs a small worker pool
  (`js/tile-worker.js`). Workers return `ImageBitmap`s that are transferred, not
  copied. The engine keeps an LRU cache and draws a cached parent (zooming in)
  or cached children (zooming out) while new tiles render.
- **The 3D mesh is data, then Three.js.** `js/terrain3d-data.js` samples a
  square grid into `Float32Array` positions and linear-space vertex colours.
  `js/terrain3d-worker.js` runs that off the main thread and transfers the
  buffers; `js/view3d.js` wraps them in a `BufferGeometry`, computes normals and
  adds the water plane, lights, fog and orbit camera. The Three.js bundle is
  loaded on first use, not at startup.
- **Seamless tiles.** Each tile is rendered with a 4 px border of neighbouring
  world and cropped, so hill-shade gradients, the height blur and contour edge
  detection never clamp at a tile boundary.
- **Cartography, not a heightmap viewer.** The renderer adds a hill-shaded
  relief layer, contour lines (major every fourth land contour), surf at the
  waterline, beach strips whose width comes from height-above-sea divided by
  local slope, broken snowfields, and a light film grain.
- **The descent model.** `js/descent.js` integrates wind, steering acceleration
  and drag, maps altitude to camera scale, and draws either the parachutist or
  the canopy rim. `js/app.js` keeps the camera on the subject, so panning and
  zooming are not separate systems in this mode — they are the fall.
- **Start view.** On a fresh seed, `findStart()` samples a spiral of candidate
  locations. Atlas prefers a coastline; descent and 3D prefer a mostly-inland
  view with relief, so the canopy comes down over terrain rather than open
  ocean. The opening zoom is derived from the viewport width, so phones see
  roughly the same slice of world as a desktop.

## Files

```
index.html          markup and panel UI
styles.css          layout, glass panel, map furniture, responsive rules
js/noise.js         hash, value noise, rotated-octave fBm, string hashing
js/world.js         shared world API: elevation, moisture, biomes, palette
js/terrain.js       renderRegion and findStart (2D cartography)
js/descent.js       parachute flight model and canopy/figure rendering
js/tiles.js         worker pool, tile cache, request/peek/endFrame, eviction
js/tile-worker.js   worker entry point: render one tile to an ImageBitmap
js/view3d.js        Three.js scene, camera controls, water, lights and disposal
js/terrain3d-data.js  shared 3D grid sampler (typed arrays, no Three.js)
js/terrain3d-worker.js  worker entry point: build and transfer the 3D grid
js/app.js           camera, input, descent/atlas/3D modes, render loop, HUD, URL state
vendor/three/       vendored Three.js module build (MIT)
tools/preview.mjs   render PNG previews with Node (no browser)
tools/screenshot.mjs  Playwright screenshots of the real app
tools/test.mjs      end-to-end interaction/console-error test
tools/descent-test.mjs  descent, canopy cam, landing and mode-toggle test
tools/view3d-test.mjs  3D mesh, orbit, disposal, seed and reload test
tools/zoomcheck.mjs same view rendered at several zoom levels
```

## Customizing

The world itself lives in `js/world.js`:

- `BASE_SCALE` — wavelength of the continent shapes. Larger means bigger,
  rarer landmasses.
- `SEA_LEVEL` and the contrast/compression in `elevationAt()` — how much of the
  world is ocean and how tall the peaks get.
- `moistureAt()` and `biomeAt()` — climate and the biome thresholds shared by
  the 3D view.
- `terrainColorAt()` — the compact colour ramp used by the 3D mesh.

The 2D cartography stays in `js/terrain.js`: `C`, `LAND_STOPS`, `WATER_STOPS`,
`octavesForWorldPerPixel()` and `renderRegion()` (hill shading, contours,
beaches, snow and grain).

`js/terrain3d-data.js` holds `TERRAIN3D_DEFAULTS` (`size`, `segments`,
`heightScale`) for the mesh; `js/view3d.js` holds the camera limits, fog,
lighting and orbit sensitivity. `js/descent.js` holds the feel of the drop:
`START_ALTITUDE`, `FALL_RATE`, `MAX_SPEED` and `SCALE_PER_METRE` control the
height, duration, drift and how far the camera tightens. `js/app.js` holds
camera limits (`MIN_SCALE`, `MAX_SCALE`), worker count, cache size and the
keyboard bindings.

## Development helpers

```bash
node tools/preview.mjs        # writes /tmp/atlas-{mid,far,close}.png
node tools/test.mjs           # drives the 2D modes, prints stats, checks console errors
node tools/descent-test.mjs   # checks the drop, canopy cam, landing and toggles
node tools/view3d-test.mjs    # checks the mesh, orbit, disposal, seed changes and reload
node tools/screenshot.mjs     # writes /tmp/atlas-shots/*.png
node tools/zoomcheck.mjs      # writes /tmp/atlas-zoom/z*.png
```

The Playwright helpers expect the local Chromium cache used on this machine and
the app running at `http://127.0.0.1:8123/`.

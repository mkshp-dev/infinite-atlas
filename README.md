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

The pre-descent free-roam release is tagged [`v1.0.0`](https://github.com/mkshp-dev/infinite-atlas/releases/tag/v1.0.0).

## Run it

It is plain HTML, CSS and ES modules — no dependencies, no build step. Because
it uses module workers, it needs to be served over HTTP (opening `index.html`
directly will not work):

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

## Controls

### Descent

| Input | Action |
| --- | --- |
| drag / one-finger drag | steer, using a virtual stick around the subject |
| `W` `A` `S` `D` or arrow keys | steer |
| `Shift` | dive faster |
| `V` | toggle third person / canopy cam |
| `M` | switch to atlas |
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
| `R` | new random world |
| `0` | reset to the generated starting view |
| `H` / `C` / `G` | toggle relief / contours / grain |

Type any text in the seed box and press <kbd>Enter</kbd> to jump to that world.
`copy link` puts the seed, mode, view and camera position in the URL hash
(`#seed=…&mode=…&view=…&x=…&y=…&z=…`). In descent, `z` is the scale and is
converted back to altitude when the link is opened, so a shared drop resumes at
the same height.

## How it works

- **Terrain is a pure function.** `elevationAt(x, y, seed)` layers rotated,
  domain-warped value-noise fBm. A contrast stretch and a highland compression
  curve turn the low-contrast noise into continents, lowlands and occasional
  peaks. Moisture is a second, independent field that selects grassland,
  woodland and dry vegetation.
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
  locations. Atlas prefers a coastline; descent prefers a mostly-inland view
  with relief, so the canopy comes down over terrain rather than open ocean.
  The opening zoom is derived from the viewport width, so phones see roughly the
  same slice of world as a desktop.

## Files

```
index.html          markup and panel UI
styles.css          layout, glass panel, map furniture, responsive rules
js/noise.js         hash, value noise, rotated-octave fBm, string hashing
js/terrain.js       elevation/moisture fields, palette, renderRegion, findStart
js/descent.js       parachute flight model and canopy/figure rendering
js/tiles.js         worker pool, tile cache, request/peek/endFrame, eviction
js/tile-worker.js   worker entry point: render one tile to an ImageBitmap
js/app.js           camera, input, descent/atlas modes, render loop, HUD, URL state
tools/preview.mjs   render PNG previews with Node (no browser)
tools/screenshot.mjs  Playwright screenshots of the real app
tools/test.mjs      end-to-end interaction/console-error test
tools/descent-test.mjs  descent, canopy cam, landing and mode-toggle test
tools/zoomcheck.mjs same view rendered at several zoom levels
```

## Customizing

Most of the look lives in `js/terrain.js`:

- `BASE_SCALE` — wavelength of the continent shapes. Larger means bigger,
  rarer landmasses.
- `SEA_LEVEL` and the contrast/compression in `elevationAt()` — how much of the
  world is ocean and how tall the peaks get.
- `C` and the `LAND_STOPS` / `WATER_STOPS` gradients — the palette.
- `octavesForWorldPerPixel()` — detail budget per zoom level.
- `renderRegion()` — hill shading, contours, beaches, snow and grain.

`js/descent.js` holds the feel of the drop: `START_ALTITUDE`, `FALL_RATE`,
`MAX_SPEED` and `SCALE_PER_METRE` control the height, duration, drift and how
far the camera tightens. `js/app.js` holds camera limits (`MIN_SCALE`,
`MAX_SCALE`), worker count, cache size and the keyboard bindings.

## Development helpers

```bash
node tools/preview.mjs        # writes /tmp/atlas-{mid,far,close}.png
node tools/test.mjs           # drives both modes, prints stats, checks console errors
node tools/descent-test.mjs   # checks the drop, canopy cam, landing and toggles
node tools/screenshot.mjs     # writes /tmp/atlas-shots/*.png
node tools/zoomcheck.mjs      # writes /tmp/atlas-zoom/z*.png
```

The Playwright helpers expect the local Chromium cache used on this machine and
the app running at `http://127.0.0.1:8123/`.

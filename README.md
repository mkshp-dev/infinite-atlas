# Infinite Atlas

An endless procedural world map that runs entirely in the browser. There is no
world file and no server: every pixel is a pure function of `(x, y, seed)`, so
you can pan forever in any direction and every view is reproducible and
shareable.

The map is drawn as a slippy-map style tile pyramid. Web Workers paint 256 px
tiles off the main thread, the page keeps an LRU cache of `ImageBitmap`s, and
parent/child tiles stand in during zoom transitions.

## Run it

It is plain HTML, CSS and ES modules — no dependencies, no build step. Because
it uses module workers, it needs to be served over HTTP (opening `index.html`
directly will not work):

```bash
cd procedural
python3 -m http.server 8123
```

Then open <http://127.0.0.1:8123/>.

## Controls

| Input | Action |
| --- | --- |
| drag / one-finger drag | pan |
| scroll / pinch | zoom at the cursor |
| double-click | zoom in |
| `W` `A` `S` `D` or arrow keys | move |
| `+` / `-` | zoom |
| `R` | new random world |
| `0` | reset to the generated starting view |
| `H` / `C` / `G` | toggle relief / contours / grain |

Type any text in the seed box and press <kbd>Enter</kbd> to jump to that world.
`copy link` puts the seed and the exact camera position in the URL hash
(`#seed=…&x=…&y=…&z=…`), so a shared link reopens the same place.

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
- **Start view.** On a fresh seed, `findStart()` samples a spiral of candidate
  locations and picks one with a coastline and some relief, so the first screen
  is interesting rather than open ocean. The opening zoom is derived from the
  viewport width, so phones see roughly the same slice of world as a desktop.

## Files

```
index.html          markup and panel UI
styles.css          layout, glass panel, map furniture, responsive rules
js/noise.js         hash, value noise, rotated-octave fBm, string hashing
js/terrain.js       elevation/moisture fields, palette, renderRegion, findStart
js/tiles.js         worker pool, tile cache, request/peek/endFrame, eviction
js/tile-worker.js   worker entry point: render one tile to an ImageBitmap
js/app.js           camera, input, render loop, HUD, URL state
tools/preview.mjs   render PNG previews with Node (no browser)
tools/screenshot.mjs  Playwright screenshots of the real app
tools/test.mjs      end-to-end interaction/console-error test
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

`js/app.js` holds camera limits (`MIN_SCALE`, `MAX_SCALE`), worker count, cache
size and the keyboard bindings.

## Development helpers

```bash
node tools/preview.mjs        # writes /tmp/atlas-{mid,far,close}.png
node tools/test.mjs           # drives the app, prints stats, checks console errors
node tools/screenshot.mjs     # writes /tmp/atlas-shots/*.png
node tools/zoomcheck.mjs      # writes /tmp/atlas-zoom/z*.png
```

The Playwright helpers expect the local Chromium cache used on this machine and
the app running at `http://127.0.0.1:8123/`.

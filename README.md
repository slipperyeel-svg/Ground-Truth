# Vital Ground — tactical problem generator

Phone web app that sets a tactical problem on the ground where you are standing. See the project brief for the full plan and `DECISIONS.md` for choices made so far.

## Status: Milestone 3 (Template A, feature-aware) built; awaiting product-owner testing

```
npm install
npm run dev              # run locally; open the address it prints
npm run build            # build the installable app into dist/
npm test                 # unit tests (synthetic terrain, no network)
NETWORK=1 npm test       # also loads real AWS elevation tiles for Salisbury Plain
RENDER=1 npm test        # also draws docs/m1-*.png for a visual check
npm run typecheck
```

OS mapping needs an OS Data Hub key in a file called `.env.local` at the top of the project:

```
VITE_OS_KEY=your-key-here
```

Without it the app still works, using OpenStreetMap only.

Indoors, without GPS: add `?demo=ridge` (or `cone`, `valley`, `flat`) to the address. Add `?lat=51.2&lon=-1.85&autoload=1` to load real ground at a chosen spot.

On a phone the app must be served over HTTPS for location to work: use the included GitHub Pages workflow, or drag `dist/` onto Netlify Drop.

## Layout

| Path | What it is |
|---|---|
| `src/terrain/grid.ts` | The elevation grid, coordinates and interpolation |
| `src/terrain/slope.ts` | Slope, aspect, hillshade |
| `src/terrain/tpi.ts` | Topographic position index; landform classes |
| `src/terrain/viewshed.ts` | Viewshed, line of sight, union viewshed, dead ground, exposure |
| `src/terrain/crest.ts` | Topographical and military crests; skylining |
| `src/terrain/classify.ts` | Flat / rolling / ridge / valley |
| `src/terrain/elevation.ts` | AWS Terrarium tile loader; OS Terrain 50 ASCII grid |
| `src/terrain/tiles-browser.ts` | Fetches and decodes tiles in the browser |
| `src/terrain/analyse.ts` | Runs the whole analysis on a box |
| `src/terrain/synthetic.ts` | Test terrains: cone, ridge, rounded ridge, valley, flat, rolling |
| `src/terrain/contours.ts` | Contour lines (marching squares) |
| `src/geo/gridref.ts` | BNG and MGRS grid references |
| `src/geo/gridlines.ts` | 1 km grid lines for the map |
| `src/worker/analysis.worker.ts` | Web Worker: loads ground, answers viewshed requests |
| `src/app/engine.ts` | Page-side handle on the worker |
| `src/app/overlays.ts` | Hillshade, viewshed and contour layers for the map |
| `src/geo/osTiles.ts` | Re-draws OS British National Grid tiles for the map |
| `src/app/basemaps.ts` | OS and OpenStreetMap base maps |
| `src/features/` | OpenStreetMap features (Overpass) and the grid layers made from them |
| `src/tactics/` | Enemy approach and NAI, enemy OPs, Template A, the problem generator |
| `src/main.ts` | The map screen |
| `public/sw.js` | Offline cache |
| `tests/` | Vitest unit tests |

Conventions: x east, y north in metres from the box centre; bearings in degrees from grid north; heights in metres.

## Data attribution

Elevation: Terrain Tiles (Mapzen/Joerd), AWS Open Data. Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers. United Kingdom terrain data © Environment Agency copyright and/or database right 2015. SRTM and GMTED2010 courtesy of the U.S. Geological Survey.

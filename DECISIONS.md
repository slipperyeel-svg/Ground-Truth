# Decisions

Significant technical choices and the reasons for them. Items marked **PO** need the product owner's view, because they affect tactics or teaching.

## M1 – Terrain engine (14 Nov 2026)

### Technical

1. **Local metric grid, true north up.** All analysis runs on a square grid in metres centred on the user (x east, y north, row 0 at the north). Tiles are converted to this grid with a simple local projection. Over a 4 km box this is accurate to centimetres and keeps the maths readable.
2. **Viewshed method.** This is the radial sweep given in the brief. Heights along each ray are interpolated between cells rather than taken from the nearest cell, which avoids "stepping" artefacts on long diagonal rays. The observer sits at the centre of their cell. The point-to-point `lineOfSight` check agrees with the viewshed on over 97% of test cells. The two use slightly different sampling, so they can disagree on cells right at the edge of dead ground.
3. **Earth curvature is off by default.** At 3 km it amounts to under 0.6 m. It can be switched on, with standard refraction (k = 0.13).
4. **TPI uses a square window** computed with a summed-area table, so it costs the same at 150 m and 600 m. A square window is the usual approximation and makes no practical difference to landform classes.
5. **Ground classification ignores the edge of the box** (one TPI radius, 600 m) when looking for ridges and valleys, because TPI is unreliable where its window runs off the data. A feature "crosses the box" if it spans at least 75% of the remaining area. These thresholds are first guesses and need calibrating on real ground in M3.
6. **An isolated hill classes as "rolling", not "ridge".** That follows the brief's rule, which needs a feature that crosses the box. Template A applies to both, so nothing is lost.
7. **Tile fetching is injected** (`TileSource`), so the same loader runs in a browser worker, in Node tests or on a server later.
8. **No new runtime dependencies.** The engine uses only TypeScript. `pngjs` is a dev-only dependency, used to decode PNGs in tests. In the browser, PNGs are decoded by the browser itself. proj4js is not added yet; it will come in M2 for grid references, as the brief allows.

### Data honesty

9. **AWS Terrain Tiles in Britain are mostly EU-DEM, about 30 m.** EU-DEM is a *surface* model (SRTM/ASTER fusion), so dense woods and towns can read as raised ground. Some English areas use Environment Agency data. The metadata says this on every grid, and `sourceResolutionM` is never reported finer than 30 m, even though zoom-13 tile pixels are about 12 m.
10. **Attribution.** The required notices for EU-DEM, the Environment Agency and USGS are included in `TERRAIN_TILES_ATTRIBUTION`. **To do before release:** check the full list against the Joerd attribution page (github.com/tilezen/joerd/blob/master/docs/attribution.md). My workspace could not fetch that page.
11. **Tile URL and CORS are not yet verified from a browser.** My workspace's network blocks the tile server. Other web apps use this URL directly with MapLibre, which suggests CORS is open, but this must be confirmed in M2. A network test is ready: `NETWORK=1 npm test`.
12. **OS Terrain 50:** an ASCII-grid parser and box cutter are in place. The box is aligned to *grid* north, which differs from true north by up to about 3°. Converting a GPS position to BNG for this needs proj4js (M2).

### Tactical choices made provisionally — PO to confirm

13. **PO – Military crest definition.** I used: *the highest point on the forward slope from which a man (eye at 2 m) can see the ground itself, all the way down to the foot of the slope.* The "foot" is where the ground stops falling towards the enemy (bumps under 0.5 m are ignored). Is that the definition you teach?
14. **PO – What counts as a crest.** The ground must fall at least **10 m** towards the enemy in front of it. Smaller folds are not marked as crests. Too high or too low for 30 m data?
15. **PO – Skylining with only a threat direction.** When we know the enemy's direction but not their position, `isSilhouetted` puts a notional enemy observer **1,500 m** away on that bearing. With an actual enemy position, it uses that instead. Is 1,500 m a sensible default?
16. **PO – Default enemy observers (placeholder).** Until Template A chooses them from the ground, the analysis assumes seven enemy observers in a line 300 m in from the enemy edge of the box. This is only scaffolding. In M3 I'd propose picking likely enemy OPs from high ground on the enemy side, and I will ask you how before building it.
17. **Defaults from the brief, kept as is:** observer 2 m; target 2 m (man) or 3 m (vehicle); viewshed range 3,000 m; flat below 20 m relief.

## M2 – Map view (14 Nov 2026)

18. **Dependencies added:** `maplibre-gl` (map) and `proj4` (grid references). Both are named in the brief. No others were added.
19. **Grid references.** In Great Britain these are BNG, and elsewhere MGRS. Figures are *truncated*, not rounded, as when reading a map. WGS84 → OSGB36 uses proj4's standard 7-parameter shift, which is good to about 5 m. That is fine for six-figure references, but an eight-figure reference can be one square out near a square edge. The precise OSTN15 transformation needs a 15 MB grid file and can come later if it matters. The test for "is this Great Britain?" is a simple box with Ireland cut out. It is approximate around the Irish Sea, and it only decides which grid system to show.
20. **MGRS is computed in our own code** (UTM from proj4, then the standard letter scheme) rather than added as another library. It is tested against the published Washington Monument example.
21. **Contour interval.** Contours are every 5 m when relief is under 40 m and every 10 m otherwise, with every fifth line bold. They are drawn from the 30 m data, so treat them as a guide to the shape of the ground and not as OS-accurate contours.
22. **Base map.** This uses the OpenStreetMap standard tiles, which are fine for development and light personal use. **Before wider release**, we need a tile provider whose terms allow an app (e.g. OpenFreeMap or a paid provider), or our own tiles. Map labels use OpenFreeMap's fonts.
23. **MapLibre's worker file is bundled explicitly.** Without this the built app draws a blank map. I found this in the headless browser test.
24. **Offline.** A service worker caches the app itself. It also keeps every elevation tile, map tile and font it fetches, so ground you have loaded is usable without signal afterwards. Nothing is downloaded in bulk ahead of time; OSM's terms forbid that for their tiles.
25. **Demo mode** (`?demo=ridge|cone|valley|flat`) uses invented ground so the app can be tried indoors. Every screen is clearly labelled "DEMO … not the real ground".
26. **Hosting.** Phones only allow location access on HTTPS sites, so the app must be hosted to be tried on a phone. A GitHub Pages workflow is included. A quicker option is to drag the built `dist` folder onto Netlify Drop.

## Base maps (14 Nov 2026)

27. **OS mapping in Great Britain, OpenStreetMap elsewhere.** The default is chosen from where the ground is loaded, and a "Map" selector overrides it. The options are OS Explorer 1:25,000, OS Outdoor, OpenStreetMap and None.
28. **OS 1:25,000 is re-drawn in the app.** OS only publishes the 1:25,000 "Leisure" style in British National Grid tiles, and MapLibre only draws Web Mercator. So the app fetches the BNG tiles and warps them, pixel by pixel, into the tiles the map asks for (`src/geo/osTiles.ts`, tested against synthetic tiles to within 10 m). The map appears very slightly rotated where grid north differs from true north (up to about 3°), which is correct. Switching the whole app to OpenLayers, which handles BNG natively, was the alternative; it would have meant rewriting the map screen.
29. **OS Explorer stops at BNG zoom 9 (1.75 m/px)** and is enlarged beyond that. OS Outdoor stops at Web Mercator zoom 16. Above that OS serves premium MasterMap, which would eat the free allowance.
30. **The OS key is kept out of the source code**, in `.env.local` (not tracked by git). It is necessarily visible inside the built app, as with any browser map key.
31. **To check (PO / OS terms):** (a) whether OS's free premium allowance permits our use; (b) whether OS tiles may be cached for offline use — until confirmed, the service worker does **not** cache OS tiles, so OS mapping needs signal; (c) whether OS requires its logo on the map, in addition to the "Contains OS data © Crown copyright" attribution already shown.
32. **Not tested against the live OS service.** My workspace cannot reach api.os.uk, so the first real test of OS tiles is on your device.

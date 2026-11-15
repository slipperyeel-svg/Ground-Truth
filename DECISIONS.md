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

## PO decisions before M3 (14 Nov 2026)

The PO answered the questions blocking M3, and widened the aim: the engine should read the *features* of the ground (roads, woods, water, buildings) as well as its shape, and set the problem on them.

33. **Military crest (item 13): confirmed** as defined above.
34. **Smallest crest (item 14): confirmed** at 10 m for 30 m data.
35. **Enemy approach and NAI (CLAUDE.md §7.6): best mobility corridor.** The engine finds the most likely approach from the enemy side using roads, tracks and open, gently sloping ground, avoiding woods, water, buildings and steep ground. The NAI goes where that approach is channelled (a defile, bridge, or gap between woods or obstacles). This replaces the brief's "side with the lowest ground" rule.
36. **Likely enemy OPs (item 16, CLAUDE.md §7.4): best viewpoints.** The 5–7 points on the enemy side that see most of the friendly area, spaced at least 300 m apart, preferring wood edges, buildings and crests where a real OP would hide. Replaces the placeholder line.
37. **Skylining default (item 15)** not yet discussed; 1,500 m stays as the default.
38. **Feature data source:** OpenStreetMap via the Overpass API (`overpass-api.de`), as named in the brief. Fetched with plain `fetch`; no new dependency.

## M3 – Feature-aware problem engine and Template A (14 Nov 2026)

The engine now reads the features of the ground as well as its shape, finds the enemy's approach, NAI and likely OPs, and sets Template A with its quality gate. Code: `src/features/` (OSM features → grid layers), `src/tactics/` (approach, enemy OPs, Template A, problem generator and wording).

### Technical

39. **Features are drawn onto the analysis grid** as layers: land cover (open, wood, scrub, water, wetland, built-up, building), best road or path, rivers, streams, railways, hedges, walls, cliffs, crossings (a road or track over water), going, stand exclusions and stand-allowed cells. Areas are filled by cell centre (scanline, even–odd rule, so holes in woods work); lines are drawn with a half-width per kind.
40. **Enemy approach = least-cost path** (Dijkstra, 8-connected) over the going layer from the enemy edge of the box to the friendly edge. The *corridor* is every cell on a route no more than 10% dearer than the best. The NAI goes where the corridor is narrowest, between 25% and 65% of the way along the route and at least 400 m from the side edges; it is a 250 m-radius circle of corridor cells.
41. **Open ground ties.** On open ground many routes cost the same and the cheapest one hugs the edge of the box. Going is therefore raised gently towards the side edges (up to 15%, plus up to 50% in the last 600 m). Real obstacles cost far more, so they still decide the route.
42. **"What channels the enemy"** is read from just outside the corridor at the NAI: woods, water, marsh, buildings, the railway, or ground steeper than 12°. With no features loaded, only steep ground can be named. If nothing is found the NAI is reported as "on open ground" and such problems rank below channelled ones.
43. **Speed.** Viewsheds over many points run on a 30 m copy of the grid, the true resolution of the data, so no real detail is lost. The NAI visibility uses the fact that line of sight is symmetrical when eye and target are both 2 m: one pass from points in the NAI scores every possible OP position at once. Times on this workspace's CPU: about 0.2 s for the approach, 0.5–0.8 s for enemy OPs and 0.8 s for Template A, per enemy direction; about 3.5 s for all four directions in the browser, plus the time to fetch features. **Untested on a phone.**
44. **Overpass is unreachable from the cloud workspace.** `overpass-api.de` is on the allowed list but drops every connection after about 2 s (probably refusing cloud-server traffic). The phone fetches features directly, so this only affects testing here. The feature code is unit-tested on hand-made features; it has **not yet been run on real OSM data**.
45. **`?unchecked=1` (testing only)** lets a problem through when features could not be loaded; the problem then says plainly that public access has not been checked. Without it the gate always fails when access cannot be checked (core principle 4).

### Tactical choices made provisionally — PO to confirm

46. **PO – Going weights** (`GOING` in `src/features/layers.ts`), relative to open, level ground = 1: wood 6, scrub 2, marsh 10, built-up 3, water and buildings impassable; roads 0.25–0.4, tracks 0.6; stream ×3, hedge ×1.5, wall ×2.5, railway ×8; slopes over 6° cost up to 4×, over 20° impassable to vehicles; rivers impassable except at a road or track crossing. These assume a mechanised enemy.
47. **PO – Enemy OP stand-off:** enemy OPs must be at least **500 m** in front of the box's centre line, not on top of our forward positions. Up to 6, at least 300 m apart; a position within 60 m of woods, scrub or buildings scores 15% higher.
48. **PO – Template A thresholds** (`TEMPLATE_A` in `src/tactics/templateA.ts`): OPs in the forward 1.6 km of our half; an OP must see at least 30% of the NAI to count; gun areas at least 500 m behind the centre line, under 6°, out of view of every enemy OP for a 3 m vehicle, on open ground or scrub, at least **4 ha** in one piece; a line of communication is "long and exposed" above 1 km and 40% in view.
49. **PO – Is "less exposed" enough of a difference?** The brief's dilemma test only needs the alternative OP to be seen by *fewer* enemy OPs. In testing this sometimes gave weak choices (seen by 5 of 6 versus 4 of 6).
50. **PO – Problem wording** (`src/tactics/problem.ts`): the user is the Battery Commander of a close support battery; enemy armour; time allowed 30 minutes. A first draft for review.
51. **Ranking between enemy directions** when more than one passes: a channelled NAI first, then the number of dilemmas, then the difference in exposure between the two OPs, then the share of the route on roads.

## Features display (14 Nov 2026)

52. **PO: excluded areas are not a concern.** "I trust users not to be stupid in that regard." The features display therefore shows only the features themselves (woods, scrub, water, marsh, built-up areas, buildings, roads, tracks, paths, rivers and streams, hedges, railways), not exclusions or where a stand may go. The quality gate's public-access check (DECISIONS.md 45, CLAUDE.md principle 4) is left in the code for now, since problems are paused; **revisit it with the PO before problems resume.**
53. **"Show features"** fetches the OSM features for the loaded box once (shared with "Set a problem") and draws the engine's own grid layers as a see-through picture, so what you see is exactly what the engine will use. Lines are drawn at their analysis width (e.g. a minor road 10 m wide), so they look thin when zoomed out.
54. **OSM completeness varies.** Hedges, walls and small paths are often unmapped in OSM, especially in farmland; woods and roads are usually good. Anything missing in OSM is missing to the engine.
55. **Features confirmed on real data.** The PO loaded the Larkhill–Amesbury box (about SU 12–16, 41–45) on his own device and the captured features looked right to him. This was the first run on real OSM data, and confirms Overpass is reachable from a browser (CORS works).

## Moving to OS open mapping (14 Nov 2026)

56. **PO: OS premium data is not sustainable for a public app** (every user's requests would count against one account). The OS 1:25,000 Explorer map is premium too.
57. **PO decision: features from OS open data where it has them** (woods, water, rivers, buildings, built-up areas, roads, railways), fetched on demand through the **OS Vector Tile API** with the existing key. **OpenStreetMap stays for paths, tracks and hedges**, which OS open data does not contain.
58. **PO decision: the default base map becomes the free OS open map** (Vector Tile API). Explorer 1:25,000 stays available in the Map menu.
59. **Blocked on the PO:** the Vector Tile API must be added to the OS Data Hub project (the key currently gets 401 "Invalid ApiKey for given resource"), and we must confirm it is on the free OpenData plan. Downloading and self-hosting OS Open Zoomstack or OpenMap Local was rejected: the GB-wide files are gigabytes, too big for GitHub Pages.
60. **No new dependency:** vector tiles (Mapbox Vector Tile protobuf) are decoded by a small reader in our own code (`src/features/mvt.ts`).
61. **OS Vector Tile API checked (14 Nov 2026).** Tiles exist up to zoom 15 (512-px tiles); every tile up to 15 holds only OS open data (Open Zoomstack: woodland, surface water, waterlines, roads, railways, buildings, names). The premium MasterMap "Topographic" layers do not appear at those zooms. The app therefore never requests anything above zoom 15: the feature fetch uses zoom 14, and the base map's tile source is capped at 15 and enlarged beyond. The PO should confirm on the OS Data Hub dashboard that premium usage stays at zero.
62. **Translating OS tiles.** Features carry only a style number (`_symbol`); the meaning comes from OS's own style (`osKind` in `src/features/osVector.ts`): motorway 0–2; primary, A and B roads 3–9 → main road; minor and local 10–14 → minor road; restricted-access 15–16 → track; busways and tunnels ignored; railways 0–2 (3 = tunnel); local woodland; local surface water; local waterlines → stream (tide lines ignored); local buildings. OS open data has no built-up-area polygons at these zooms and no scrub, marsh or hedges.
63. **Sources combined.** In Great Britain with a key: OS open data for woods, water, buildings, roads and railways, plus OpenStreetMap for paths, tracks, hedges and walls (a lighter Overpass query). If OS fails, everything falls back to OpenStreetMap; elsewhere in the world, OpenStreetMap only. The features note says which source supplied what.
64. **OS open base map.** Built from OS's own style (fetched at start-up) on our own tile source capped at zoom 15. MasterMap layers are dropped, and OS's "hide beyond zoom 16" limits are removed so the open layers stay visible when zoomed in. With an OS key the app's labels use OS's fonts (Source Sans Pro), because a map has one font server. It is the default in Great Britain; Explorer 1:25,000 (premium) stays in the Map menu.
65. **Watercourses along the A303** west of Countess roundabout (around SU 132–139 419–420) come from OS waterlines; possibly roadside drains. **PO: they are drains/ditches, and treating them as minor obstacles (going ×3, as for streams) is fine.** No change.

## Woods, buildings and hedges block sight (14 Nov 2026)

66. **PO heights:** woods 15 m, buildings 8 m, hedges 2 m. **You can see 15 m into a wood** from its edge along a sight line, and no further; from inside a wood you see about 15 m and nothing beyond the trees.
67. **No double counting.** The default elevation is a surface model, so large woods may already be raised in the data. The top of a wood is set at 15 m above the ground level at its edge (spread inwards from the nearest open ground), or at the data's own height if that is higher. Buildings and hedges are too small to show in 30 m data, so their full height is added.
68. **Viewshed and line of sight agree.** Both use the same rules (`Obstacles` in `src/terrain/viewshed.ts`, built in `src/features/obstacles.ts`); exposure checks use them too. The viewshed screen has a tick box (on by default) to compare with bare ground; features are fetched automatically the first time.
69. **Not yet applied to the problem engine** (enemy OPs, Template A), since problems are paused. Pass `obstacles` in their view options when problems resume.
70. **First real test (Larkhill, SU 1433 4300, 14 Nov 2026):** with obstacles the observer sees 9% of the ground within 3 km instead of 18% on bare ground, because OS shows a wood 140 m to the north. Hedges from OSM could not be tested from the cloud workspace.

## Map interaction and point selection (15 Nov 2026)

71. **Standard map gestures, all kept** (MapLibre defaults): pinch or spread to zoom, double-tap to zoom in, two-finger tap to zoom out, double-tap-and-drag for quick zoom, one-finger drag to move, two-finger twist to rotate; scroll wheel, double-click and shift-drag box zoom on a computer.
72. **A single tap no longer runs a viewshed.** It selects a point instead: a marker, its 8-figure grid reference, its height (inside the loaded box), and, if your position is known, distance and grid bearing from you in mils (6,400) and degrees. "Viewshed from here" and "Clear" act on it. Grid bearing and distance use BNG in Great Britain, UTM elsewhere.
73. **Double tap must not select.** On touchscreens the map reports only the first tap of a double tap, so a tap is held for 300 ms and dropped if the map starts zooming in that time.
74. **Crosshair (⌖ button under the zoom buttons)** for precise selection with a finger: a fixed mark at the map centre; move the map under it and press "Select crosshair point".

/**
 * M2 map screen: load the ground around you (or the map centre), show
 * hillshade, contours and the grid, and draw a viewshed from any tapped point.
 *
 * Testing indoors: add ?demo=ridge (or cone, valley, flat) to the address to
 * use invented ground; ?lat=..&lon=.. to choose where; &autoload=1 to load
 * straight away; &vs=x,y to draw a viewshed from local metres x,y.
 * &unchecked=1 (testing only) allows problems where public access could not
 * be checked because map features failed to load; the problem says so.
 */
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, ImageSource, MapMouseEvent, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre's own background worker must be shipped as a separate file and
// pointed to explicitly, or the map draws nothing once built.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './style.css';
import { Engine } from './app/engine';
import {
  boxCorners,
  boxOutlineGeoJSON,
  contoursGeoJSON,
  dsGeoJSON,
  EMPTY,
  hillshadeImage,
  pointGeoJSON,
  problemGeoJSON,
  toDataURL,
  viewshedImage,
  type BoxGeo,
} from './app/overlays';
import { gridRef, inGreatBritain } from './geo/gridref';
import { BASE_MAPS, baseMapSources, OS_KEY, registerOsProtocol, type BaseMapId } from './app/basemaps';
import { gridLines } from './geo/gridlines';
import { latLonToLocal, localToLatLon } from './terrain/elevation';
import type { DemoTerrain, LoadedGround, ProblemView } from './worker/protocol';

// ---------- state ----------
const params = new URLSearchParams(location.search);
const demo = (params.get('demo') as DemoTerrain | null) ?? undefined;
const engine = new Engine();
let ground: LoadedGround | null = null;
let box: BoxGeo | null = null;
let myFix: { lat: number; lon: number; accuracy: number } | null = null;
let lastObserver: { x: number; y: number } | null = null;
let watchId: number | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (msg: string) => ($('status').textContent = msg);
/** A genuinely transparent 1×1 image, used to clear an overlay. */
const BLANK = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  return c.toDataURL('image/png');
})();
const PLACEHOLDER: [[number, number], [number, number], [number, number], [number, number]] = [
  [-1.86, 51.21], [-1.84, 51.21], [-1.84, 51.19], [-1.86, 51.19],
];

// ---------- map ----------
maplibregl.setWorkerUrl(maplibreWorkerUrl);
registerOsProtocol();
const baseSources = baseMapSources();
const style: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: baseSources,
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f6f3ea' } },
    ...Object.keys(baseSources).map((id) => ({
      id: `base-${id}`,
      type: 'raster' as const,
      source: id,
      layout: { visibility: 'none' as const },
      paint: id === 'osm' ? { 'raster-opacity': 0.8, 'raster-saturation': -0.3 } : { 'raster-opacity': 0.9 },
    })),
  ],
};

const startLat = Number(params.get('lat') ?? 51.2);
const startLon = Number(params.get('lon') ?? -1.85);
const map = new maplibregl.Map({
  container: 'map',
  style,
  center: [startLon, startLat],
  zoom: params.has('lat') ? 13 : 6,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

// ---------- base map ----------
const baseSelect = $('sel-base') as HTMLSelectElement;
for (const b of BASE_MAPS) {
  if (b.id !== 'osm' && !OS_KEY) continue; // OS maps need a key
  baseSelect.add(new Option(b.label, b.id));
}
baseSelect.add(new Option('None (terrain layers only)', 'none'));
let baseChosenByUser = false;

function setBaseMap(id: BaseMapId | 'none') {
  for (const src of Object.keys(baseSources)) {
    if (map.getLayer(`base-${src}`)) map.setLayoutProperty(`base-${src}`, 'visibility', src === id ? 'visible' : 'none');
  }
  baseSelect.value = id;
}

/** OS Explorer in Great Britain (if we have a key), OpenStreetMap elsewhere. */
function defaultBaseFor(lat: number, lon: number): BaseMapId {
  return OS_KEY && inGreatBritain(lat, lon) ? 'os-explorer' : 'osm';
}

baseSelect.addEventListener('change', () => {
  baseChosenByUser = true;
  setBaseMap(baseSelect.value as BaseMapId | 'none');
});

map.on('load', () => {
  setBaseMap(defaultBaseFor(startLat, startLon));
  // Keep the attribution as a small (i) button so it does not cover the map.
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  map.addSource('hillshade', { type: 'image', url: BLANK, coordinates: PLACEHOLDER });
  map.addSource('viewshed', { type: 'image', url: BLANK, coordinates: PLACEHOLDER });
  map.addSource('features', { type: 'image', url: BLANK, coordinates: PLACEHOLDER });
  map.addSource('contours', {
    type: 'geojson',
    data: EMPTY,
    attribution: 'Elevation: Terrain Tiles (Mapzen/AWS); EU-DEM © Copernicus/EU; © Environment Agency; USGS',
  });
  map.addSource('grid', { type: 'geojson', data: EMPTY });
  map.addSource('box', { type: 'geojson', data: EMPTY });
  map.addSource('me', { type: 'geojson', data: EMPTY });
  map.addSource('tap', { type: 'geojson', data: EMPTY });
  map.addSource('problem', { type: 'geojson', data: EMPTY });
  map.addSource('ds', { type: 'geojson', data: EMPTY });

  map.addLayer({ id: 'hillshade', type: 'raster', source: 'hillshade', paint: { 'raster-fade-duration': 0 } });
  map.addLayer({ id: 'features', type: 'raster', source: 'features', paint: { 'raster-fade-duration': 0 } });
  map.addLayer({ id: 'viewshed', type: 'raster', source: 'viewshed', paint: { 'raster-fade-duration': 0 } });
  map.addLayer({
    id: 'contours',
    type: 'line',
    source: 'contours',
    paint: {
      'line-color': '#b5651d',
      'line-width': ['case', ['get', 'index'], 1.6, 0.7],
      'line-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'contour-labels',
    type: 'symbol',
    source: 'contours',
    filter: ['==', ['get', 'index'], true],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 11,
      'symbol-spacing': 400,
    },
    paint: { 'text-color': '#8a4a12', 'text-halo-color': '#f6f3ea', 'text-halo-width': 1.5 },
  });
  map.addLayer({ id: 'grid', type: 'line', source: 'grid', paint: { 'line-color': '#1f5fa8', 'line-width': 0.9, 'line-opacity': 0.7 } });
  map.addLayer({
    id: 'grid-labels',
    type: 'symbol',
    source: 'grid',
    layout: {
      'symbol-placement': 'line',
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
      'symbol-spacing': 250,
    },
    paint: { 'text-color': '#1f5fa8', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 },
  });
  map.addLayer({ id: 'box', type: 'line', source: 'box', paint: { 'line-color': '#2f3a2a', 'line-width': 2, 'line-dasharray': [3, 2] } });
  map.addLayer({
    id: 'nai-fill', type: 'fill', source: 'problem', filter: ['==', ['get', 'kind'], 'nai'],
    paint: { 'fill-color': '#e67800', 'fill-opacity': 0.35 },
  });
  map.addLayer({
    id: 'nai-line', type: 'line', source: 'problem', filter: ['==', ['get', 'kind'], 'nai'],
    paint: { 'line-color': '#b35c00', 'line-width': 2.5 },
  });
  map.addLayer({
    id: 'enemy-route', type: 'line', source: 'problem', filter: ['==', ['get', 'kind'], 'route'],
    paint: { 'line-color': '#c00', 'line-width': 2.5, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'nai-label', type: 'symbol', source: 'problem', filter: ['==', ['get', 'kind'], 'nai'],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 14 },
    paint: { 'text-color': '#7a3d00', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  map.addLayer({
    id: 'ds-loc', type: 'line', source: 'ds', filter: ['==', ['get', 'kind'], 'loc'],
    paint: { 'line-color': '#2e7d32', 'line-width': 2, 'line-dasharray': [1, 1.5] },
  });
  map.addLayer({
    id: 'ds-points', type: 'circle', source: 'ds', filter: ['!=', ['get', 'kind'], 'loc'],
    paint: {
      'circle-radius': 7,
      'circle-color': ['match', ['get', 'kind'], 'enemy', '#c00', 'own', '#1a73e8', 'guns', '#2e7d32', '#888'],
      'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'ds-labels', type: 'symbol', source: 'ds', filter: ['!=', ['get', 'kind'], 'loc'],
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
    paint: { 'text-color': '#1d2118', 'text-halo-color': '#fff', 'text-halo-width': 2 },
  });
  map.addLayer({
    id: 'me',
    type: 'circle',
    source: 'me',
    paint: { 'circle-radius': 8, 'circle-color': '#1a73e8', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 },
  });
  map.addLayer({
    id: 'tap',
    type: 'circle',
    source: 'tap',
    paint: { 'circle-radius': 7, 'circle-color': '#ffd400', 'circle-stroke-color': '#000', 'circle-stroke-width': 2 },
  });

  if (params.get('autoload') === '1' || demo) void loadGround(startLat, startLon);
});

// ---------- position ----------
function showPosition() {
  if (!myFix) return;
  const six = gridRef(myFix.lat, myFix.lon, 3);
  const eight = gridRef(myFix.lat, myFix.lon, 4);
  $('pos-ref').textContent = six.ref;
  let detail = `${eight.system} ${eight.ref} · ±${Math.round(myFix.accuracy)} m`;
  if (box) {
    const p = latLonToLocal(box.centre, myFix.lat, myFix.lon);
    const out = Math.abs(p.x) > box.halfM || Math.abs(p.y) > box.halfM;
    if (out) detail += ' · outside the loaded box';
  }
  $('pos-detail').textContent = detail;
  (map.getSource('me') as GeoJSONSource | undefined)?.setData(pointGeoJSON(myFix.lon, myFix.lat));
}

function startWatching(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('This device cannot report its position'));
    if (watchId !== null && myFix) return resolve();
    let first = true;
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        myFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy };
        showPosition();
        if (first) {
          first = false;
          resolve();
        }
      },
      (err) => {
        if (first) reject(new Error(err.code === 1 ? 'Location permission refused' : `Location unavailable: ${err.message}`));
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
  });
}

// ---------- loading ground ----------
function setBusy(busy: boolean) {
  for (const id of ['btn-here', 'btn-centre', 'btn-vs-me', 'btn-problem', 'btn-features']) ($(id) as HTMLButtonElement).disabled = busy;
}

async function loadGround(lat: number, lon: number) {
  setBusy(true);
  status(demo ? 'Building demo ground…' : 'Fetching elevation data…');
  try {
    ground = await engine.load(lat, lon, { demo }, status);
    box = { centre: { lat, lon }, halfM: (ground.width * ground.cellM) / 2 };
    if (!baseChosenByUser) setBaseMap(defaultBaseFor(lat, lon));
    const corners = boxCorners(box);

    (map.getSource('hillshade') as ImageSource).updateImage({
      url: hillshadeImage(ground.width, ground.height, ground.hillshade),
      coordinates: corners,
    });
    (map.getSource('viewshed') as ImageSource).updateImage({ url: BLANK, coordinates: corners });
    (map.getSource('contours') as GeoJSONSource).setData(contoursGeoJSON(ground.contours, box.centre));
    (map.getSource('box') as GeoJSONSource).setData(boxOutlineGeoJSON(box));
    const lons = corners.map((c) => c[0]);
    const lats = corners.map((c) => c[1]);
    const bounds = { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) };
    (map.getSource('grid') as GeoJSONSource).setData(gridLines(bounds) as never);
    (map.getSource('tap') as GeoJSONSource).setData(EMPTY);
    lastObserver = null;
    $('vs-info').textContent = '';
    map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 16, animate: false });

    const g = ground.ground;
    $('ground-class').textContent = g.ground;
    $('ground-detail').textContent =
      `${g.reasons.join(' ')} Heights ${Math.round(ground.minM)}–${Math.round(ground.maxM)} m; contours every ${ground.contourIntervalM} m.`;
    const m = ground.meta;
    $('data-source').textContent =
      `Source: ${m.source}. Data resolution about ${Math.round(m.sourceResolutionM)} m. ${m.notes.join(' ')}`;
    $('ground-info').hidden = false;
    $('vs-block').hidden = false;
    clearProblem();
    clearFeatures();
    $('problem-block').hidden = false;
    status(`Ground loaded · ${gridRef(lat, lon).ref}`);
    showPosition();

    const vs = params.get('vs');
    if (vs) {
      const [x, y] = vs.split(',').map(Number);
      await runViewshed(x, y);
    }
  } catch (err) {
    status(`Could not load ground: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

// ---------- map features ----------
let featuresShown = false;

function clearFeatures() {
  featuresShown = false;
  if (box) (map.getSource('features') as ImageSource | undefined)?.updateImage({ url: BLANK, coordinates: boxCorners(box) });
  $('feat-legend').hidden = true;
  $('feat-note').textContent = '';
  ($('btn-features') as HTMLButtonElement).textContent = 'Show features';
}

async function toggleFeatures() {
  if (!box || !ground) return;
  if (featuresShown) {
    clearFeatures();
    return;
  }
  setBusy(true);
  try {
    const f = await engine.features(status);
    $('feat-note').textContent = f.note;
    if (!f.ok || !f.image) {
      status('Map features not available');
      return;
    }
    (map.getSource('features') as ImageSource).updateImage({
      url: toDataURL(ground.width, ground.height, f.image),
      coordinates: boxCorners(box),
    });
    featuresShown = true;
    $('feat-legend').hidden = false;
    ($('btn-features') as HTMLButtonElement).textContent = 'Hide features';
    status('Features shown');
  } catch (err) {
    status(`Could not load features: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

$('btn-features').addEventListener('click', () => void toggleFeatures());

// ---------- tactical problem ----------
let problem: ProblemView | null = null;

function clearProblem() {
  problem = null;
  $('problem').hidden = true;
  $('pr-ds').hidden = true;
  $('btn-ds').hidden = true;
  $('pr-log').hidden = true;
  $('pr-features').textContent = '';
  (map.getSource('problem') as GeoJSONSource | undefined)?.setData(EMPTY);
  (map.getSource('ds') as GeoJSONSource | undefined)?.setData(EMPTY);
}

function fillList(id: string, items: string[]) {
  const el = $(id);
  el.replaceChildren(...items.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
}

async function setProblem() {
  if (!box) return;
  clearProblem();
  setBusy(true);
  status('Reading the ground…');
  try {
    problem = await engine.problem(status, params.get('unchecked') === '1');
    $('pr-features').textContent = problem.featureNote;
    fillList('pr-log-list', problem.log);
    $('pr-log').hidden = false;
    if (!problem.found || !problem.text) {
      status('No good problem on this ground');
      $('pr-features').textContent =
        `${problem.featureNote} This ground offers no problem with a real dilemma that passes the quality gate. ` +
        'Try loading ground a little way off. See below for why.';
      return;
    }
    const t = problem.text;
    $('pr-title').textContent = t.title;
    $('pr-gs').textContent = t.generalSituation;
    $('pr-ss').textContent = t.specialSituation;
    fillList('pr-req', t.requirement);
    $('pr-time').textContent = t.timeAllowed;
    fillList('pr-ds-list', t.dsNotes);
    $('pr-data').textContent = t.dataNote;
    $('problem').hidden = false;
    $('btn-ds').hidden = false;
    ($('btn-ds') as HTMLButtonElement).textContent = 'Show DS solution';
    (map.getSource('problem') as GeoJSONSource).setData(problemGeoJSON(box.centre, problem.nai!, problem.route ?? []) as never);
    status(`Problem set (${(problem.timeMs / 1000).toFixed(1)} s)`);
  } catch (err) {
    status(`Could not set a problem: ${(err as Error).message}`);
  } finally {
    setBusy(false);
  }
}

$('btn-problem').addEventListener('click', () => void setProblem());
$('btn-ds').addEventListener('click', () => {
  if (!problem?.ds || !box) return;
  const showing = !$('pr-ds').hidden;
  $('pr-ds').hidden = showing;
  (map.getSource('ds') as GeoJSONSource).setData(showing ? EMPTY : (dsGeoJSON(box.centre, problem.ds) as never));
  ($('btn-ds') as HTMLButtonElement).textContent = showing ? 'Show DS solution' : 'Hide DS solution';
});

// ---------- viewshed ----------
async function runViewshed(x: number, y: number) {
  if (!ground || !box) return;
  const obsH = Number(($('sel-obs') as HTMLSelectElement).value);
  const tgtH = Number(($('sel-target') as HTMLSelectElement).value);
  const range = Number(($('sel-range') as HTMLSelectElement).value);
  lastObserver = { x, y };
  const ll = localToLatLon(box.centre, x, y);
  (map.getSource('tap') as GeoJSONSource).setData(pointGeoJSON(ll.lon, ll.lat));
  status('Computing viewshed…');
  try {
    const r = await engine.viewshed(x, y, obsH, tgtH, range);
    (map.getSource('viewshed') as ImageSource).updateImage({
      url: viewshedImage(ground.width, ground.height, ground.cellM, r.mask, { x, y }, range),
      coordinates: boxCorners(box),
    });
    const ref = gridRef(ll.lat, ll.lon, 4);
    $('vs-info').textContent =
      `From ${ref.ref} (ground ${Math.round(r.observerGroundM)} m): observer ${obsH} m, target ${tgtH} m. ` +
      `Sees ${Math.round(r.visibleShare * 100)}% of the ground within ${range.toLocaleString('en-GB')} m. (${r.timeMs} ms)`;
    status('Viewshed shown');
  } catch (err) {
    status(`Viewshed failed: ${(err as Error).message}`);
  }
}

map.on('click', (e: MapMouseEvent) => {
  if (!box) return;
  const p = latLonToLocal(box.centre, e.lngLat.lat, e.lngLat.lng);
  if (Math.abs(p.x) > box.halfM || Math.abs(p.y) > box.halfM) {
    status('Tap inside the loaded box (dashed line)');
    return;
  }
  void runViewshed(p.x, p.y);
});

// ---------- buttons ----------
$('btn-here').addEventListener('click', async () => {
  status('Finding your position…');
  try {
    await startWatching();
    if (myFix) await loadGround(myFix.lat, myFix.lon);
  } catch (err) {
    status((err as Error).message);
  }
});

$('btn-centre').addEventListener('click', () => {
  const c = map.getCenter();
  void loadGround(c.lat, c.lng);
});

$('btn-vs-me').addEventListener('click', async () => {
  if (!box) return;
  try {
    await startWatching();
  } catch (err) {
    status((err as Error).message);
    return;
  }
  if (!myFix) return;
  const p = latLonToLocal(box.centre, myFix.lat, myFix.lon);
  if (Math.abs(p.x) > box.halfM || Math.abs(p.y) > box.halfM) {
    status('You are outside the loaded box');
    return;
  }
  void runViewshed(p.x, p.y);
});

$('btn-vs-clear').addEventListener('click', () => {
  if (!box) return;
  (map.getSource('viewshed') as ImageSource).updateImage({ url: BLANK, coordinates: boxCorners(box) });
  (map.getSource('tap') as GeoJSONSource).setData(EMPTY);
  lastObserver = null;
  $('vs-info').textContent = '';
});

for (const id of ['sel-obs', 'sel-target', 'sel-range']) {
  $(id).addEventListener('change', () => {
    if (lastObserver) void runViewshed(lastObserver.x, lastObserver.y);
  });
}

const toggles: Record<string, string[]> = {
  'tg-hillshade': ['hillshade'],
  'tg-contours': ['contours', 'contour-labels'],
  'tg-grid': ['grid', 'grid-labels'],
};
for (const [id, layers] of Object.entries(toggles)) {
  $(id).addEventListener('change', (e) => {
    const vis = (e.target as HTMLInputElement).checked ? 'visible' : 'none';
    for (const l of layers) if (map.getLayer(l)) map.setLayoutProperty(l, 'visibility', vis);
  });
}

// If location permission was already granted, show position straight away.
navigator.permissions
  ?.query({ name: 'geolocation' as PermissionName })
  .then((p) => {
    if (p.state === 'granted') void startWatching().catch(() => undefined);
  })
  .catch(() => undefined);

// ---------- offline support ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').catch(() => undefined);
}

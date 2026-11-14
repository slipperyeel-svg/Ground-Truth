/**
 * Web Worker: loads elevation and runs the analysis off the main thread so
 * the map stays responsive. The loaded ground is kept here, so later
 * requests (e.g. a viewshed from a tapped point) need no new download.
 */
import {
  classifyGround,
  countMask,
  elevationAtPoint,
  hillshade,
  inRangeMask,
  loadElevation,
  viewshed,
  type Grid,
} from '../terrain';
import { contours, chooseInterval } from '../terrain/contours';
import { coneHill, convexRidge, flatPlane, fromFunction, vValley } from '../terrain/synthetic';
import { browserTileSource } from '../terrain/tiles-browser';
import type { DemoTerrain, FeaturesView, ProblemView, WorkerRequest, WorkerResponse } from './protocol';
import { featureImage } from '../features/render';
import { fetchFeatures } from '../features/osm';
import { buildLayers, type FeatureLayers } from '../features/layers';
import { generateProblem } from '../tactics/problem';
import { fetchCombinedFeatures } from '../features/osVector';
import { buildObstacles, type Obstacles } from '../features/obstacles';
import { inGreatBritain } from '../geo/gridref';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let grid: Grid | null = null;
let isDemo = false;
/** Map features for the loaded ground: fetched once, on the first problem request. */
let layers: FeatureLayers | null = null;
let obstacles: Obstacles | null = null;
let featureNote = '';

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);

function demoGrid(kind: DemoTerrain, sizeM: number, cellM: number, lat: number, lon: number): Grid {
  let g: Grid;
  switch (kind) {
    case 'cone':
      g = coneHill(sizeM, cellM, { radiusM: 900, peak: 70 });
      break;
    case 'valley':
      g = vValley(sizeM, cellM, { gradient: 0.04 });
      break;
    case 'flat':
      g = flatPlane(sizeM, cellM, 60);
      break;
    case 'ridge':
    default: {
      // A rounded ridge across the box with a knoll on its northern slope.
      const ridge = convexRidge(sizeM, cellM, { heightM: 60, widthM: 900 });
      const knoll = coneHill(sizeM, cellM, { cx: 700, cy: 900, radiusM: 350, peak: 25, base: 0 });
      g = fromFunction(sizeM, cellM, () => 0);
      for (let i = 0; i < g.data.length; i++) g.data[i] = ridge.data[i] + knoll.data[i];
    }
  }
  g.meta = {
    source: `DEMO: synthetic ${kind} terrain (not the real ground)`,
    sourceResolutionM: cellM,
    surfaceModel: false,
    attribution: '',
    notes: ['Demo mode: this ground is invented, for testing indoors.'],
    centre: { lat, lon },
  };
  return g;
}

/** Fetch and draw the map features for the loaded ground, once per box. */
async function ensureLayers(progress: (m: string) => void): Promise<void> {
  if (!grid || isDemo || layers) return;
  progress('Fetching woods, water, roads and paths…');
  try {
    const centre = grid.meta.centre!;
    const sizeM = grid.width * grid.cellM;
    const combined = await fetchCombinedFeatures(centre, sizeM, {
      osKey: import.meta.env.VITE_OS_KEY ?? '',
      inGB: inGreatBritain(centre.lat, centre.lon),
      fetchOsm: (pathsAndHedgesOnly) => fetchFeatures(centre, sizeM, { pathsAndHedgesOnly }),
    });
    layers = buildLayers(grid, combined.set);
    obstacles = buildObstacles(grid, layers);
    const c = layers.counts;
    const roads = (c['major-road'] ?? 0) + (c['minor-road'] ?? 0) + (c.motorway ?? 0);
    featureNote =
      `${combined.sources.join(' ')} Loaded: ${roads} roads, ${c.track ?? 0} tracks, ${c.path ?? 0} paths, ` +
      `${c.wood ?? 0} woods, ${c.scrub ?? 0} areas of scrub, ${(c.water ?? 0) + (c.river ?? 0) + (c.stream ?? 0)} water features, ` +
      `${c.hedge ?? 0} hedges, ${c['built-up'] ?? 0} built-up areas, ${c.building ?? 0} buildings, ${c.railway ?? 0} railway lines.`;
  } catch (err) {
    featureNote = `Map features could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
  }
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'load') {
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      isDemo = !!req.demo;
      layers = null;
      obstacles = null;
      featureNote = '';
      grid = req.demo
        ? demoGrid(req.demo, req.sizeM, req.cellM, req.lat, req.lon)
        : await loadElevation(req.lat, req.lon, req.sizeM, req.cellM, {
            source: browserTileSource(),
            onProgress: progress,
          });
      progress('Analysing the ground…');
      const hs = hillshade(grid);
      const interval = chooseInterval(grid);
      let minM = Infinity;
      let maxM = -Infinity;
      for (const v of grid.data) {
        if (v < minM) minM = v;
        if (v > maxM) maxM = v;
      }
      post(
        {
          type: 'loaded',
          id: req.id,
          ground: {
            width: grid.width,
            height: grid.height,
            cellM: grid.cellM,
            meta: grid.meta,
            hillshade: hs,
            contours: contours(grid, interval),
            contourIntervalM: interval,
            ground: classifyGround(grid),
            minM,
            maxM,
          },
        },
        [hs.buffer],
      );
    } else if (req.type === 'viewshed') {
      if (!grid) throw new Error('No ground loaded yet');
      if (req.useObstacles) await ensureLayers((message) => post({ type: 'progress', id: req.id, message }));
      const t0 = performance.now();
      const p = { x: req.x, y: req.y };
      const useObs = req.useObstacles && !!obstacles;
      const obstaclesNote = !req.useObstacles
        ? 'Woods, buildings and hedges ignored (bare ground).'
        : useObs
          ? 'Woods (15 m, seen 15 m in), buildings (8 m) and hedges (2 m) block sight.'
          : isDemo
            ? 'Demo ground has no woods or buildings.'
            : 'Woods and buildings could not be loaded, so they are ignored.';
      const opts = {
        obsHeightM: req.obsHeightM,
        targetHeightM: req.targetHeightM,
        maxRangeM: req.maxRangeM,
        obstacles: useObs ? obstacles! : undefined,
      };
      const mask = viewshed(grid, p, opts);
      const inRange = countMask(inRangeMask(grid, [{ point: p }], req.maxRangeM));
      post(
        {
          type: 'viewshed',
          id: req.id,
          result: {
            mask,
            observerGroundM: elevationAtPoint(grid, p),
            visibleShare: inRange ? countMask(mask) / inRange : 0,
            timeMs: Math.round(performance.now() - t0),
            obstaclesNote,
          },
        },
        [mask.buffer],
      );
    } else if (req.type === 'features') {
      if (!grid) throw new Error('No ground loaded yet');
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      await ensureLayers(progress);
      let view: FeaturesView;
      if (isDemo) view = { ok: false, note: 'Demo ground has no map features.' };
      else if (!layers) view = { ok: false, note: featureNote };
      else view = { ok: true, note: featureNote, image: featureImage(grid.width, grid.height, layers) };
      post({ type: 'features', id: req.id, result: view }, view.image ? [view.image.buffer] : []);
    } else if (req.type === 'problem') {
      if (!grid) throw new Error('No ground loaded yet');
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      const t0 = performance.now();
      await ensureLayers(progress);
      if (isDemo) featureNote = 'Demo ground: no map features. Public access is not checked.';
      const out = generateProblem(grid, { layers, requireAccessCheck: !isDemo && !req.allowUnchecked, progress });
      const p = out.problem;
      const r = p?.result;
      const view: ProblemView = {
        found: !!p,
        log: out.log,
        featureNote,
        text: p?.text,
        nai: r ? { centre: r.approach.nai.centre, radiusM: r.approach.nai.radiusM } : undefined,
        route: r?.approach.route.filter((_, k, a) => k % 5 === 0 || k === a.length - 1),
        ds: r
          ? {
              enemyOps: r.enemyOps.map((o) => o.point),
              bestOP: r.bestViewOP?.point,
              altOP: r.alternativeOP?.point,
              concealedOP: r.concealedOP?.point,
              gunAreas: r.gunAreas.slice(0, 3).map((g) => g.centre),
              loc: r.locToBestOP?.path.filter((_, k, a) => k % 5 === 0 || k === a.length - 1),
            }
          : undefined,
        timeMs: Math.round(performance.now() - t0),
      };
      post({ type: 'problem', id: req.id, result: view });
    }
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};

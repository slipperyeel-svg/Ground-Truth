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
import type { DemoTerrain, ProblemView, WorkerRequest, WorkerResponse } from './protocol';
import { fetchFeatures } from '../features/osm';
import { buildLayers, type FeatureLayers } from '../features/layers';
import { generateProblem } from '../tactics/problem';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let grid: Grid | null = null;
let isDemo = false;
/** Map features for the loaded ground: fetched once, on the first problem request. */
let layers: FeatureLayers | null = null;
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

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'load') {
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      isDemo = !!req.demo;
      layers = null;
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
      const t0 = performance.now();
      const p = { x: req.x, y: req.y };
      const opts = { obsHeightM: req.obsHeightM, targetHeightM: req.targetHeightM, maxRangeM: req.maxRangeM };
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
          },
        },
        [mask.buffer],
      );
    } else if (req.type === 'problem') {
      if (!grid) throw new Error('No ground loaded yet');
      const progress = (message: string) => post({ type: 'progress', id: req.id, message });
      const t0 = performance.now();
      if (!isDemo && !layers) {
        progress('Fetching roads, woods, water and paths from OpenStreetMap…');
        try {
          const fs = await fetchFeatures(grid.meta.centre!, grid.width * grid.cellM);
          layers = buildLayers(grid, fs);
          const c = layers.counts;
          const roads = (c['major-road'] ?? 0) + (c['minor-road'] ?? 0) + (c.motorway ?? 0);
          featureNote = `Map features loaded from OpenStreetMap: ${roads} roads, ${c.track ?? 0} tracks, ${c.path ?? 0} paths, ` +
            `${c.wood ?? 0} woods, ${(c.water ?? 0) + (c.river ?? 0) + (c.stream ?? 0)} water features, ${c.building ?? 0} buildings.`;
        } catch (err) {
          featureNote = `Map features could not be loaded (${err instanceof Error ? err.message : String(err)}), so public access cannot be checked.`;
        }
      }
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

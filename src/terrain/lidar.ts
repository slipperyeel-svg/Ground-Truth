/**
 * Fine elevation for England from Environment Agency LIDAR (PO decision,
 * DECISIONS.md 85–86), fetched straight from the Agency's coverage service:
 *
 *  - DTM: the bare ground (1 m composite);
 *  - DSM (first return): the top of whatever stands on it — hedges, trees,
 *    walls, buildings.
 *
 * DSM minus DTM is the measured height of everything on the ground, which
 * replaces the fixed 15 m / 8 m / 2 m obstacle heights where LIDAR exists.
 *
 * Both are requested in British National Grid at the analysis cell size,
 * thinned by the server (DECISIONS.md 87, 92): fine = 2 km box at 2 m,
 * medium = 4 km at 5 m (about 4 MB per layer each), problems = 4 km at 10 m
 * (about 0.6 MB). They are then sampled onto the engine's local grid.
 */
import { createGrid, type Grid } from './grid';
import { localToLatLon } from './elevation';
import { toBNG } from '../geo/gridref';
import { readFloatTiff, type FloatRaster } from './tiff';

const WCS = 'https://environment.data.gov.uk/spatialdata';
export const LIDAR_DTM = {
  service: `${WCS}/lidar-composite-digital-terrain-model-dtm-1m/wcs`,
  coverage: '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m',
};
export const LIDAR_DSM = {
  service: `${WCS}/lidar-composite-digital-surface-model-first-return-dsm-1m/wcs`,
  coverage: 'df4e3ec3-315e-48aa-aaaf-b5ae74d7b2bb__Lidar_Composite_Elevation_FZ_DSM_1m',
};
export const LIDAR_ATTRIBUTION = 'Contains Environment Agency information © Environment Agency and/or database right';

/** Anything shorter than this above the ground is treated as noise, not an obstacle. */
const MIN_OBSTACLE_M = 0.5;
/** Give up on LIDAR (and use the coarse data) if more than this share of the box has no data. */
const MAX_MISSING = 0.05;

export interface LidarGround {
  /** Bare-ground heights on the local grid. */
  grid: Grid;
  /** Height (m) of hedges, trees, walls and buildings above the ground, per cell. */
  surfaceM: Float32Array;
  /** Share (0–1) of cells that had no LIDAR and were filled from their neighbours. */
  missingShare: number;
}

export interface BngBox {
  e0: number;
  n0: number;
  e1: number;
  n1: number;
}

/** The BNG rectangle (whole multiples of the cell size) that covers a local box. */
export function bngBoxFor(centre: { lat: number; lon: number }, sizeM: number, cellM: number): BngBox {
  const h = sizeM / 2 + 2 * cellM;
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => {
    const ll = localToLatLon(centre, x, y);
    const b = toBNG(ll.lat, ll.lon);
    return [b.easting, b.northing];
  });
  const snap = (v: number, up: boolean) => (up ? Math.ceil(v / cellM) : Math.floor(v / cellM)) * cellM;
  return {
    e0: snap(Math.min(...corners.map((c) => c[0])), false),
    n0: snap(Math.min(...corners.map((c) => c[1])), false),
    e1: snap(Math.max(...corners.map((c) => c[0])), true),
    n1: snap(Math.max(...corners.map((c) => c[1])), true),
  };
}

export function coverageUrl(src: { service: string; coverage: string }, b: BngBox, cellM: number): string {
  return (
    `${src.service}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${src.coverage}` +
    `&subset=E(${b.e0},${b.e1})&subset=N(${b.n0},${b.n1})&format=image/tiff` +
    (cellM !== 1 ? `&SCALEFACTOR=${1 / cellM}` : '')
  );
}

/**
 * Local metres → BNG, as an affine fit through three points. Over a few
 * kilometres the true mapping is affine to well under a centimetre.
 */
function localToBngAffine(centre: { lat: number; lon: number }) {
  const at = (x: number, y: number) => {
    const ll = localToLatLon(centre, x, y);
    const b = toBNG(ll.lat, ll.lon);
    return [b.easting, b.northing];
  };
  const [e0, n0] = at(0, 0);
  const [ex, nx] = at(1000, 0);
  const [ey, ny] = at(0, 1000);
  const a = (ex - e0) / 1000, b = (ey - e0) / 1000, c = (nx - n0) / 1000, d = (ny - n0) / 1000;
  return (x: number, y: number) => [e0 + a * x + b * y, n0 + c * x + d * y];
}

/** Bilinear sample of a raster whose top-left corner is (e0, n1); NaN where any neighbour has no data. */
function sampleRaster(r: FloatRaster, b: BngBox, e: number, n: number): number {
  const res = (b.e1 - b.e0) / r.width;
  const fc = (e - b.e0) / res - 0.5;
  const fr = (b.n1 - n) / res - 0.5;
  const c0 = Math.max(0, Math.min(r.width - 2, Math.floor(fc)));
  const r0 = Math.max(0, Math.min(r.height - 2, Math.floor(fr)));
  const tc = Math.min(1, Math.max(0, fc - c0));
  const tr = Math.min(1, Math.max(0, fr - r0));
  const v = (rr: number, cc: number) => {
    const x = r.data[rr * r.width + cc];
    return r.noData !== null && Math.abs(x - r.noData) < Math.abs(r.noData) * 1e-6 ? NaN : x < -1000 ? NaN : x;
  };
  const top = v(r0, c0) * (1 - tc) + v(r0, c0 + 1) * tc;
  const bot = v(r0 + 1, c0) * (1 - tc) + v(r0 + 1, c0 + 1) * tc;
  return top * (1 - tr) + bot * tr;
}

/** Fill NaN cells from their neighbours, spreading inwards from the edges of each gap. */
function fillGaps(data: Float32Array, w: number, h: number): void {
  let frontier: number[] = [];
  for (let i = 0; i < data.length; i++) if (Number.isNaN(data[i])) frontier.push(i);
  let guard = 0;
  while (frontier.length && guard++ < w + h) {
    const still: number[] = [];
    const fills: [number, number][] = [];
    for (const i of frontier) {
      const r = (i / w) | 0;
      const c = i - r * w;
      let s = 0;
      let k = 0;
      for (const j of [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, r > 0 ? i - w : -1, r < h - 1 ? i + w : -1]) {
        if (j >= 0 && !Number.isNaN(data[j])) {
          s += data[j];
          k++;
        }
      }
      if (k) fills.push([i, s / k]);
      else still.push(i);
    }
    for (const [i, v] of fills) data[i] = v;
    frontier = still;
  }
  for (const i of frontier) data[i] = 0; // no data anywhere near: should not happen in practice
}

/**
 * Load LIDAR ground and surface for a square box. Returns null if the box is
 * not covered (e.g. outside England, or at sea), so the caller can fall back.
 */
export async function loadLidar(
  centre: { lat: number; lon: number },
  sizeM: number,
  cellM: number,
  opts: { fetchImpl?: typeof fetch; onProgress?: (m: string) => void } = {},
): Promise<LidarGround | null> {
  const f = opts.fetchImpl ?? fetch;
  const b = bngBoxFor(centre, sizeM, cellM);
  const get = async (src: typeof LIDAR_DTM) => {
    // The service occasionally hangs without replying, while a retry answers
    // in about a second (normal replies take 1–3 s). So give each attempt
    // 15 s, and try up to three times.
    const ATTEMPTS = 3;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15_000);
      try {
        const res = await f(coverageUrl(src, b, cellM), { signal: ctl.signal });
        if (!res.ok) return null; // e.g. outside the coverage
        const type = res.headers.get('content-type') ?? '';
        if (!type.includes('tiff')) return null;
        return readFloatTiff(await res.arrayBuffer());
      } catch (err) {
        if (attempt === ATTEMPTS - 1) throw new Error('the Environment Agency LIDAR server did not reply');
      } finally {
        clearTimeout(timer);
      }
    }
    return null;
  };
  opts.onProgress?.('Fetching LIDAR ground and surface heights (Environment Agency)…');
  const [dtm, dsm] = await Promise.all([get(LIDAR_DTM), get(LIDAR_DSM)]);
  if (!dtm) return null;

  const n = Math.round(sizeM / cellM);
  const grid = createGrid(n, n, cellM, {
    source: 'Environment Agency LIDAR composite DTM (bare ground), 1 m, sampled at ' + cellM + ' m',
    sourceResolutionM: cellM,
    surfaceModel: false,
    attribution: LIDAR_ATTRIBUTION,
    notes: [
      'Bare-ground heights from airborne laser survey (±15 cm). Hedges, trees, walls and buildings are measured separately and block sight at their real height.',
    ],
    centre,
  });
  const surfaceM = new Float32Array(n * n);
  const toBng = localToBngAffine(centre);
  const half = sizeM / 2;
  let missing = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c + 0.5) * cellM - half;
      const y = half - (r + 0.5) * cellM;
      const [e, nn] = toBng(x, y);
      const i = r * n + c;
      const g = sampleRaster(dtm, b, e, nn);
      grid.data[i] = g;
      if (Number.isNaN(g)) missing++;
      if (dsm) {
        const s = sampleRaster(dsm, b, e, nn) - g;
        surfaceM[i] = Number.isFinite(s) && s > MIN_OBSTACLE_M ? s : 0;
      }
    }
  }
  const missingShare = missing / (n * n);
  if (missingShare > MAX_MISSING) return null;
  if (missing) fillGaps(grid.data, n, n);
  if (!dsm) grid.meta.notes.push('The LIDAR surface model did not load: hedges, trees and buildings use standard heights.');
  return { grid, surfaceM: dsm ? surfaceM : new Float32Array(0), missingShare };
}

/**
 * Turn map features into grid layers the terrain engine can use:
 *
 *  - `cover`:    what is on each cell (open, wood, scrub, water, wetland, built-up, building)
 *  - `route`:    the best road or path on each cell (none … motorway)
 *  - `going`:    the relative effort for a vehicle to cross each cell (1 = open,
 *                gently sloping ground; Infinity = impassable)
 *  - `excluded`: cells where a stand must never go (military land, railways,
 *                motorways, water, cliff edges)
 *  - `standOk`:  cells on a public path, public road verge or open-access land
 *
 * The going weights are first guesses, listed in GOING below, and are
 * PO-to-confirm (see DECISIONS.md).
 */
import { type Grid, type Mask, type Point } from '../terrain/grid';
import { slope } from '../terrain/slope';
import type { FeatureKind, FeatureSet, MapFeature } from './osm';

export const COVER = { open: 0, wood: 1, scrub: 2, water: 3, wetland: 4, builtUp: 5, building: 6 } as const;
export const COVER_NAMES = ['open', 'wood', 'scrub', 'water', 'wetland', 'built-up', 'building'];

export const ROUTE = { none: 0, path: 1, track: 2, minorRoad: 3, majorRoad: 4, motorway: 5 } as const;

/**
 * Going (vehicle effort to cross a cell, relative to open, level ground).
 * Roads replace the land-cover cost; obstacles multiply it. PO to confirm.
 */
export const GOING = {
  cover: [1, 6, 2, Infinity, 10, 3, Infinity] as number[], // indexed by COVER code
  route: [1, 1, 0.6, 0.4, 0.3, 0.25] as number[], // indexed by ROUTE code; path = no help to vehicles
  stream: 3,
  hedge: 1.5,
  wall: 2.5,
  railway: 8,
  /** Slope bands: cost multiplier up to `limitDeg`, impassable beyond. */
  slopeEasyDeg: 6,
  slopeLimitDeg: 20,
};

/** Half-widths (metres) used to draw linear features onto the grid. */
const HALF_WIDTH: Partial<Record<FeatureKind, number>> = {
  motorway: 15,
  'major-road': 8,
  'minor-road': 5,
  track: 4,
  path: 3,
  railway: 8,
  river: 10,
  stream: 3,
  hedge: 2,
  wall: 1,
  cliff: 10,
};

/** Extra no-go margin (metres) around dangerous features, for stands only. */
const EXCLUSION_MARGIN: Partial<Record<FeatureKind, number>> = {
  motorway: 25,
  railway: 25,
  cliff: 30,
  river: 15,
};

export interface FeatureLayers {
  cover: Uint8Array;
  route: Uint8Array;
  river: Mask;
  stream: Mask;
  railway: Mask;
  hedge: Mask;
  cliff: Mask;
  /** Cells where a road, track or path crosses a river (a bridge or ford). */
  crossing: Mask;
  excluded: Mask;
  standOk: Mask;
  going: Float32Array;
  /** Count of features by kind, for reporting. */
  counts: Partial<Record<FeatureKind, number>>;
  source: string;
  attribution: string;
}

// ---------------------------------------------------------------------------
// Drawing helpers

/** Mark every cell whose centre lies inside the area (even–odd rule over all rings). */
export function fillArea(g: Grid, rings: Point[][], mark: (i: number) => void): void {
  const half = (g.width * g.cellM) / 2;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of rings)
    for (const p of r) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  const c0 = Math.max(0, Math.floor((minX + half) / g.cellM));
  const c1 = Math.min(g.width - 1, Math.floor((maxX + half) / g.cellM));
  const r0 = Math.max(0, Math.floor((half - maxY) / g.cellM));
  const r1 = Math.min(g.height - 1, Math.floor((half - minY) / g.cellM));
  if (c0 > c1 || r0 > r1) return;

  // Scanline: for each row, find where the ring edges cross the row's centre
  // line, sort the crossings, and fill between pairs.
  for (let row = r0; row <= r1; row++) {
    const y = half - (row + 0.5) * g.cellM;
    const xs: number[] = [];
    for (const ring of rings) {
      const n = ring.length;
      for (let k = 0; k < n; k++) {
        const a = ring[k];
        const b = ring[(k + 1) % n]; // closes the ring implicitly
        if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const ca = Math.max(c0, Math.ceil((xs[k] + half) / g.cellM - 0.5));
      const cb = Math.min(c1, Math.floor((xs[k + 1] + half) / g.cellM - 0.5));
      for (let col = ca; col <= cb; col++) mark(row * g.width + col);
    }
  }
}

/** Mark every cell within `halfWidthM` of the polyline. */
export function drawLine(g: Grid, line: Point[], halfWidthM: number, mark: (i: number) => void): void {
  const half = (g.width * g.cellM) / 2;
  const reach = Math.max(halfWidthM, g.cellM / 2);
  const step = g.cellM / 2;
  const radCells = Math.ceil(reach / g.cellM);
  const stampedLast = new Set<number>();
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k];
    const b = line[k + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s <= n; s++) {
      const x = a.x + ((b.x - a.x) * s) / n;
      const y = a.y + ((b.y - a.y) * s) / n;
      const cc = Math.floor((x + half) / g.cellM);
      const rr = Math.floor((half - y) / g.cellM);
      for (let dr = -radCells; dr <= radCells; dr++) {
        const row = rr + dr;
        if (row < 0 || row >= g.height) continue;
        for (let dc = -radCells; dc <= radCells; dc++) {
          const col = cc + dc;
          if (col < 0 || col >= g.width) continue;
          const cx = (col + 0.5) * g.cellM - half;
          const cy = half - (row + 0.5) * g.cellM;
          if (Math.hypot(cx - x, cy - y) > reach) continue;
          const i = row * g.width + col;
          if (stampedLast.has(i)) continue;
          stampedLast.add(i);
          mark(i);
        }
      }
    }
  }
}

function drawFeature(g: Grid, f: MapFeature, halfWidthM: number, mark: (i: number) => void): void {
  if (f.shape === 'area') fillArea(g, f.rings, mark);
  else for (const line of f.rings) drawLine(g, line, halfWidthM, mark);
}

// ---------------------------------------------------------------------------

const AREA_COVER: Partial<Record<FeatureKind, number>> = {
  'built-up': COVER.builtUp,
  scrub: COVER.scrub,
  wood: COVER.wood,
  wetland: COVER.wetland,
  water: COVER.water,
  building: COVER.building,
};
/** Later entries win where areas overlap (a building inside a built-up area). */
const AREA_ORDER: FeatureKind[] = ['built-up', 'scrub', 'wood', 'wetland', 'water', 'building'];

const ROUTE_CODE: Partial<Record<FeatureKind, number>> = {
  path: ROUTE.path,
  track: ROUTE.track,
  'minor-road': ROUTE.minorRoad,
  'major-road': ROUTE.majorRoad,
  motorway: ROUTE.motorway,
};

/** Build all feature layers for a grid. `slopeDeg` may be passed if already computed. */
export function buildLayers(g: Grid, fs: FeatureSet, slopeDeg: Float32Array = slope(g)): FeatureLayers {
  const n = g.width * g.height;
  const cover = new Uint8Array(n);
  const route = new Uint8Array(n);
  const river = new Uint8Array(n);
  const stream = new Uint8Array(n);
  const railway = new Uint8Array(n);
  const hedge = new Uint8Array(n);
  const wall = new Uint8Array(n);
  const cliff = new Uint8Array(n);
  const routeOverWater = new Uint8Array(n);
  const excluded = new Uint8Array(n);
  const standOk = new Uint8Array(n);
  const counts: Partial<Record<FeatureKind, number>> = {};
  for (const f of fs.features) counts[f.kind] = (counts[f.kind] ?? 0) + 1;

  // 1. Land cover, in priority order.
  for (const kind of AREA_ORDER) {
    const code = AREA_COVER[kind]!;
    for (const f of fs.features) if (f.kind === kind && f.shape === 'area') fillArea(g, f.rings, (i) => (cover[i] = code));
  }

  // 2. Linear features.
  for (const f of fs.features) {
    if (f.shape !== 'line' || f.tunnel) continue;
    const hw = HALF_WIDTH[f.kind] ?? 3;
    const code = ROUTE_CODE[f.kind];
    if (code !== undefined) {
      drawFeature(g, f, hw, (i) => {
        if (code > route[i]) route[i] = code;
        if (f.bridge) routeOverWater[i] = 1;
        if (f.publicAccess && f.kind !== 'motorway') standOk[i] = 1;
      });
      continue;
    }
    const target =
      f.kind === 'river' ? river : f.kind === 'stream' ? stream : f.kind === 'railway' ? railway
        : f.kind === 'hedge' ? hedge : f.kind === 'wall' ? wall : f.kind === 'cliff' ? cliff : null;
    if (target) drawFeature(g, f, hw, (i) => (target[i] = 1));
  }

  // 3. Open-access land: stands allowed anywhere on it.
  for (const f of fs.features) if (f.kind === 'access-land') fillArea(g, f.rings, (i) => (standOk[i] = 1));

  // 4. Exclusions for stands.
  for (const f of fs.features) {
    if (f.kind === 'military' && f.shape === 'area') fillArea(g, f.rings, (i) => (excluded[i] = 1));
    const margin = EXCLUSION_MARGIN[f.kind];
    if (margin !== undefined && f.shape === 'line' && !f.tunnel) {
      drawFeature(g, f, (HALF_WIDTH[f.kind] ?? 0) + margin, (i) => (excluded[i] = 1));
    }
  }
  for (let i = 0; i < n; i++) {
    if (cover[i] === COVER.water || cover[i] === COVER.wetland || cover[i] === COVER.building) excluded[i] = 1;
    if (excluded[i]) standOk[i] = 0;
  }

  // 5. Crossings: a road or track on a river cell (bridge or ford).
  const crossing = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const wet = river[i] || cover[i] === COVER.water;
    if (wet && route[i] >= ROUTE.track) crossing[i] = 1;
  }

  // 6. Going.
  const going = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let cost: number;
    if (route[i] >= ROUTE.track) {
      // On a road or track the ground underneath hardly matters.
      cost = GOING.route[route[i]];
    } else {
      cost = GOING.cover[cover[i]];
      const s = slopeDeg[i];
      if (s > GOING.slopeLimitDeg) cost = Infinity;
      else if (s > GOING.slopeEasyDeg) cost *= 1 + (3 * (s - GOING.slopeEasyDeg)) / (GOING.slopeLimitDeg - GOING.slopeEasyDeg);
      if (river[i]) cost = Infinity;
      if (stream[i]) cost *= GOING.stream;
      if (hedge[i]) cost *= GOING.hedge;
      if (wall[i]) cost *= GOING.wall;
      if (railway[i]) cost *= GOING.railway;
      if (cliff[i]) cost = Infinity;
    }
    if (crossing[i]) cost = Math.min(cost, GOING.route[route[i]]);
    going[i] = cost;
  }

  return {
    cover, route, river, stream, railway, hedge, cliff, crossing, excluded, standOk, going, counts,
    source: fs.source,
    attribution: fs.attribution,
  };
}

/** A grid with nothing on it, for tests and for ground where features failed to load. */
export function emptyFeatureSet(): FeatureSet {
  return { features: [], source: 'No map features loaded', attribution: '' };
}


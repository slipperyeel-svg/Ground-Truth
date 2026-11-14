/**
 * The basic data structure for all terrain analysis: a regular square-celled
 * elevation grid in local metres.
 *
 * Conventions (used everywhere in the engine):
 *  - Row 0 is the NORTH edge; column 0 is the WEST edge.
 *  - Positions are local metres from the grid centre: x is east, y is north.
 *  - Bearings are degrees clockwise from grid north (0 = N, 90 = E).
 *  - Elevations are metres above sea level, stored in a Float32Array.
 */

export interface ElevationMeta {
  /** Human-readable source name, shown on every problem. */
  source: string;
  /** Honest resolution of the underlying data in metres (not the grid cell size). */
  sourceResolutionM: number;
  /** True if the source is a surface model (includes trees/buildings), not bare earth. */
  surfaceModel: boolean;
  /** Attribution text required by the data licence. */
  attribution: string;
  /** Free-text caveats to show the user. */
  notes: string[];
  /** Geographic centre of the grid, if it came from real data. */
  centre?: { lat: number; lon: number };
}

export interface Grid {
  width: number; // columns
  height: number; // rows
  cellM: number; // cell size in metres
  data: Float32Array; // row-major, length width*height
  meta: ElevationMeta;
}

export interface Point {
  x: number; // metres east of grid centre
  y: number; // metres north of grid centre
}

export interface Cell {
  col: number;
  row: number;
}

export const SYNTHETIC_META: ElevationMeta = {
  source: 'Synthetic test terrain',
  sourceResolutionM: 0,
  surfaceModel: false,
  attribution: '',
  notes: [],
};

export function createGrid(
  width: number,
  height: number,
  cellM: number,
  meta: ElevationMeta = SYNTHETIC_META,
): Grid {
  return { width, height, cellM, data: new Float32Array(width * height), meta };
}

export function idx(g: Grid, col: number, row: number): number {
  return row * g.width + col;
}

export function inBounds(g: Grid, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < g.width && row < g.height;
}

export function elevationAt(g: Grid, col: number, row: number): number {
  return g.data[row * g.width + col];
}

/** Centre of a cell, in local metres. */
export function cellToPoint(g: Grid, col: number, row: number): Point {
  return {
    x: (col + 0.5) * g.cellM - (g.width * g.cellM) / 2,
    y: (g.height * g.cellM) / 2 - (row + 0.5) * g.cellM,
  };
}

/** Cell containing a point (may be out of bounds; check with inBounds). */
export function pointToCell(g: Grid, p: Point): Cell {
  return {
    col: Math.floor((p.x + (g.width * g.cellM) / 2) / g.cellM),
    row: Math.floor(((g.height * g.cellM) / 2 - p.y) / g.cellM),
  };
}

/** Fractional (col,row) for a point, where integer values are cell centres. */
export function pointToFractional(g: Grid, p: Point): { c: number; r: number } {
  return {
    c: (p.x + (g.width * g.cellM) / 2) / g.cellM - 0.5,
    r: ((g.height * g.cellM) / 2 - p.y) / g.cellM - 0.5,
  };
}

/**
 * Bilinear interpolation of elevation at fractional (c, r).
 * Coordinates outside the grid are clamped to the edge.
 */
export function sampleBilinear(g: Grid, c: number, r: number): number {
  const cc = Math.min(Math.max(c, 0), g.width - 1);
  const rr = Math.min(Math.max(r, 0), g.height - 1);
  const c0 = Math.floor(cc);
  const r0 = Math.floor(rr);
  const c1 = Math.min(c0 + 1, g.width - 1);
  const r1 = Math.min(r0 + 1, g.height - 1);
  const fc = cc - c0;
  const fr = rr - r0;
  const w = g.width;
  const d = g.data;
  const top = d[r0 * w + c0] * (1 - fc) + d[r0 * w + c1] * fc;
  const bot = d[r1 * w + c0] * (1 - fc) + d[r1 * w + c1] * fc;
  return top * (1 - fr) + bot * fr;
}

export function elevationAtPoint(g: Grid, p: Point): number {
  const { c, r } = pointToFractional(g, p);
  return sampleBilinear(g, c, r);
}

/** Unit vector (east, north) for a bearing in degrees. */
export function bearingVector(bearingDeg: number): Point {
  const a = (bearingDeg * Math.PI) / 180;
  return { x: Math.sin(a), y: Math.cos(a) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Value at a given percentile (0–100) of a typed array, ignoring NaN. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const arr: number[] = [];
  for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) arr.push(values[i]);
  if (arr.length === 0) return NaN;
  arr.sort((a, b) => a - b);
  const k = Math.min(arr.length - 1, Math.max(0, Math.round((p / 100) * (arr.length - 1))));
  return arr[k];
}

/** A boolean-ish layer the same shape as a grid (1 = true). */
export type Mask = Uint8Array;

export function countMask(m: Mask): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i] ? 1 : 0;
  return n;
}

/**
 * Ordnance Survey 1:25,000 (Explorer) mapping on a Web Mercator map.
 *
 * OS only publishes its "Leisure" style (the 1:25k and 1:50k maps) in British
 * National Grid tiles, but our map library only draws Web Mercator tiles. So
 * for each Web Mercator tile the map asks for, we work out which BNG tiles
 * cover it, fetch them, and re-draw ("warp") them pixel by pixel into the
 * shape the map needs. The result looks exactly like the OS map, very
 * slightly rotated where grid north and true north differ (up to ~3°).
 *
 * This file is pure: fetching and image decoding are passed in, so it is
 * tested in Node with synthetic tiles.
 */
import { toBNG } from './gridref';

/** OS Maps API EPSG:27700 tile matrix set. */
export const BNG_TILES = {
  originX: -238375,
  originY: 1376256,
  tileSize: 256,
  /** Resolution (m/px) at zoom 0; halves with each zoom level. */
  res0: 896,
};

export function bngResolution(z: number): number {
  return BNG_TILES.res0 / 2 ** z;
}

/** BNG tile column/row (fractional) containing an easting/northing. */
export function bngTileCoord(e: number, n: number, z: number): { col: number; row: number } {
  const span = bngResolution(z) * BNG_TILES.tileSize;
  return { col: (e - BNG_TILES.originX) / span, row: (BNG_TILES.originY - n) / span };
}

/** Ground size of a Web Mercator pixel at this latitude and zoom (256 px tiles). */
export function mercatorResolution(lat: number, z: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Latitude/longitude of a fractional pixel position within Web Mercator tile z/x/y. */
export function mercatorPixelToLatLon(z: number, x: number, y: number, px: number, py: number) {
  const n = 256 * 2 ** z;
  const gx = (x * 256 + px) / n;
  const gy = (y * 256 + py) / n;
  return {
    lon: gx * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180) / Math.PI,
  };
}

/**
 * The BNG zoom to use for a Web Mercator tile: the coarsest level that is
 * still at least as detailed as the screen, within [minZ, maxZ].
 */
export function chooseBngZoom(lat: number, mercZ: number, minZ = 0, maxZ = 9): number {
  const want = mercatorResolution(lat, mercZ);
  for (let z = minZ; z <= maxZ; z++) if (bngResolution(z) <= want * 1.05) return z;
  return maxZ;
}

export interface RGBATile {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Fetch a BNG tile; resolve null if it does not exist (e.g. off the coast). */
export type BngTileFetcher = (z: number, col: number, row: number) => Promise<RGBATile | null>;

export interface WarpOptions {
  minZ?: number;
  maxZ?: number;
  /** Spacing (px) of the exact projection grid; pixels in between are interpolated. */
  step?: number;
}

/**
 * Build one 256×256 Web Mercator tile from OS BNG tiles.
 * Returns null if the tile lies entirely outside the British National Grid.
 */
export async function warpBngToMercator(
  mz: number,
  mx: number,
  my: number,
  fetchTile: BngTileFetcher,
  opts: WarpOptions = {},
): Promise<Uint8ClampedArray | null> {
  const { minZ = 0, maxZ = 9, step = 16 } = opts;
  const size = 256;
  const g = size / step + 1;

  // 1. Exact BNG coordinates on a coarse grid of points across the tile.
  const E = new Float64Array(g * g);
  const N = new Float64Array(g * g);
  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const ll = mercatorPixelToLatLon(mz, mx, my, i * step, j * step);
      const b = toBNG(ll.lat, ll.lon);
      E[j * g + i] = b.easting;
      N[j * g + i] = b.northing;
      minE = Math.min(minE, b.easting); maxE = Math.max(maxE, b.easting);
      minN = Math.min(minN, b.northing); maxN = Math.max(maxN, b.northing);
    }
  }
  if (maxE < 0 || minE > 700000 || maxN < 0 || minN > 1300000) return null;

  // 2. Which BNG tiles cover it, at a matching level of detail.
  const midLat = mercatorPixelToLatLon(mz, mx, my, 128, 128).lat;
  const bz = chooseBngZoom(midLat, mz, minZ, maxZ);
  const res = bngResolution(bz);
  const tl = bngTileCoord(minE, maxN, bz);
  const br = bngTileCoord(maxE, minN, bz);
  const c0 = Math.max(0, Math.floor(tl.col));
  const r0 = Math.max(0, Math.floor(tl.row));
  const c1 = Math.floor(br.col);
  const r1 = Math.floor(br.row);
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  if (cols <= 0 || rows <= 0 || cols * rows > 16) return null;

  const tiles: (RGBATile | null)[] = await Promise.all(
    Array.from({ length: cols * rows }, (_, k) => fetchTile(bz, c0 + (k % cols), r0 + Math.floor(k / cols))),
  );
  if (tiles.every((t) => !t)) return null;

  // Read one pixel from the mosaic of BNG tiles (null where no tile).
  const ts = BNG_TILES.tileSize;
  const px = (gx: number, gy: number, out: number[]) => {
    const tc = Math.floor(gx / ts), tr = Math.floor(gy / ts);
    if (tc < 0 || tr < 0 || tc >= cols || tr >= rows) return false;
    const t = tiles[tr * cols + tc];
    if (!t) return false;
    const i = ((gy - tr * ts) * t.width + (gx - tc * ts)) * 4;
    out[0] = t.data[i]; out[1] = t.data[i + 1]; out[2] = t.data[i + 2]; out[3] = t.data[i + 3];
    return true;
  };

  // 3. For every output pixel, find its BNG position and sample bilinearly.
  const out = new Uint8ClampedArray(size * size * 4);
  const p00 = [0, 0, 0, 0], p10 = [0, 0, 0, 0], p01 = [0, 0, 0, 0], p11 = [0, 0, 0, 0];
  const originCol = c0 * ts;
  const originRow = r0 * ts;
  for (let py = 0; py < size; py++) {
    const fy = (py + 0.5) / step;
    const j0 = Math.min(Math.floor(fy), g - 2);
    const ay = fy - j0;
    for (let pxi = 0; pxi < size; pxi++) {
      const fx = (pxi + 0.5) / step;
      const i0 = Math.min(Math.floor(fx), g - 2);
      const ax = fx - i0;
      const k = j0 * g + i0;
      const e = (E[k] * (1 - ax) + E[k + 1] * ax) * (1 - ay) + (E[k + g] * (1 - ax) + E[k + g + 1] * ax) * ay;
      const n = (N[k] * (1 - ax) + N[k + 1] * ax) * (1 - ay) + (N[k + g] * (1 - ax) + N[k + g + 1] * ax) * ay;
      // Position in the mosaic, in source pixels (pixel centres at +0.5).
      const sx = (e - BNG_TILES.originX) / res - originCol - 0.5;
      const sy = (BNG_TILES.originY - n) / res - originRow - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const bx = sx - x0, by = sy - y0;
      if (!px(x0, y0, p00) || !px(x0 + 1, y0, p10) || !px(x0, y0 + 1, p01) || !px(x0 + 1, y0 + 1, p11)) {
        // At a missing tile edge, fall back to the nearest pixel if there is one.
        if (!px(Math.round(sx), Math.round(sy), p00)) continue;
        out.set(p00, (py * size + pxi) * 4);
        continue;
      }
      const o = (py * size + pxi) * 4;
      for (let c = 0; c < 4; c++) {
        out[o + c] = (p00[c] * (1 - bx) + p10[c] * bx) * (1 - by) + (p01[c] * (1 - bx) + p11[c] * bx) * by;
      }
    }
  }
  return out;
}

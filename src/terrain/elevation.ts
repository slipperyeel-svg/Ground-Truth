/**
 * Loading real elevation data onto the engine's local metric grid.
 *
 * Default source: AWS Terrain Tiles in Terrarium PNG format (free, no key).
 * Each pixel's colour encodes a height:  metres = (R × 256 + G + B / 256) − 32768.
 *
 * Tiles are in Web Mercator. We build a square grid in local metres centred on
 * the user (x east, y north, true north up) and, for each grid cell, work out
 * its latitude/longitude, find it in the tiles and interpolate the height.
 * Over a 4 km box the flat-earth local projection is accurate to centimetres.
 *
 * Fetching and PNG decoding are passed in as a `TileSource`, so the same code
 * runs in a browser worker, in Node tests, or on a server later.
 */
import { createGrid, type ElevationMeta, type Grid } from './grid';

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TILE_SIZE = 256;
const EARTH_RADIUS_M = 6_371_000;
/** Web Mercator ground size of one pixel at zoom 0 on the equator, for 256 px tiles. */
const MERCATOR_M_PER_PX_Z0 = 156_543.033_92;

/**
 * Attribution for AWS Terrain Tiles. The Joerd project lists one notice per
 * contributing dataset; these are the ones relevant to Great Britain and the
 * global fallbacks. See DECISIONS.md: the full list must be checked against
 * https://github.com/tilezen/joerd/blob/master/docs/attribution.md before release.
 */
export const TERRAIN_TILES_ATTRIBUTION = [
  'Elevation: Terrain Tiles (Mapzen/Joerd), AWS Open Data.',
  'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers.',
  'United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved.',
  'SRTM and GMTED2010 terrain data courtesy of the U.S. Geological Survey.',
].join(' ');

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA, 4 bytes per pixel
}

export interface TileSource {
  /** Fetch and decode one tile. Reject if unavailable. */
  getTile(z: number, x: number, y: number): Promise<RGBAImage>;
}

export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Inverse of decodeTerrarium (used by tests and offline caches). */
export function encodeTerrarium(elevationM: number): [number, number, number] {
  const v = elevationM + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v) - r * 256;
  const b = Math.round((v - Math.floor(v)) * 256);
  return [r, g, Math.min(255, b)];
}

/** Global Web Mercator pixel coordinates (pixel i spans [i, i+1)). */
export function lonLatToGlobalPixel(lat: number, lon: number, z: number): { px: number; py: number } {
  const n = TILE_SIZE * 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    px: ((lon + 180) / 360) * n,
    py: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/** Ground size of a tile pixel at this latitude and zoom. */
export function pixelSizeM(lat: number, z: number): number {
  return (MERCATOR_M_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Local metres (x east, y north) from a centre point → latitude/longitude. */
export function localToLatLon(centre: { lat: number; lon: number }, x: number, y: number) {
  const lat = centre.lat + (y / EARTH_RADIUS_M) * (180 / Math.PI);
  const lon =
    centre.lon + (x / (EARTH_RADIUS_M * Math.cos((centre.lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat, lon };
}

/** Latitude/longitude → local metres from a centre point. */
export function latLonToLocal(centre: { lat: number; lon: number }, lat: number, lon: number) {
  return {
    x: ((lon - centre.lon) * Math.PI) / 180 * EARTH_RADIUS_M * Math.cos((centre.lat * Math.PI) / 180),
    y: ((lat - centre.lat) * Math.PI) / 180 * EARTH_RADIUS_M,
  };
}

export interface LoadOptions {
  /** Tile zoom level. Default 13 (≈12 m pixels in Britain; the data itself is ~30 m). */
  zoom?: number;
  source: TileSource;
  /** Called with progress messages for the UI. */
  onProgress?: (message: string) => void;
}

/**
 * Load elevation for a square box centred on (lat, lon).
 * Returns a Grid of sizeM × sizeM metres with cellM cells, plus metadata.
 */
export async function loadElevation(
  lat: number,
  lon: number,
  sizeM: number,
  cellM: number,
  opts: LoadOptions,
): Promise<Grid> {
  const z = opts.zoom ?? 13;
  const n = Math.round(sizeM / cellM);
  const centre = { lat, lon };
  const half = (n * cellM) / 2;

  // Pixel bounding box of the grid, with a one-pixel margin for interpolation.
  const corners = [
    localToLatLon(centre, -half, half),
    localToLatLon(centre, half, half),
    localToLatLon(centre, -half, -half),
    localToLatLon(centre, half, -half),
  ].map((c) => lonLatToGlobalPixel(c.lat, c.lon, z));
  const minPx = Math.floor(Math.min(...corners.map((c) => c.px))) - 1;
  const maxPx = Math.ceil(Math.max(...corners.map((c) => c.px))) + 1;
  const minPy = Math.floor(Math.min(...corners.map((c) => c.py))) - 1;
  const maxPy = Math.ceil(Math.max(...corners.map((c) => c.py))) + 1;
  const tx0 = Math.floor(minPx / TILE_SIZE);
  const tx1 = Math.floor(maxPx / TILE_SIZE);
  const ty0 = Math.floor(minPy / TILE_SIZE);
  const ty1 = Math.floor(maxPy / TILE_SIZE);

  // Fetch the tiles and paste them into one mosaic of heights.
  const mw = (tx1 - tx0 + 1) * TILE_SIZE;
  const mh = (ty1 - ty0 + 1) * TILE_SIZE;
  const mosaic = new Float32Array(mw * mh);
  const jobs: Promise<void>[] = [];
  const total = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  let done = 0;
  opts.onProgress?.(`Fetching ${total} elevation tile${total === 1 ? '' : 's'}…`);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        opts.source.getTile(z, tx, ty).then((img) => {
          if (img.width !== TILE_SIZE || img.height !== TILE_SIZE) {
            throw new Error(`Unexpected tile size ${img.width}×${img.height} at ${z}/${tx}/${ty}`);
          }
          const ox = (tx - tx0) * TILE_SIZE;
          const oy = (ty - ty0) * TILE_SIZE;
          for (let r = 0; r < TILE_SIZE; r++) {
            for (let c = 0; c < TILE_SIZE; c++) {
              const i = (r * TILE_SIZE + c) * 4;
              mosaic[(oy + r) * mw + ox + c] = decodeTerrarium(img.data[i], img.data[i + 1], img.data[i + 2]);
            }
          }
          done++;
          opts.onProgress?.(`Fetched ${done} of ${total} tiles`);
        }),
      );
    }
  }
  await Promise.all(jobs);

  // Resample onto the local grid (bilinear between pixel centres).
  const basePx = tx0 * TILE_SIZE;
  const basePy = ty0 * TILE_SIZE;
  const sample = (px: number, py: number) => {
    const fx = Math.min(Math.max(px - basePx - 0.5, 0), mw - 1);
    const fy = Math.min(Math.max(py - basePy - 0.5, 0), mh - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, mw - 1), y1 = Math.min(y0 + 1, mh - 1);
    const ax = fx - x0, ay = fy - y0;
    const top = mosaic[y0 * mw + x0] * (1 - ax) + mosaic[y0 * mw + x1] * ax;
    const bot = mosaic[y1 * mw + x0] * (1 - ax) + mosaic[y1 * mw + x1] * ax;
    return top * (1 - ay) + bot * ay;
  };

  const pxM = pixelSizeM(lat, z);
  const meta: ElevationMeta = {
    source: `AWS Terrain Tiles (Terrarium), zoom ${z}`,
    // In Britain most of this dataset is EU-DEM (~30 m), with some Environment
    // Agency data in England. The tile pixel is finer than the data beneath it.
    sourceResolutionM: Math.max(30, pxM),
    surfaceModel: true,
    attribution: TERRAIN_TILES_ATTRIBUTION,
    notes: [
      `Underlying data about 30 m; tile pixels ${pxM.toFixed(0)} m; analysis grid ${cellM} m.`,
      'Hedges, walls, sunken lanes and small folds in the ground are not shown.',
      'Partly a surface model: dense woods and built-up areas may read as raised ground.',
    ],
    centre,
  };

  const grid = createGrid(n, n, cellM, meta);
  for (let row = 0; row < n; row++) {
    const y = half - (row + 0.5) * cellM;
    for (let col = 0; col < n; col++) {
      const x = (col + 0.5) * cellM - half;
      const ll = localToLatLon(centre, x, y);
      const p = lonLatToGlobalPixel(ll.lat, ll.lon, z);
      grid.data[row * n + col] = sample(p.px, p.py);
    }
  }
  return grid;
}

/**
 * Parse an ESRI ASCII grid (the format of OS Terrain 50). Coordinates are in
 * the file's own projection — British National Grid metres for OS data.
 */
export interface AsciiGrid {
  ncols: number;
  nrows: number;
  xll: number; // easting of the lower-left corner
  yll: number; // northing of the lower-left corner
  cellsize: number;
  nodata: number;
  data: Float32Array; // row 0 = north
}

export function parseAsciiGrid(text: string): AsciiGrid {
  const lines = text.split(/\r?\n/);
  const header: Record<string, number> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].trim().match(/^([a-zA-Z_]+)\s+(-?[\d.eE+-]+)$/);
    if (!m) break;
    header[m[1].toLowerCase()] = Number(m[2]);
  }
  const ncols = header.ncols;
  const nrows = header.nrows;
  const cellsize = header.cellsize;
  if (!ncols || !nrows || !cellsize) throw new Error('Not an ASCII grid: missing ncols/nrows/cellsize');
  const xll = header.xllcorner ?? header.xllcenter - cellsize / 2;
  const yll = header.yllcorner ?? header.yllcenter - cellsize / 2;
  const nodata = header.nodata_value ?? -9999;
  const values = lines.slice(i).join(' ').trim().split(/\s+/).map(Number);
  if (values.length < ncols * nrows) throw new Error(`ASCII grid has ${values.length} values, expected ${ncols * nrows}`);
  return { ncols, nrows, xll, yll, cellsize, nodata, data: Float32Array.from(values.slice(0, ncols * nrows)) };
}

/**
 * Cut a square box from an ASCII grid and resample it onto a Grid.
 * The box is centred on (easting, northing) and aligned to the file's grid
 * north (for British National Grid this differs from true north by up to ~3°).
 */
export function gridFromAscii(
  a: AsciiGrid,
  easting: number,
  northing: number,
  sizeM: number,
  cellM: number,
  meta: Partial<ElevationMeta> = {},
): Grid {
  const n = Math.round(sizeM / cellM);
  const half = (n * cellM) / 2;
  const grid = createGrid(n, n, cellM, {
    source: meta.source ?? 'OS Terrain 50 (local file)',
    sourceResolutionM: a.cellsize,
    surfaceModel: false,
    attribution: meta.attribution ?? 'Contains OS data © Crown copyright and database right.',
    notes: meta.notes ?? [`Data ${a.cellsize} m; analysis grid ${cellM} m. Aligned to grid north.`],
  });
  const yTop = a.yll + a.nrows * a.cellsize;
  for (let row = 0; row < n; row++) {
    const N = northing + half - (row + 0.5) * cellM;
    for (let col = 0; col < n; col++) {
      const E = easting - half + (col + 0.5) * cellM;
      const fc = Math.min(Math.max((E - a.xll) / a.cellsize - 0.5, 0), a.ncols - 1);
      const fr = Math.min(Math.max((yTop - N) / a.cellsize - 0.5, 0), a.nrows - 1);
      const c0 = Math.floor(fc), r0 = Math.floor(fr);
      const c1 = Math.min(c0 + 1, a.ncols - 1), r1 = Math.min(r0 + 1, a.nrows - 1);
      const ax = fc - c0, ay = fr - r0;
      const v = (r: number, c: number) => a.data[r * a.ncols + c];
      const top = v(r0, c0) * (1 - ax) + v(r0, c1) * ax;
      const bot = v(r1, c0) * (1 - ax) + v(r1, c1) * ax;
      grid.data[row * n + col] = top * (1 - ay) + bot * ay;
    }
  }
  return grid;
}

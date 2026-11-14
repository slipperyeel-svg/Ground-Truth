import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  decodeTerrarium,
  encodeTerrarium,
  gridFromAscii,
  latLonToLocal,
  loadElevation,
  localToLatLon,
  lonLatToGlobalPixel,
  parseAsciiGrid,
  pixelSizeM,
  TERRARIUM_URL,
  type RGBAImage,
  type TileSource,
} from '../src/terrain/elevation';
import { elevationAtPoint } from '../src/terrain/grid';
import { slope } from '../src/terrain/slope';

describe('Terrarium encoding', () => {
  it('decodes the documented formula', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0); // sea level
    expect(decodeTerrarium(128, 100, 128)).toBeCloseTo(100.5);
  });

  it('round-trips heights to within 1/256 m', () => {
    for (const h of [-12.3, 0, 47.25, 312.9, 1343.0]) {
      const [r, g, b] = encodeTerrarium(h);
      expect(decodeTerrarium(r, g, b)).toBeCloseTo(h, 2);
    }
  });

  it('survives a real PNG encode/decode', () => {
    const png = new PNG({ width: 2, height: 1 });
    const [r, g, b] = encodeTerrarium(256.75);
    png.data.set([r, g, b, 255, 0, 0, 0, 255]);
    const back = PNG.sync.read(PNG.sync.write(png));
    expect(decodeTerrarium(back.data[0], back.data[1], back.data[2])).toBeCloseTo(256.75, 2);
  });
});

describe('map projection helpers', () => {
  it('puts lon 0 / lat 0 in the middle of the world', () => {
    const p = lonLatToGlobalPixel(0, 0, 1);
    expect(p.px).toBeCloseTo(256);
    expect(p.py).toBeCloseTo(256);
  });

  it('gives ~12 m pixels at zoom 13 in southern England', () => {
    expect(pixelSizeM(51.5, 13)).toBeCloseTo(11.9, 0);
  });

  it('round-trips local metres ↔ lat/lon', () => {
    const c = { lat: 51.1789, lon: -1.8262 }; // Stonehenge
    const ll = localToLatLon(c, 1500, -1200);
    const back = latLonToLocal(c, ll.lat, ll.lon);
    expect(back.x).toBeCloseTo(1500, 3);
    expect(back.y).toBeCloseTo(-1200, 3);
  });
});

/**
 * A fake tile server whose heights are a known function of latitude and
 * longitude, so we can check the resampled grid against the truth.
 */
function fakeSource(heightAt: (lat: number, lon: number) => number): TileSource & { calls: number } {
  const src = {
    calls: 0,
    async getTile(z: number, x: number, y: number): Promise<RGBAImage> {
      src.calls++;
      const data = new Uint8ClampedArray(256 * 256 * 4);
      const n = 256 * 2 ** z;
      for (let r = 0; r < 256; r++) {
        for (let c = 0; c < 256; c++) {
          const px = x * 256 + c + 0.5;
          const py = y * 256 + r + 0.5;
          const lon = (px / n) * 360 - 180;
          const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI;
          const [R, G, B] = encodeTerrarium(heightAt(lat, lon));
          data.set([R, G, B, 255], (r * 256 + c) * 4);
        }
      }
      return { width: 256, height: 256, data };
    },
  };
  return src;
}

describe('loadElevation', () => {
  const centre = { lat: 51.2, lon: -1.8 };

  it('reproduces a known slope (1 in 20 rising to the north)', async () => {
    const src = fakeSource((lat) => 100 + ((lat - centre.lat) * Math.PI / 180) * 6_371_000 * 0.05);
    const g = await loadElevation(centre.lat, centre.lon, 4000, 10, { source: src });
    expect(g.width).toBe(400);
    expect(elevationAtPoint(g, { x: 0, y: 0 })).toBeCloseTo(100, 0);
    expect(elevationAtPoint(g, { x: 0, y: 1000 })).toBeCloseTo(150, 0);
    expect(elevationAtPoint(g, { x: 1500, y: -1000 })).toBeCloseTo(50, 0);
    const s = slope(g);
    expect(s[200 * 400 + 200]).toBeCloseTo((Math.atan(0.05) * 180) / Math.PI, 1);
  });

  it('fetches only the tiles it needs and records the data source', async () => {
    const src = fakeSource(() => 100);
    const msgs: string[] = [];
    const g = await loadElevation(centre.lat, centre.lon, 4000, 10, { source: src, onProgress: (m) => msgs.push(m) });
    // A 4 km box at zoom 13 in England needs a 2×2 or 3×3 block of 3 km tiles.
    expect(src.calls).toBeGreaterThanOrEqual(4);
    expect(src.calls).toBeLessThanOrEqual(9);
    expect(g.meta.source).toMatch(/Terrain Tiles/);
    expect(g.meta.sourceResolutionM).toBeGreaterThanOrEqual(30);
    expect(g.meta.attribution).toMatch(/EU-DEM/);
    expect(msgs[0]).toMatch(/Fetching/);
  });

  it('reports a failed tile rather than returning a hole', async () => {
    const src: TileSource = { getTile: async () => Promise.reject(new Error('HTTP 503')) };
    await expect(loadElevation(centre.lat, centre.lon, 1000, 10, { source: src })).rejects.toThrow('503');
  });
});

describe('OS Terrain 50 ASCII grid', () => {
  const text = [
    'ncols 4',
    'nrows 3',
    'xllcorner 400000',
    'yllcorner 140000',
    'cellsize 50',
    'NODATA_value -9999',
    '10 20 30 40',
    '10 20 30 40',
    '10 20 30 40',
  ].join('\n');

  it('parses the header and values', () => {
    const a = parseAsciiGrid(text);
    expect(a.ncols).toBe(4);
    expect(a.data[3]).toBe(40);
  });

  it('cuts a box and interpolates a west–east gradient', () => {
    const a = parseAsciiGrid(text);
    const g = gridFromAscii(a, 400100, 140075, 100, 10);
    expect(g.meta.sourceResolutionM).toBe(50);
    // Easting 400100 is the boundary between the 2nd and 3rd columns (20 and 30).
    expect(elevationAtPoint(g, { x: 0, y: 0 })).toBeCloseTo(25, 0);
  });
});

// Real network test: run with  NETWORK=1 npm test
describe.skipIf(!process.env.NETWORK)('real AWS tiles (network)', () => {
  const nodeSource: TileSource = {
    async getTile(z, x, y) {
      const url = TERRARIUM_URL.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
      return { width: png.width, height: png.height, data: png.data };
    },
  };

  it('loads Salisbury Plain with plausible heights', async () => {
    const g = await loadElevation(51.2, -1.85, 4000, 10, { source: nodeSource });
    const z = elevationAtPoint(g, { x: 0, y: 0 });
    expect(z).toBeGreaterThan(50);
    expect(z).toBeLessThan(250);
  });
});

import { describe, expect, it } from 'vitest';
import {
  BNG_TILES,
  bngResolution,
  bngTileCoord,
  chooseBngZoom,
  mercatorPixelToLatLon,
  warpBngToMercator,
  type RGBATile,
} from '../src/geo/osTiles';
import { toBNG } from '../src/geo/gridref';
import { lonLatToGlobalPixel } from '../src/terrain/elevation';

/**
 * Synthetic OS tiles: each BNG pixel is coloured by its own easting/northing
 * (red = easting within a 2.56 km band, green = northing within it), so after
 * warping we can read back which ground each output pixel came from.
 */
function syntheticBngTile(z: number, col: number, row: number): RGBATile {
  const res = bngResolution(z);
  const data = new Uint8ClampedArray(256 * 256 * 4);
  for (let r = 0; r < 256; r++) {
    for (let c = 0; c < 256; c++) {
      const e = BNG_TILES.originX + (col * 256 + c + 0.5) * res;
      const n = BNG_TILES.originY - (row * 256 + r + 0.5) * res;
      data.set([Math.floor(e / 10) % 256, Math.floor(n / 10) % 256, 0, 255], (r * 256 + c) * 4);
    }
  }
  return { width: 256, height: 256, data };
}

describe('BNG tile maths', () => {
  it('uses OS resolutions: zoom 7 is 7 m/px (1:25k), zoom 9 is 1.75 m/px', () => {
    expect(bngResolution(7)).toBe(7);
    expect(bngResolution(9)).toBe(1.75);
  });

  it('places the false origin at tile 0,0', () => {
    expect(bngTileCoord(BNG_TILES.originX, BNG_TILES.originY, 0)).toEqual({ col: 0, row: 0 });
  });

  it('picks a BNG zoom at least as detailed as the screen', () => {
    // Web Mercator zoom 15 at 51°N ≈ 3.0 m/px. BNG zoom 8 (3.5 m/px) is too coarse, so 9 (1.75 m/px).
    expect(chooseBngZoom(51, 15)).toBe(9);
    expect(chooseBngZoom(51, 13)).toBe(7); // ≈12 m/px → 7 m/px
    expect(chooseBngZoom(51, 18)).toBe(9); // finer than OS offers: use the finest
  });
});

describe('warping OS tiles into Web Mercator', () => {
  it('puts each pixel on the right ground (within a few metres)', async () => {
    // A Web Mercator zoom-15 tile over Salisbury Plain.
    const mz = 15;
    const g = lonLatToGlobalPixel(51.2, -1.85, mz);
    const mx = Math.floor(g.px / 256);
    const my = Math.floor(g.py / 256);
    let fetched = 0;
    const out = await warpBngToMercator(mz, mx, my, async (z, c, r) => {
      fetched++;
      return syntheticBngTile(z, c, r);
    });
    expect(out).not.toBeNull();
    expect(fetched).toBeGreaterThan(0);
    expect(fetched).toBeLessThanOrEqual(9);

    // Check a spread of pixels against the true BNG position of their centres.
    for (const [px, py] of [[10, 10], [128, 128], [250, 40], [60, 230]]) {
      const ll = mercatorPixelToLatLon(mz, mx, my, px + 0.5, py + 0.5);
      const b = toBNG(ll.lat, ll.lon);
      const i = (py * 256 + px) * 4;
      // Red/green encode easting/northing modulo 2,560 m in 10 m steps.
      const de = ((out![i] * 10 - (Math.floor(b.easting / 10) % 256) * 10) % 2560 + 2560) % 2560;
      const dn = ((out![i + 1] * 10 - (Math.floor(b.northing / 10) % 256) * 10) % 2560 + 2560) % 2560;
      expect(Math.min(de, 2560 - de)).toBeLessThanOrEqual(10);
      expect(Math.min(dn, 2560 - dn)).toBeLessThanOrEqual(10);
      expect(out![i + 3]).toBe(255);
    }
  });

  it('returns nothing for tiles outside Great Britain', async () => {
    const g = lonLatToGlobalPixel(40.7, -74.0, 12); // New York
    const out = await warpBngToMercator(12, Math.floor(g.px / 256), Math.floor(g.py / 256), async () => {
      throw new Error('should not fetch');
    });
    expect(out).toBeNull();
  });

  it('leaves missing OS tiles transparent rather than failing', async () => {
    const mz = 14;
    const g = lonLatToGlobalPixel(51.2, -1.85, mz);
    const out = await warpBngToMercator(mz, Math.floor(g.px / 256), Math.floor(g.py / 256), async () => null);
    expect(out).toBeNull();
  });
});

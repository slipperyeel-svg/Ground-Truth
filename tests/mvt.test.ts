import { describe, expect, it } from 'vitest';
import { decodeTile, tileToLonLat } from '../src/features/mvt';

// --- A tiny Protocol Buffers / vector tile encoder, for building test tiles ---
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};
const key = (field: number, wire: number) => varint(field * 8 + wire);
const bytesField = (field: number, b: number[]) => [...key(field, 2), ...varint(b.length), ...b];
const str = (s: string) => Array.from(new TextEncoder().encode(s));
const zz = (n: number) => (n >= 0 ? n * 2 : -n * 2 - 1);
const packed = (field: number, xs: number[]) => bytesField(field, xs.flatMap(varint));

/** Geometry commands for parts of absolute points; polygons get ClosePath. */
function geom(parts: [number, number][][], close: boolean): number[] {
  const out: number[] = [];
  let x = 0, y = 0;
  for (const part of parts) {
    const pts = close ? part.slice(0, -1) : part;
    out.push((1 << 3) | 1, zz(pts[0][0] - x), zz(pts[0][1] - y));
    [x, y] = pts[0];
    out.push(((pts.length - 1) << 3) | 2);
    for (const [px, py] of pts.slice(1)) {
      out.push(zz(px - x), zz(py - y));
      [x, y] = [px, py];
    }
    if (close) out.push((1 << 3) | 7);
  }
  return out;
}

function encodeLayer(name: string, keys: string[], values: number[][], features: number[][]): number[] {
  return bytesField(3, [
    ...key(15, 0), ...varint(2),
    ...bytesField(1, str(name)),
    ...features.flatMap((f) => bytesField(2, f)),
    ...keys.flatMap((k) => bytesField(3, str(k))),
    ...values.flatMap((v) => bytesField(4, v)),
    ...key(5, 0), ...varint(4096),
  ]);
}

describe('vector tile reader', () => {
  const woodOuter: [number, number][] = [[100, 100], [900, 100], [900, 900], [100, 900], [100, 100]];
  const woodHole: [number, number][] = [[400, 400], [400, 600], [600, 600], [600, 400], [400, 400]];
  const road: [number, number][] = [[0, 2000], [4096, 2100], [3000, 4000]];
  const tile = new Uint8Array([
    ...encodeLayer(
      'woodland',
      ['type', 'area'],
      [bytesField(1, str('Deciduous')), [...key(3, 1), ...Array.from(new Uint8Array(new Float64Array([12.5]).buffer))]],
      [[...key(1, 0), ...varint(7), ...packed(2, [0, 0, 1, 1]), ...key(3, 0), ...varint(3), ...packed(4, geom([woodOuter, woodHole], true))]],
    ),
    ...encodeLayer(
      'roads',
      ['class', 'lanes', 'oneway'],
      [bytesField(1, str('B Road')), [...key(4, 0), ...varint(2)], [...key(7, 0), ...varint(1)]],
      [[...packed(2, [0, 0, 1, 1, 2, 2]), ...key(3, 0), ...varint(2), ...packed(4, geom([road], false))]],
    ),
  ]);

  it('reads layers, attributes and geometry', () => {
    const layers = decodeTile(tile);
    expect(layers.map((l) => l.name)).toEqual(['woodland', 'roads']);
    const wood = layers[0].features[0];
    expect(wood.type).toBe(3);
    expect(wood.properties).toEqual({ type: 'Deciduous', area: 12.5 });
    expect(wood.geometry).toEqual([woodOuter, woodHole]);
    const r = layers[1].features[0];
    expect(r.type).toBe(2);
    expect(r.properties).toEqual({ class: 'B Road', lanes: 2, oneway: true });
    expect(r.geometry).toEqual([road]);
    expect(layers[0].extent).toBe(4096);
  });

  it('converts tile units to latitude and longitude', () => {
    // Tile 0/0/0 covers the world; its centre is 0°, 0°.
    const c = tileToLonLat(0, 0, 0, 4096, 2048, 2048);
    expect(c.lat).toBeCloseTo(0, 6);
    expect(c.lon).toBeCloseTo(0, 6);
    // Top-left of zoom 1 tile (1,0) is 0° E at the Mercator limit.
    const tl = tileToLonLat(1, 1, 0, 4096, 0, 0);
    expect(tl.lon).toBeCloseTo(0, 6);
    expect(tl.lat).toBeCloseTo(85.0511, 3);
  });
});

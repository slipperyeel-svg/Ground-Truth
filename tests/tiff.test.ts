import { describe, expect, it } from 'vitest';
import { readFloatTiff } from '../src/terrain/tiff';

/** Build a one-band float32 TIFF, tiled or stripped, in either byte order. */
function makeTiff(w: number, h: number, values: (r: number, c: number) => number, opts: { le: boolean; tile?: number; noData?: string }): ArrayBuffer {
  const le = opts.le;
  const tile = opts.tile;
  const pixelBlocks: Float32Array[] = [];
  if (tile) {
    for (let r0 = 0; r0 < h; r0 += tile)
      for (let c0 = 0; c0 < w; c0 += tile) {
        const b = new Float32Array(tile * tile);
        for (let r = 0; r < tile; r++) for (let c = 0; c < tile; c++) if (r0 + r < h && c0 + c < w) b[r * tile + c] = values(r0 + r, c0 + c);
        pixelBlocks.push(b);
      }
  } else {
    const b = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) b[r * w + c] = values(r, c);
    pixelBlocks.push(b);
  }
  // Layout: header (8) | IFD | extra values | pixel data
  const nTags = 9 + (opts.noData ? 1 : 0);
  const ifdSize = 2 + nTags * 12 + 4;
  let extra = 8 + ifdSize;
  const extraBytes: number[] = [];
  const blockBytes = pixelBlocks[0].length * 4;
  const offsetsTagAt = extra;
  extra += 4 * pixelBlocks.length; // room for offsets array
  const ndAt = extra;
  if (opts.noData) extra += opts.noData.length + 1;
  const dataStart = extra;
  const total = dataStart + blockBytes * pixelBlocks.length;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint8(0, le ? 0x49 : 0x4d);
  dv.setUint8(1, le ? 0x49 : 0x4d);
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le);
  const tags: [number, number, number, number][] = [
    [256, 3, 1, w],
    [257, 3, 1, h],
    [258, 3, 1, 32],
    [259, 3, 1, 1],
    [277, 3, 1, 1],
    [339, 3, 1, 3],
  ];
  if (tile) tags.push([322, 3, 1, tile], [323, 3, 1, tile], [324, 4, pixelBlocks.length, -1]);
  else tags.push([273, 4, pixelBlocks.length, -1], [278, 3, 1, h], [262, 3, 1, 1]);
  if (opts.noData) tags.push([42113, 2, opts.noData.length + 1, -2]);
  tags.sort((a, b) => a[0] - b[0]);
  dv.setUint16(8, tags.length, le);
  tags.forEach(([tag, type, n, v], k) => {
    const e = 10 + k * 12;
    dv.setUint16(e, tag, le);
    dv.setUint16(e + 2, type, le);
    dv.setUint32(e + 4, n, le);
    if (v === -1) {
      if (n === 1) dv.setUint32(e + 8, dataStart, le);
      else dv.setUint32(e + 8, offsetsTagAt, le);
    } else if (v === -2) dv.setUint32(e + 8, ndAt, le);
    else if (type === 3) dv.setUint16(e + 8, v, le);
    else dv.setUint32(e + 8, v, le);
  });
  pixelBlocks.forEach((b, i) => {
    const off = dataStart + i * blockBytes;
    dv.setUint32(offsetsTagAt + i * 4, off, le);
    b.forEach((x, j) => dv.setFloat32(off + j * 4, x, le));
  });
  if (opts.noData) for (let i = 0; i < opts.noData.length; i++) dv.setUint8(ndAt + i, opts.noData.charCodeAt(i));
  void extraBytes;
  return buf;
}

describe('TIFF reader', () => {
  const f = (r: number, c: number) => 100 + r * 10 + c + 0.25;

  it('reads a big-endian tiled file (as the Environment Agency sends)', () => {
    const t = readFloatTiff(makeTiff(5, 3, f, { le: false, tile: 4, noData: '-3.4e38' }));
    expect(t.width).toBe(5);
    expect(t.height).toBe(3);
    expect(t.data[0]).toBeCloseTo(100.25, 5);
    expect(t.data[2 * 5 + 4]).toBeCloseTo(124.25, 5);
    expect(t.noData).toBeCloseTo(-3.4e38, -33);
  });

  it('reads a little-endian stripped file', () => {
    const t = readFloatTiff(makeTiff(4, 4, f, { le: true }));
    expect(t.data[3 * 4 + 1]).toBeCloseTo(131.25, 5);
    expect(t.noData).toBeNull();
  });

  it.skipIf(!process.env.NETWORK)('reads real Environment Agency LIDAR (network)', async () => {
    const url =
      'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs?service=WCS&version=2.0.1' +
      '&request=GetCoverage&coverageId=13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m' +
      '&subset=E(407340,407360)&subset=N(151440,151460)&format=image/tiff';
    const t = readFloatTiff(await (await fetch(url)).arrayBuffer());
    expect(t.width).toBe(20);
    // Ell Barrow, Salisbury Plain: about 184 m.
    expect(t.data[10 * 20 + 10]).toBeGreaterThan(180);
    expect(t.data[10 * 20 + 10]).toBeLessThan(188);
  }, 60000);
});

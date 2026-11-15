/**
 * A small reader for the GeoTIFFs the Environment Agency's LIDAR service
 * returns: one band of 32-bit floating-point heights, uncompressed, stored in
 * strips or tiles, in either byte order. Nothing more general is needed, so
 * no library is used.
 */

export interface FloatRaster {
  width: number;
  height: number;
  /** Row-major, row 0 at the top (north). */
  data: Float32Array;
  /** The file's "no data" value, if it gives one. */
  noData: number | null;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8, 16: 8 };

export function readFloatTiff(buf: ArrayBuffer): FloatRaster {
  const dv = new DataView(buf);
  const order = String.fromCharCode(dv.getUint8(0), dv.getUint8(1));
  if (order !== 'II' && order !== 'MM') throw new Error('Not a TIFF file');
  const le = order === 'II';
  if (dv.getUint16(2, le) !== 42) throw new Error('Unsupported TIFF (BigTIFF?)');

  const ifd = dv.getUint32(4, le);
  const count = dv.getUint16(ifd, le);
  const tags = new Map<number, { type: number; n: number; at: number }>();
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    const type = dv.getUint16(e + 2, le);
    const n = dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    tags.set(dv.getUint16(e, le), { type, n, at: size <= 4 ? e + 8 : dv.getUint32(e + 8, le) });
  }
  const nums = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) return [];
    const out: number[] = [];
    for (let i = 0; i < t.n; i++) {
      const p = t.at + i * (TYPE_SIZE[t.type] ?? 1);
      out.push(t.type === 3 ? dv.getUint16(p, le) : t.type === 4 ? dv.getUint32(p, le) : t.type === 1 ? dv.getUint8(p) : NaN);
    }
    return out;
  };
  const one = (tag: number, fallback?: number): number => {
    const v = nums(tag)[0];
    if (v === undefined) {
      if (fallback === undefined) throw new Error(`TIFF is missing tag ${tag}`);
      return fallback;
    }
    return v;
  };

  const width = one(256);
  const height = one(257);
  if (one(259, 1) !== 1) throw new Error('Compressed TIFFs are not supported');
  if (one(258, 32) !== 32 || one(339, 3) !== 3 || one(277, 1) !== 1) {
    throw new Error('Expected one band of 32-bit floating-point heights');
  }

  // "No data" value (GDAL tag 42113), stored as text.
  let noData: number | null = null;
  const nd = tags.get(42113);
  if (nd) {
    let s = '';
    for (let i = 0; i < nd.n; i++) {
      const ch = dv.getUint8(nd.at + i);
      if (ch) s += String.fromCharCode(ch);
    }
    const v = parseFloat(s);
    if (Number.isFinite(v)) noData = v;
  }

  const data = new Float32Array(width * height);
  const put = (src: number, dst: number) => (data[dst] = dv.getFloat32(src, le));

  if (tags.has(324)) {
    // Tiled.
    const tw = one(322);
    const th = one(323);
    const offsets = nums(324);
    const across = Math.ceil(width / tw);
    offsets.forEach((off, t) => {
      const r0 = Math.floor(t / across) * th;
      const c0 = (t % across) * tw;
      for (let r = 0; r < th && r0 + r < height; r++) {
        for (let c = 0; c < tw && c0 + c < width; c++) put(off + (r * tw + c) * 4, (r0 + r) * width + c0 + c);
      }
    });
  } else {
    // Stripped.
    const offsets = nums(273);
    const rowsPerStrip = one(278, height);
    offsets.forEach((off, s) => {
      for (let r = 0; r < rowsPerStrip && s * rowsPerStrip + r < height; r++) {
        for (let c = 0; c < width; c++) put(off + (r * width + c) * 4, (s * rowsPerStrip + r) * width + c);
      }
    });
  }
  return { width, height, data, noData };
}

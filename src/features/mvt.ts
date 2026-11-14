/**
 * A small reader for Mapbox Vector Tiles (the format the OS Vector Tile API
 * serves), so we need no extra library. A tile is a Protocol Buffers message:
 *
 *   Tile    { repeated Layer layers = 3; }
 *   Layer   { name = 1; repeated Feature features = 2; repeated string keys = 3;
 *             repeated Value values = 4; extent = 5; version = 15; }
 *   Feature { id = 1; packed uint32 tags = 2; type = 3; packed uint32 geometry = 4; }
 *   Value   { string = 1; float = 2; double = 3; int64 = 4; uint64 = 5; sint64 = 6; bool = 7; }
 *
 * Geometry is a list of commands (MoveTo, LineTo, ClosePath) with zig-zag
 * encoded, delta-coded coordinates in tile units (0..extent).
 * Spec: https://github.com/mapbox/vector-tile-spec (version 2.1).
 */

export type MvtValue = string | number | boolean;

export interface MvtFeature {
  /** 1 = point, 2 = line, 3 = polygon. */
  type: 1 | 2 | 3;
  properties: Record<string, MvtValue>;
  /** Parts in tile units: one per MoveTo (for polygons, each ring is a part). */
  geometry: [number, number][][];
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

/** Minimal Protocol Buffers reader. */
class Pbf {
  pos = 0;
  constructor(readonly buf: Uint8Array) {}

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const b = this.buf[this.pos++];
      // Multiply rather than shift beyond 28 bits, to stay exact in a JS number.
      result += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return result;
      shift += 7;
      if (shift > 63) throw new Error('Bad varint in vector tile');
    }
  }

  /** Read a field key: field number and wire type. */
  key(): [number, number] {
    const k = this.varint();
    return [Math.floor(k / 8), k & 7];
  }

  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  string(): string {
    return new TextDecoder().decode(this.bytes());
  }

  float(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }

  double(): number {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  /** Skip a field of the given wire type. */
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint(); // read the length first: it moves pos
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unsupported wire type ${wire} in vector tile`);
  }

  /** A packed list of varints. */
  packed(): number[] {
    const end = this.varint() + this.pos;
    const out: number[] = [];
    while (this.pos < end) out.push(this.varint());
    return out;
  }
}

const zigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function readValue(p: Pbf): MvtValue | undefined {
  const end = p.varint() + p.pos;
  let v: MvtValue | undefined;
  while (p.pos < end) {
    const [field, wire] = p.key();
    if (field === 1) v = p.string();
    else if (field === 2) v = p.float();
    else if (field === 3) v = p.double();
    else if (field === 4 || field === 5) v = p.varint();
    else if (field === 6) v = zigzag(p.varint());
    else if (field === 7) v = p.varint() !== 0;
    else p.skip(wire);
  }
  return v;
}

function decodeGeometry(cmds: number[]): [number, number][][] {
  const parts: [number, number][][] = [];
  let part: [number, number][] | null = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i++];
    const id = c & 7;
    const count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        x += zigzag(cmds[i++]);
        y += zigzag(cmds[i++]);
        if (id === 1) {
          part = [];
          parts.push(part);
        }
        part!.push([x, y]);
      }
    } else if (id === 7) {
      if (part && part.length) part.push([part[0][0], part[0][1]]);
    } else {
      throw new Error(`Unknown geometry command ${id} in vector tile`);
    }
  }
  return parts;
}

function readFeature(p: Pbf, keys: string[], values: (MvtValue | undefined)[]): MvtFeature {
  const end = p.varint() + p.pos;
  let type = 0;
  let tags: number[] = [];
  let geom: number[] = [];
  while (p.pos < end) {
    const [field, wire] = p.key();
    if (field === 2) tags = p.packed();
    else if (field === 3) type = p.varint();
    else if (field === 4) geom = p.packed();
    else p.skip(wire);
  }
  const properties: Record<string, MvtValue> = {};
  for (let k = 0; k + 1 < tags.length; k += 2) {
    const v = values[tags[k + 1]];
    if (v !== undefined) properties[keys[tags[k]]] = v;
  }
  return { type: (type || 1) as 1 | 2 | 3, properties, geometry: decodeGeometry(geom) };
}

function readLayer(p: Pbf): MvtLayer {
  const end = p.varint() + p.pos;
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: (MvtValue | undefined)[] = [];
  const featureStarts: number[] = [];
  // Keys and values can come after the features, so note where features
  // start and read them once the whole layer has been scanned.
  while (p.pos < end) {
    const [field, wire] = p.key();
    if (field === 1) name = p.string();
    else if (field === 2) {
      featureStarts.push(p.pos);
      p.skip(wire);
    } else if (field === 3) keys.push(p.string());
    else if (field === 4) values.push(readValue(p));
    else if (field === 5) extent = p.varint();
    else p.skip(wire);
  }
  const features = featureStarts.map((pos) => {
    p.pos = pos;
    return readFeature(p, keys, values);
  });
  p.pos = end;
  return { name, extent, features };
}

/** Decode a whole vector tile into its layers. */
export function decodeTile(buf: Uint8Array): MvtLayer[] {
  const p = new Pbf(buf);
  const layers: MvtLayer[] = [];
  while (p.pos < buf.length) {
    const [field, wire] = p.key();
    if (field === 3 && wire === 2) layers.push(readLayer(p));
    else p.skip(wire);
  }
  return layers;
}

/** Longitude and latitude of a point in tile units, for a Web Mercator tile z/x/y. */
export function tileToLonLat(z: number, x: number, y: number, extent: number, px: number, py: number): { lat: number; lon: number } {
  const n = 2 ** z;
  const gx = (x + px / extent) / n;
  const gy = (y + py / extent) / n;
  const lon = gx * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180) / Math.PI;
  return { lat, lon };
}

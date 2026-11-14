/**
 * Base maps: OS 1:25,000 Explorer and OS Outdoor in Great Britain,
 * OpenStreetMap everywhere.
 *
 * The OS key comes from the VITE_OS_KEY setting (file .env.local), so it is
 * not stored in the source code. Note it is still visible to anyone who
 * inspects the built app — unavoidable for a map key used in a browser.
 */
import * as maplibregl from 'maplibre-gl';
import type { SourceSpecification } from 'maplibre-gl';
import { warpBngToMercator, type RGBATile } from '../geo/osTiles';

export const OS_KEY: string = import.meta.env.VITE_OS_KEY ?? '';
const OS_ZXY = 'https://api.os.uk/maps/raster/v1/zxy';
const OS_ATTRIBUTION = `Contains OS data © Crown copyright and database rights ${new Date().getFullYear()}`;

export type BaseMapId = 'os-explorer' | 'os-outdoor' | 'osm';

export const BASE_MAPS: { id: BaseMapId; label: string; gbOnly: boolean }[] = [
  { id: 'os-explorer', label: 'OS Explorer 1:25,000 (GB)', gbOnly: true },
  { id: 'os-outdoor', label: 'OS Outdoor (GB)', gbOnly: true },
  { id: 'osm', label: 'OpenStreetMap (worldwide)', gbOnly: false },
];

export function baseMapSources(): Record<string, SourceSpecification> {
  const sources: Record<string, SourceSpecification> = {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  };
  if (OS_KEY) {
    sources['os-outdoor'] = {
      type: 'raster',
      tiles: [`${OS_ZXY}/Outdoor_3857/{z}/{x}/{y}.png?key=${OS_KEY}`],
      tileSize: 256,
      minzoom: 7,
      // Zooms 17+ are premium MasterMap; stop at 16 (free OpenData) and enlarge.
      maxzoom: 16,
      bounds: [-8.8, 49.8, 2.0, 60.9],
      attribution: OS_ATTRIBUTION,
    };
    sources['os-explorer'] = {
      type: 'raster',
      tiles: ['os27700://Leisure_27700/{z}/{x}/{y}'],
      tileSize: 256,
      minzoom: 7,
      // BNG zoom 9 (1.75 m/px) matches Web Mercator ~16; beyond that, enlarge.
      maxzoom: 16,
      bounds: [-8.8, 49.8, 2.0, 60.9],
      attribution: OS_ATTRIBUTION,
    };
  }
  return sources;
}

// ---------- OS British National Grid tiles, re-drawn for the map ----------

const tileCache = new Map<string, Promise<RGBATile | null>>();
const CACHE_LIMIT = 300;

async function decode(blob: Blob): Promise<RGBATile> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { width: img.width, height: img.height, data: img.data };
}

function fetchBngTile(layer: string, z: number, col: number, row: number): Promise<RGBATile | null> {
  const key = `${layer}/${z}/${col}/${row}`;
  let p = tileCache.get(key);
  if (!p) {
    p = fetch(`${OS_ZXY}/${layer}/${z}/${col}/${row}.png?key=${OS_KEY}`)
      .then(async (res) => (res.ok ? decode(await res.blob()) : null))
      .catch(() => null);
    tileCache.set(key, p);
    if (tileCache.size > CACHE_LIMIT) tileCache.delete(tileCache.keys().next().value!);
  }
  return p;
}

let registered = false;

/** Teach the map to load "os27700://Layer/z/x/y" by warping OS BNG tiles. */
export function registerOsProtocol() {
  if (registered || !OS_KEY) return;
  registered = true;
  maplibregl.addProtocol('os27700', async (params) => {
    const m = params.url.match(/^os27700:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/);
    if (!m) throw new Error(`Bad OS tile URL ${params.url}`);
    const [, layer, z, x, y] = m;
    const rgba = await warpBngToMercator(Number(z), Number(x), Number(y), (bz, c, r) => fetchBngTile(layer, bz, c, r));
    if (!rgba) return { data: new ArrayBuffer(0) }; // nothing here: blank tile
    const canvas = new OffscreenCanvas(256, 256);
    canvas.getContext('2d')!.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, 256, 256), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { data: await blob.arrayBuffer() };
  });
}

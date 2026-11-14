/**
 * Ground features from OS open data, through the OS Vector Tile API
 * (PO decision, DECISIONS.md 57): woods, surface water, watercourses,
 * buildings, roads and railways.
 *
 * Only zoom 14 tiles are requested. Every OS vector tile up to zoom 15 is OS
 * OpenData (OS Open Zoomstack) and free without limit; the premium MasterMap
 * layers only exist beyond that. Checked on 14 Nov 2026 (DECISIONS.md 61).
 *
 * The tiles only label each feature with a style number (`_symbol`); the
 * meanings below come from OS's own map style.
 */
import { latLonToLocal } from '../terrain/elevation';
import type { Point } from '../terrain/grid';
import { bboxAround, type FeatureKind, type FeatureSet, type MapFeature } from './osm';
import { decodeTile, tileToLonLat, type MvtFeature } from './mvt';

export const OS_VTS_TILE_URL = 'https://api.os.uk/maps/vector/v1/vts/tile/{z}/{y}/{x}.pbf?srs=3857';
/** The zoom used for analysis. Must stay at 15 or below: higher zooms are premium. */
export const OS_FEATURE_ZOOM = 14;
export const OS_ATTRIBUTION = `Contains OS data © Crown copyright and database rights ${new Date().getFullYear()}`;

/** OS layer and symbol → engine feature kind. Unlisted symbols are ignored. */
export function osKind(layer: string, symbol: number | undefined): FeatureKind | null {
  switch (layer) {
    case 'Roads':
      if (symbol === undefined) return null;
      if (symbol <= 2) return 'motorway';
      if (symbol <= 9) return 'major-road'; // primary, A and B roads
      if (symbol <= 14) return 'minor-road'; // minor and local roads
      if (symbol <= 16) return 'track'; // restricted-access roads
      return null; // guided busways, tunnels
    case 'Railways':
      return symbol !== undefined && symbol <= 2 ? 'railway' : null; // 3 = tunnel
    case 'Woodland:3':
      return symbol === 0 ? 'wood' : null; // local-scale woodland
    case 'Surfacewater':
      return symbol === 0 ? 'water' : null;
    case 'Waterlines':
      return symbol === 1 ? 'stream' : null; // local watercourses (not tide lines)
    case 'Local_buildings':
      return 'building';
    default:
      return null;
  }
}

/** Web Mercator tile covering a point. */
function tileOf(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  return { x, y };
}

/** Unpack a gzip body if the server sent one without saying so. */
async function maybeGunzip(buf: Uint8Array): Promise<Uint8Array> {
  if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
  const stream = new Blob([buf as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Convert the features of one decoded tile to engine features in local metres. */
export function featuresFromTile(
  layers: ReturnType<typeof decodeTile>,
  z: number,
  tx: number,
  ty: number,
  centre: { lat: number; lon: number },
): MapFeature[] {
  const out: MapFeature[] = [];
  for (const layer of layers) {
    for (const f of layer.features) {
      const sym = f.properties._symbol;
      const kind = osKind(layer.name, typeof sym === 'number' ? sym : undefined);
      if (!kind) continue;
      const shape = f.type === 3 ? 'area' : f.type === 2 ? 'line' : null;
      if (!shape) continue;
      out.push({
        kind,
        shape,
        rings: toLocal(f, layer.extent, z, tx, ty, centre),
        osmId: `os/${layer.name}`,
      });
    }
  }
  return out;
}

function toLocal(f: MvtFeature, extent: number, z: number, tx: number, ty: number, centre: { lat: number; lon: number }): Point[][] {
  return f.geometry.map((part) =>
    part.map(([px, py]) => {
      const ll = tileToLonLat(z, tx, ty, extent, px, py);
      return latLonToLocal(centre, ll.lat, ll.lon);
    }),
  );
}

/** Fetch OS open-data features for a square box. `fetchImpl` is injectable for tests. */
export async function fetchOsFeatures(
  centre: { lat: number; lon: number },
  sizeM: number,
  key: string,
  opts: { fetchImpl?: typeof fetch; zoom?: number } = {},
): Promise<FeatureSet> {
  const f = opts.fetchImpl ?? fetch;
  const z = Math.min(opts.zoom ?? OS_FEATURE_ZOOM, 15); // never a premium zoom
  const b = bboxAround(centre, sizeM);
  const nw = tileOf(b.north, b.west, z);
  const se = tileOf(b.south, b.east, z);
  const jobs: Promise<MapFeature[]>[] = [];
  for (let x = nw.x; x <= se.x; x++) {
    for (let y = nw.y; y <= se.y; y++) {
      const url = OS_VTS_TILE_URL.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`) + `&key=${encodeURIComponent(key)}`;
      jobs.push(
        f(url).then(async (res) => {
          if (res.status === 404 || res.status === 204) return []; // nothing here (e.g. at sea)
          if (!res.ok) {
            throw new Error(
              res.status === 401 ? 'the OS key is not enabled for the OS Vector Tile API' : `OS replied ${res.status}`,
            );
          }
          const buf = await maybeGunzip(new Uint8Array(await res.arrayBuffer()));
          return featuresFromTile(decodeTile(buf), z, x, y, centre);
        }),
      );
    }
  }
  const features = (await Promise.all(jobs)).flat();
  return { features, source: 'OS open data (OS Vector Tile API)', attribution: OS_ATTRIBUTION };
}

/** Kinds taken from OpenStreetMap when OS open data is used for the rest. */
export const OSM_ONLY_KINDS: FeatureKind[] = ['path', 'track', 'hedge', 'wall'];

export interface CombinedFeatures {
  set: FeatureSet;
  /** Plain-English account of where the features came from, and anything that failed. */
  sources: string[];
}

/**
 * Features for a box. In Great Britain, with an OS key: OS open data for
 * woods, water, buildings, roads and railways, plus OpenStreetMap for paths,
 * tracks and hedges. Otherwise (or if OS fails): everything from OpenStreetMap.
 */
export async function fetchCombinedFeatures(
  centre: { lat: number; lon: number },
  sizeM: number,
  opts: {
    osKey: string;
    inGB: boolean;
    fetchOsm: (pathsAndHedgesOnly: boolean) => Promise<FeatureSet>;
    fetchImpl?: typeof fetch;
  },
): Promise<CombinedFeatures> {
  const sources: string[] = [];
  if (opts.osKey && opts.inGB) {
    const [os, osm] = await Promise.allSettled([
      fetchOsFeatures(centre, sizeM, opts.osKey, { fetchImpl: opts.fetchImpl }),
      opts.fetchOsm(true),
    ]);
    if (os.status === 'fulfilled') {
      const features = [...os.value.features];
      sources.push('Woods, water, buildings, roads and railways: OS open data.');
      if (osm.status === 'fulfilled') {
        features.push(...osm.value.features.filter((x) => OSM_ONLY_KINDS.includes(x.kind)));
        sources.push('Paths, tracks and hedges: OpenStreetMap.');
      } else {
        sources.push(`Paths, tracks and hedges could not be loaded from OpenStreetMap (${reason(osm.reason)}).`);
      }
      return {
        set: { features, source: 'OS open data and OpenStreetMap', attribution: `${OS_ATTRIBUTION}; © OpenStreetMap contributors` },
        sources,
      };
    }
    sources.push(`OS open data could not be loaded (${reason(os.reason)}), so everything comes from OpenStreetMap.`);
  }
  const all = await opts.fetchOsm(false);
  sources.push('All features: OpenStreetMap.');
  return { set: all, sources };
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

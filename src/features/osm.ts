/**
 * Ground features from OpenStreetMap (roads, tracks, paths, woods, water,
 * buildings, railways, military areas), fetched with the Overpass API and
 * converted to the engine's local metric coordinates.
 *
 * This module only knows about OSM tags. What a feature *means* tactically
 * (going, cover, obstacle, exclusion) is decided in `layers.ts`.
 */
import type { Point } from '../terrain/grid';
import { latLonToLocal, localToLatLon } from '../terrain/elevation';

/** The kinds of feature the engine understands. */
export type FeatureKind =
  // Lines
  | 'motorway' // motorway or trunk road (exclusion for stands; good going)
  | 'major-road' // A and B roads
  | 'minor-road' // unclassified, residential, service roads
  | 'track' // farm and forest tracks (vehicle going)
  | 'path' // footpaths, bridleways, byways (foot access)
  | 'railway'
  | 'river' // a watercourse wide enough to be an obstacle
  | 'stream' // small watercourse (minor obstacle)
  | 'hedge'
  | 'wall'
  | 'cliff'
  // Areas
  | 'wood'
  | 'scrub'
  | 'water'
  | 'wetland'
  | 'built-up'
  | 'building'
  | 'military' // military land, ranges and danger areas (exclusion)
  | 'access-land'; // open-access land (stands may go here)

export interface MapFeature {
  kind: FeatureKind;
  /** 'line' for linear features, 'area' for polygons. */
  shape: 'line' | 'area';
  /**
   * For lines: one or more polylines. For areas: rings, outer and inner
   * (holes) together; a cell is inside if it is inside an odd number of rings.
   */
  rings: Point[][];
  /** True if a path or road is a public right of way or has public access. */
  publicAccess?: boolean;
  /** True for a road or path carried over water (a bridge). */
  bridge?: boolean;
  /** True for a road, path or railway that runs underground (a tunnel). */
  tunnel?: boolean;
  /** OSM name, if any (useful for problem text). */
  name?: string;
  /** OSM id, for debugging and attribution. */
  osmId: string;
}

export interface FeatureSet {
  features: MapFeature[];
  source: string;
  attribution: string;
}

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** A lat/lon bounding box: south, west, north, east. */
export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The lat/lon box covering a square of `sizeM` metres centred on `centre`. */
export function bboxAround(centre: { lat: number; lon: number }, sizeM: number): BBox {
  const h = sizeM / 2;
  const sw = localToLatLon(centre, -h, -h);
  const ne = localToLatLon(centre, h, h);
  return { south: sw.lat, west: sw.lon, north: ne.lat, east: ne.lon };
}

/**
 * The Overpass query for every tag the engine uses. `out geom` returns the
 * coordinates inline, so no second request is needed.
 */
export function overpassQuery(b: BBox, timeoutS = 60): string {
  const box = `(${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)})`;
  return [
    `[out:json][timeout:${timeoutS}];`,
    '(',
    `  way["highway"]${box};`,
    `  way["railway"~"^(rail|light_rail|narrow_gauge|disused|abandoned)$"]${box};`,
    `  way["waterway"]${box};`,
    `  way["natural"~"^(wood|scrub|heath|water|wetland|cliff)$"]${box};`,
    `  relation["natural"~"^(wood|water|wetland)$"]${box};`,
    `  way["landuse"~"^(forest|military|residential|industrial|commercial|retail|reservoir|basin)$"]${box};`,
    `  relation["landuse"~"^(forest|military|residential|industrial)$"]${box};`,
    `  way["military"]${box};`,
    `  relation["military"]${box};`,
    `  way["building"]${box};`,
    `  way["barrier"~"^(hedge|wall|city_wall)$"]${box};`,
    `  way["designation"="access_land"]${box};`,
    `  relation["designation"="access_land"]${box};`,
    ');',
    'out geom;',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parsing Overpass JSON

interface OverpassNode {
  lat: number;
  lon: number;
}
interface OverpassMember {
  type: string;
  role: string;
  geometry?: OverpassNode[];
}
interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: (OverpassNode | null)[];
  members?: OverpassMember[];
}
export interface OverpassResponse {
  elements: OverpassElement[];
}

const PUBLIC_DESIGNATIONS = /public_footpath|public_bridleway|byway|restricted_byway|public_right_of_way|core_path/;

/** Is this way a public right of way, or open to the public? */
function isPublic(t: Record<string, string>): boolean {
  if (t.designation && PUBLIC_DESIGNATIONS.test(t.designation)) return true;
  if (t.prow_ref) return true;
  const access = t.foot ?? t.access;
  if (access === 'private' || access === 'no' || access === 'customers') return false;
  if (access === 'yes' || access === 'designated' || access === 'permissive') return true;
  // Ordinary public roads are public unless tagged otherwise.
  if (/^(trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$/.test(t.highway ?? '')) {
    return true;
  }
  return false;
}

/** Map one element's tags to the kinds of feature it represents (often none). */
export function kindsFor(t: Record<string, string>, closed: boolean): { kind: FeatureKind; shape: 'line' | 'area' }[] {
  const out: { kind: FeatureKind; shape: 'line' | 'area' }[] = [];
  const hw = t.highway;
  if (hw) {
    if (/^(motorway|trunk)(_link)?$/.test(hw)) out.push({ kind: 'motorway', shape: 'line' });
    else if (/^(primary|secondary)(_link)?$/.test(hw)) out.push({ kind: 'major-road', shape: 'line' });
    else if (/^(tertiary|unclassified|residential|living_street|service)(_link)?$/.test(hw))
      out.push({ kind: 'minor-road', shape: 'line' });
    else if (hw === 'track') out.push({ kind: 'track', shape: 'line' });
    else if (/^(path|footway|bridleway|cycleway|steps|pedestrian)$/.test(hw)) out.push({ kind: 'path', shape: 'line' });
    else if (hw === 'byway') out.push({ kind: 'track', shape: 'line' });
  }
  if (t.railway && /^(rail|light_rail|narrow_gauge)$/.test(t.railway)) out.push({ kind: 'railway', shape: 'line' });

  const ww = t.waterway;
  if (ww === 'river' || ww === 'canal') out.push({ kind: 'river', shape: 'line' });
  else if (ww === 'stream' || ww === 'drain' || ww === 'ditch') out.push({ kind: 'stream', shape: 'line' });
  else if (ww === 'riverbank' && closed) out.push({ kind: 'water', shape: 'area' });

  if (t.barrier === 'hedge') out.push({ kind: 'hedge', shape: 'line' });
  if (t.barrier === 'wall' || t.barrier === 'city_wall') out.push({ kind: 'wall', shape: 'line' });
  if (t.natural === 'cliff') out.push({ kind: 'cliff', shape: 'line' });

  if (closed) {
    if (t.natural === 'wood' || t.landuse === 'forest') out.push({ kind: 'wood', shape: 'area' });
    else if (t.natural === 'scrub' || t.natural === 'heath') out.push({ kind: 'scrub', shape: 'area' });
    if (t.natural === 'water' || t.landuse === 'reservoir' || t.landuse === 'basin') out.push({ kind: 'water', shape: 'area' });
    if (t.natural === 'wetland') out.push({ kind: 'wetland', shape: 'area' });
    if (/^(residential|industrial|commercial|retail)$/.test(t.landuse ?? '')) out.push({ kind: 'built-up', shape: 'area' });
    if (t.building && t.building !== 'no') out.push({ kind: 'building', shape: 'area' });
    if (t.landuse === 'military' || (t.military && t.military !== 'no')) out.push({ kind: 'military', shape: 'area' });
    if (t.designation === 'access_land') out.push({ kind: 'access-land', shape: 'area' });
  }
  return out;
}

function toLocal(centre: { lat: number; lon: number }, nodes: (OverpassNode | null)[]): Point[] {
  const pts: Point[] = [];
  for (const n of nodes) if (n) pts.push(latLonToLocal(centre, n.lat, n.lon));
  return pts;
}

function isClosed(nodes: (OverpassNode | null)[] | undefined): boolean {
  if (!nodes || nodes.length < 4) return false;
  const a = nodes[0];
  const b = nodes[nodes.length - 1];
  return !!a && !!b && a.lat === b.lat && a.lon === b.lon;
}

/**
 * Join the member ways of a multipolygon relation into closed rings. OSM often
 * splits a ring across several ways, which must be joined end to end.
 */
function assembleRings(parts: OverpassNode[][]): OverpassNode[][] {
  const same = (a: OverpassNode, b: OverpassNode) => a.lat === b.lat && a.lon === b.lon;
  const open = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  const rings: OverpassNode[][] = [];
  while (open.length) {
    let ring = open.shift()!;
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        const end = ring[ring.length - 1];
        if (same(end, p[0])) ring = ring.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) ring = ring.concat([...p].reverse().slice(1));
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    // Keep rings even if not perfectly closed (clipped at the query edge):
    // the point-in-polygon test closes them implicitly.
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Convert an Overpass response into features in local metres around `centre`. */
export function parseOverpass(json: OverpassResponse, centre: { lat: number; lon: number }): FeatureSet {
  const features: MapFeature[] = [];
  for (const el of json.elements) {
    const t = el.tags ?? {};
    if (el.type === 'way' && el.geometry) {
      const closed = isClosed(el.geometry);
      // An area tag on a closed way makes it an area; highways and waterways
      // stay lines unless they are explicitly areas.
      for (const { kind, shape } of kindsFor(t, closed)) {
        features.push({
          kind,
          shape,
          rings: [toLocal(centre, el.geometry)],
          publicAccess: shape === 'line' ? isPublic(t) : undefined,
          bridge: t.bridge !== undefined && t.bridge !== 'no' ? true : undefined,
          tunnel: t.tunnel !== undefined && t.tunnel !== 'no' ? true : undefined,
          name: t.name,
          osmId: `way/${el.id}`,
        });
      }
    } else if (el.type === 'relation' && el.members) {
      const parts = el.members
        .filter((m) => m.type === 'way' && m.geometry && (m.role === 'outer' || m.role === 'inner' || m.role === ''))
        .map((m) => m.geometry!.filter((n): n is OverpassNode => !!n));
      const rings = assembleRings(parts).map((r) => toLocal(centre, r));
      if (!rings.length) continue;
      for (const { kind, shape } of kindsFor(t, true)) {
        if (shape !== 'area') continue;
        features.push({ kind, shape, rings, name: t.name, osmId: `relation/${el.id}` });
      }
    }
  }
  return { features, source: 'OpenStreetMap (Overpass API)', attribution: OSM_ATTRIBUTION };
}

/** Fetch features for a square box from Overpass. `fetchImpl` is injectable for tests. */
export async function fetchFeatures(
  centre: { lat: number; lon: number },
  sizeM: number,
  opts: { url?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<FeatureSet> {
  const f = opts.fetchImpl ?? fetch;
  const body = new URLSearchParams({ data: overpassQuery(bboxAround(centre, sizeM)) });
  const res = await f(opts.url ?? OVERPASS_URL, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(
      res.status === 429 || res.status === 504
        ? 'The OpenStreetMap feature server is busy. Try again in a minute.'
        : `Could not load map features (server replied ${res.status}).`,
    );
  }
  return parseOverpass((await res.json()) as OverpassResponse, centre);
}

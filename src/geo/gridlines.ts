/**
 * 1 km grid lines for the map, in the same system as the grid references:
 * British National Grid in Great Britain, UTM (MGRS) elsewhere.
 * Lines of constant easting or northing are slightly curved in latitude and
 * longitude, so each is drawn as a series of short pieces.
 */
import { fromBNG, fromUTM, inGreatBritain, toBNG, toUTM } from './gridref';

export interface LatLonBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

type Feature = {
  type: 'Feature';
  properties: Record<string, string | number | boolean>;
  geometry: { type: 'LineString'; coordinates: number[][] } | { type: 'Point'; coordinates: number[] };
};

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

export function gridLines(box: LatLonBox, spacingM = 1000): FeatureCollection {
  const midLat = (box.south + box.north) / 2;
  const midLon = (box.west + box.east) / 2;
  const useBNG = inGreatBritain(midLat, midLon);

  let forward: (lat: number, lon: number) => { e: number; n: number };
  let inverse: (e: number, n: number) => { lat: number; lon: number };
  if (useBNG) {
    forward = (lat, lon) => {
      const r = toBNG(lat, lon);
      return { e: r.easting, n: r.northing };
    };
    inverse = fromBNG;
  } else {
    const ref = toUTM(midLat, midLon);
    forward = (lat, lon) => {
      // Stay in the box centre's zone so the lines are continuous.
      const r = toUTM(lat, lon);
      if (r.zone === ref.zone) return { e: r.easting, n: r.northing };
      return { e: NaN, n: NaN };
    };
    inverse = (e, n) => fromUTM({ zone: ref.zone, hemisphere: ref.hemisphere, easting: e, northing: n });
  }

  const corners = [
    forward(box.south, box.west),
    forward(box.south, box.east),
    forward(box.north, box.west),
    forward(box.north, box.east),
  ].filter((c) => Number.isFinite(c.e));
  const minE = Math.min(...corners.map((c) => c.e));
  const maxE = Math.max(...corners.map((c) => c.e));
  const minN = Math.min(...corners.map((c) => c.n));
  const maxN = Math.max(...corners.map((c) => c.n));

  const features: Feature[] = [];
  const steps = 20;
  const label = (v: number) => String(Math.floor(v / 1000) % 100).padStart(2, '0');

  for (let e = Math.ceil(minE / spacingM) * spacingM; e <= maxE; e += spacingM) {
    const coords: number[][] = [];
    for (let i = 0; i <= steps; i++) {
      const p = inverse(e, minN + ((maxN - minN) * i) / steps);
      coords.push([p.lon, p.lat]);
    }
    features.push({ type: 'Feature', properties: { kind: 'easting', label: label(e) }, geometry: { type: 'LineString', coordinates: coords } });
  }
  for (let n = Math.ceil(minN / spacingM) * spacingM; n <= maxN; n += spacingM) {
    const coords: number[][] = [];
    for (let i = 0; i <= steps; i++) {
      const p = inverse(minE + ((maxE - minE) * i) / steps, n);
      coords.push([p.lon, p.lat]);
    }
    features.push({ type: 'Feature', properties: { kind: 'northing', label: label(n) }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { type: 'FeatureCollection', features };
}

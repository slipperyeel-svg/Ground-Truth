/**
 * Turns engine results into things MapLibre can draw: raster images for the
 * hillshade and viewshed, GeoJSON for contours and the box outline.
 */
import { localToLatLon } from '../terrain/elevation';
import type { ContourLine } from '../terrain/contours';

export interface BoxGeo {
  centre: { lat: number; lon: number };
  halfM: number;
}

/** Corner coordinates in the order MapLibre's image source wants: TL, TR, BR, BL. */
export function boxCorners(b: BoxGeo): [[number, number], [number, number], [number, number], [number, number]] {
  const c = (x: number, y: number): [number, number] => {
    const p = localToLatLon(b.centre, x, y);
    return [p.lon, p.lat];
  };
  const h = b.halfM;
  return [c(-h, h), c(h, h), c(h, -h), c(-h, -h)];
}

export function toDataURL(width: number, height: number, rgba: Uint8ClampedArray): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

/**
 * Hillshade as a see-through layer: flat ground is clear, slopes facing away
 * from the light are shaded and slopes facing it are lightly highlighted, so
 * the base map still shows through.
 */
export function hillshadeImage(width: number, height: number, hs: Uint8ClampedArray, sunAltitudeDeg = 45): string {
  const flat = 255 * Math.sin((sunAltitudeDeg * Math.PI) / 180); // brightness of level ground
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < hs.length; i++) {
    const d = hs[i] - flat;
    if (d < 0) {
      rgba.set([20, 25, 15, Math.min(220, (-d / flat) * 400)], i * 4); // shadow
    } else {
      rgba.set([255, 255, 245, Math.min(140, (d / (255 - flat)) * 160)], i * 4); // highlight
    }
  }
  return toDataURL(width, height, rgba);
}

/**
 * Viewshed: green where the target can be seen, red where it is in range but
 * hidden (dead ground), clear beyond range.
 */
export function viewshedImage(
  width: number,
  height: number,
  cellM: number,
  mask: Uint8Array,
  observer: { x: number; y: number },
  rangeM: number,
): string {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const half = (width * cellM) / 2;
  for (let row = 0; row < height; row++) {
    const y = half - (row + 0.5) * cellM;
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      const x = (col + 0.5) * cellM - half;
      if (Math.hypot(x - observer.x, y - observer.y) > rangeM) continue;
      if (mask[i]) rgba.set([40, 160, 70, 105], i * 4);
      else rgba.set([200, 40, 40, 120], i * 4);
    }
  }
  return toDataURL(width, height, rgba);
}

export function contoursGeoJSON(lines: ContourLine[], centre: { lat: number; lon: number }) {
  return {
    type: 'FeatureCollection' as const,
    features: lines.map((l) => ({
      type: 'Feature' as const,
      properties: { height: l.heightM, index: l.index, label: `${Math.round(l.heightM)}` },
      geometry: {
        type: 'LineString' as const,
        coordinates: l.points.map((p) => {
          const ll = localToLatLon(centre, p.x, p.y);
          return [ll.lon, ll.lat];
        }),
      },
    })),
  };
}

export function boxOutlineGeoJSON(b: BoxGeo) {
  const c = boxCorners(b);
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates: [...c, c[0]] },
  };
}

export function pointGeoJSON(lon: number, lat: number, props: Record<string, unknown> = {}) {
  return { type: 'Feature' as const, properties: props, geometry: { type: 'Point' as const, coordinates: [lon, lat] } };
}

export const EMPTY = { type: 'FeatureCollection' as const, features: [] };

// ---------- tactical problem ----------
type LL = { lat: number; lon: number };
const ll = (centre: LL, p: { x: number; y: number }): [number, number] => {
  const q = localToLatLon(centre, p.x, p.y);
  return [q.lon, q.lat];
};

/** NAI circle and the enemy's expected route, shown with the problem. */
export function problemGeoJSON(centre: LL, nai: { centre: { x: number; y: number }; radiusM: number }, route: { x: number; y: number }[]) {
  const ring: [number, number][] = [];
  for (let k = 0; k <= 48; k++) {
    const a = (k / 48) * 2 * Math.PI;
    ring.push(ll(centre, { x: nai.centre.x + nai.radiusM * Math.sin(a), y: nai.centre.y + nai.radiusM * Math.cos(a) }));
  }
  return {
    type: 'FeatureCollection' as const,
    features: [
      { type: 'Feature' as const, properties: { kind: 'nai', label: 'NAI 1' }, geometry: { type: 'Polygon' as const, coordinates: [ring] } },
      { type: 'Feature' as const, properties: { kind: 'route' }, geometry: { type: 'LineString' as const, coordinates: route.map((p) => ll(centre, p)) } },
    ],
  };
}

/** The DS solution: enemy OPs, the best and alternative OPs, gun areas and the line of communication. */
export function dsGeoJSON(
  centre: LL,
  ds: { enemyOps: { x: number; y: number }[]; bestOP?: { x: number; y: number }; altOP?: { x: number; y: number };
    concealedOP?: { x: number; y: number }; gunAreas: { x: number; y: number }[]; loc?: { x: number; y: number }[] },
) {
  const pt = (p: { x: number; y: number }, kind: string, label: string) => ({
    type: 'Feature' as const,
    properties: { kind, label },
    geometry: { type: 'Point' as const, coordinates: ll(centre, p) },
  });
  const features: object[] = [];
  ds.enemyOps.forEach((p, k) => features.push(pt(p, 'enemy', `En OP ${k + 1}`)));
  if (ds.bestOP) features.push(pt(ds.bestOP, 'own', 'Best view'));
  if (ds.altOP) features.push(pt(ds.altOP, 'own', 'Alternative'));
  if (ds.concealedOP && ds.concealedOP !== ds.altOP) features.push(pt(ds.concealedOP, 'own', 'Unseen'));
  ds.gunAreas.forEach((p, k) => features.push(pt(p, 'guns', `Gun area ${k + 1}`)));
  if (ds.loc) {
    features.push({
      type: 'Feature',
      properties: { kind: 'loc' },
      geometry: { type: 'LineString', coordinates: ds.loc.map((p) => ll(centre, p)) },
    });
  }
  return { type: 'FeatureCollection' as const, features };
}

// ---------- enemy section ----------

/** Enemy fire teams, other possible positions and the attacker's route. */
export function sectionGeoJSON(
  centre: LL,
  ds: { teams: { label: string; point: { x: number; y: number }; gun: boolean; outpost?: boolean }[]; alternatives: { x: number; y: number }[]; route: { x: number; y: number }[] },
) {
  const features: object[] = [
    { type: 'Feature', properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: ds.route.map((p) => ll(centre, p)) } },
  ];
  for (const t of ds.teams) {
    features.push({ type: 'Feature', properties: { kind: t.outpost ? 'outpost' : t.gun ? 'gun' : 'team', label: t.label }, geometry: { type: 'Point', coordinates: ll(centre, t.point) } });
  }
  ds.alternatives.forEach((p, k) =>
    features.push({ type: 'Feature', properties: { kind: 'alt', label: `Alt ${k + 1}` }, geometry: { type: 'Point', coordinates: ll(centre, p) } }),
  );
  return { type: 'FeatureCollection' as const, features };
}

/** Ground covered by the section's fire (orange) and dead ground in front (blue). */
export function sectionZonesImage(width: number, height: number, killZone: Uint8Array, deadGround: Uint8Array): string {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    if (deadGround[i]) rgba.set([40, 90, 220, 120], i * 4);
    else if (killZone[i]) rgba.set([230, 90, 0, 95], i * 4);
  }
  return toDataURL(width, height, rgba);
}

// ---------- enemy company ----------

type P = { x: number; y: number };
/** Platoon areas, positions, the gap and the attacker's routes. */
export function companyGeoJSON(
  centre: LL,
  v: {
    platoons: { name: string; role: string; outline: P[]; positions: { kind: string; label: string; point: P }[] }[];
    hq?: { label: string; point: P } | null;
    dummies?: { label: string; point: P }[];
    gaps?: { centre: P; widthM: number }[];
    routes?: P[][];
  },
) {
  const features: object[] = [];
  for (const r of v.routes ?? []) {
    features.push({ type: 'Feature', properties: { kind: 'route' }, geometry: { type: 'LineString', coordinates: r.map((p) => ll(centre, p)) } });
  }
  for (const p of v.platoons) {
    const ring = [...p.outline, p.outline[0]].map((q) => ll(centre, q));
    features.push({ type: 'Feature', properties: { kind: 'area', label: `${p.name} (${p.role})` }, geometry: { type: 'Polygon', coordinates: [ring] } });
    for (const x of p.positions) {
      features.push({ type: 'Feature', properties: { kind: x.kind, label: x.label.replace(`${p.name} `, '') }, geometry: { type: 'Point', coordinates: ll(centre, x.point) } });
    }
  }
  if (v.hq) features.push({ type: 'Feature', properties: { kind: 'hq', label: v.hq.label }, geometry: { type: 'Point', coordinates: ll(centre, v.hq.point) } });
  for (const d of v.dummies ?? []) {
    features.push({ type: 'Feature', properties: { kind: 'dummy', label: d.label }, geometry: { type: 'Point', coordinates: ll(centre, d.point) } });
  }
  for (const g of v.gaps ?? []) {
    features.push({ type: 'Feature', properties: { kind: 'gap', label: `Gap ~${Math.round(g.widthM / 10) * 10} m` }, geometry: { type: 'Point', coordinates: ll(centre, g.centre) } });
  }
  return { type: 'FeatureCollection' as const, features };
}

/** Company fire (orange; darker where two or more positions' arcs interlock), dead ground in front (blue) and mines (red stripes). */
export function companyZonesImage(width: number, height: number, killZone: Uint8Array, deadGround: Uint8Array, mines: Uint8Array | null): string {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let r = 0; r < height; r++)
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (mines && mines[i] && (r + c) % 4 < 2) rgba.set([200, 0, 0, 200], i * 4);
      else if (deadGround[i]) rgba.set([40, 90, 220, 120], i * 4);
      else if (killZone[i] >= 2) rgba.set([200, 60, 0, 140], i * 4);
      else if (killZone[i]) rgba.set([230, 90, 0, 70], i * 4);
    }
  return toDataURL(width, height, rgba);
}

// ---------- infantry scenario ----------

/** The obvious route (red, dashed), the best covered route (green) and the objective (blue ring). */
export function scenarioGeoJSON(
  centre: LL,
  s: { objective: P; direct: { path: P[] } | null; covered: { path: P[] } | null },
) {
  const features: object[] = [
    { type: 'Feature', properties: { kind: 'objective', label: 'Objective' }, geometry: { type: 'Point', coordinates: ll(centre, s.objective) } },
  ];
  if (s.direct) features.push({ type: 'Feature', properties: { kind: 'direct' }, geometry: { type: 'LineString', coordinates: s.direct.path.map((p) => ll(centre, p)) } });
  if (s.covered) features.push({ type: 'Feature', properties: { kind: 'covered' }, geometry: { type: 'LineString', coordinates: s.covered.path.map((p) => ll(centre, p)) } });
  return { type: 'FeatureCollection' as const, features };
}

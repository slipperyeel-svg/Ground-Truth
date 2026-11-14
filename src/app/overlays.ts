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

function toDataURL(width: number, height: number, rgba: Uint8ClampedArray): string {
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

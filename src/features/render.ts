/**
 * Draw the features the engine has captured as a see-through picture for the
 * map, so the PO can check them against the ground: woods, scrub, water,
 * marsh, built-up areas, buildings, roads, tracks, paths, rivers and streams,
 * railways and hedges. Pure code (no canvas), so it runs in the worker.
 */
import { COVER, ROUTE, type FeatureLayers } from './layers';

type RGBA = [number, number, number, number];

/** Colours, also used for the legend in the page. */
export const FEATURE_COLOURS = {
  wood: [46, 125, 50, 120] as RGBA,
  scrub: [150, 160, 60, 90] as RGBA,
  water: [30, 110, 220, 170] as RGBA,
  wetland: [90, 160, 200, 120] as RGBA,
  builtUp: [120, 120, 120, 90] as RGBA,
  building: [60, 60, 60, 200] as RGBA,
  majorRoad: [220, 90, 20, 230] as RGBA,
  minorRoad: [235, 190, 30, 230] as RGBA,
  track: [140, 90, 40, 220] as RGBA,
  path: [200, 0, 200, 220] as RGBA,
  river: [20, 80, 200, 230] as RGBA,
  railway: [20, 20, 20, 230] as RGBA,
  hedge: [20, 90, 30, 220] as RGBA,
};

export function featureImage(width: number, height: number, L: FeatureLayers): Uint8ClampedArray {
  const C = FEATURE_COLOURS;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let c: RGBA | null = null;
    switch (L.cover[i]) {
      case COVER.wood: c = C.wood; break;
      case COVER.scrub: c = C.scrub; break;
      case COVER.water: c = C.water; break;
      case COVER.wetland: c = C.wetland; break;
      case COVER.builtUp: c = C.builtUp; break;
      case COVER.building: c = C.building; break;
    }
    // Lines on top of areas.
    if (L.hedge[i]) c = C.hedge;
    if (L.river[i] || L.stream[i]) c = C.river;
    if (L.railway[i]) c = C.railway;
    const r = L.route[i];
    if (r >= ROUTE.majorRoad) c = C.majorRoad;
    else if (r === ROUTE.minorRoad) c = C.minorRoad;
    else if (r === ROUTE.track) c = C.track;
    else if (r === ROUTE.path) c = C.path;
    if (c) out.set(c, i * 4);
  }
  return out;
}

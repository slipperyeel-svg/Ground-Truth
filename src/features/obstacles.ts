/**
 * Obstacles to sight: woods, buildings and hedges, with heights set by the PO
 * (DECISIONS.md 66): woods 15 m, buildings 8 m, hedges 2 m. You can see 15 m
 * into a wood from its edge and no further.
 *
 * The default elevation data is a surface model, so a large wood may already
 * be partly "in" the ground heights. To avoid counting the trees twice, the
 * top of a wood is put at 15 m above the ground level at the wood's edge
 * (the height of the nearest open ground), or at the data's own height if
 * that is already higher.
 */
import type { Grid, Mask } from '../terrain/grid';
import type { Obstacles } from '../terrain/viewshed';
import { COVER, type FeatureLayers } from './layers';

export type { Obstacles };

export const OBSTACLE_HEIGHTS = { woodM: 15, buildingM: 8, hedgeM: 2, seeIntoWoodM: 15 };

/**
 * Ground level under each wood cell, estimated from the nearest open ground:
 * a breadth-first spread inwards from the wood's edge.
 */
function groundUnderWoods(g: Grid, wood: Mask): Float32Array {
  const { width: w, height: h } = g;
  const base = new Float32Array(g.data);
  const done = new Uint8Array(w * h);
  let frontier: number[] = [];
  for (let i = 0; i < w * h; i++) if (!wood[i]) done[i] = 1;
  // Start from wood cells that touch open ground.
  for (let i = 0; i < w * h; i++) {
    if (done[i]) continue;
    const r = (i / w) | 0;
    const c = i - r * w;
    if ((c > 0 && done[i - 1]) || (c < w - 1 && done[i + 1]) || (r > 0 && done[i - w]) || (r < h - 1 && done[i + w])) frontier.push(i);
  }
  while (frontier.length) {
    const next: number[] = [];
    const settled: [number, number][] = [];
    for (const i of frontier) {
      if (done[i]) continue;
      const r = (i / w) | 0;
      const c = i - r * w;
      let sum = 0;
      let n = 0;
      for (const j of [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, r > 0 ? i - w : -1, r < h - 1 ? i + w : -1]) {
        if (j < 0) continue;
        if (done[j]) {
          sum += base[j];
          n++;
        } else next.push(j);
      }
      if (n) settled.push([i, sum / n]);
    }
    for (const [i, v] of settled) {
      base[i] = v;
      done[i] = 1;
    }
    frontier = next;
  }
  return base;
}

/**
 * Obstacles for a grid. With LIDAR (`surfaceM`, the measured height of
 * whatever stands on each cell), those real heights are used everywhere and
 * the map features only mark which cells are woods (for the "see 15 m in"
 * rule). Without LIDAR, the standard heights are applied to the mapped woods,
 * buildings and hedges.
 */
export function buildObstacles(g: Grid, L: FeatureLayers | null, surfaceM?: Float32Array, H = OBSTACLE_HEIGHTS): Obstacles {
  const n = g.width * g.height;
  const heightM = new Float32Array(n);
  const wood = new Uint8Array(n);
  if (L) for (let i = 0; i < n; i++) if (L.cover[i] === COVER.wood) wood[i] = 1;
  if (surfaceM && surfaceM.length === n) {
    heightM.set(surfaceM);
    return { heightM, wood, seeIntoWoodM: H.seeIntoWoodM };
  }
  if (!L) return { heightM, wood, seeIntoWoodM: H.seeIntoWoodM };
  const base = groundUnderWoods(g, wood);
  for (let i = 0; i < n; i++) {
    if (wood[i]) heightM[i] = Math.max(0, base[i] + H.woodM - g.data[i]);
    else if (L.cover[i] === COVER.building) heightM[i] = H.buildingM;
    else if (L.hedge[i]) heightM[i] = H.hedgeM;
  }
  return { heightM, wood, seeIntoWoodM: H.seeIntoWoodM };
}

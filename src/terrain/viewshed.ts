/**
 * Line of sight, viewsheds and dead ground.
 *
 * Method: radial line-of-sight sweep. From the observer we cast a ray to every
 * cell on the perimeter of a square of side 2 × range. Walking out along each
 * ray we keep the steepest elevation angle (as a gradient, height/distance) of
 * the ground seen so far. A cell is visible if the angle to (ground + target
 * height) is at least that running maximum. Rays to every perimeter cell
 * between them pass through every cell in the square.
 *
 * Heights along a ray are interpolated between cells, so a ray running
 * between cell centres does not "jump" from one row to the next.
 */
import {
  distance,
  elevationAtPoint,
  inBounds,
  pointToCell,
  pointToFractional,
  sampleBilinear,
  type Grid,
  type Mask,
  type Point,
} from './grid';

/** Mean Earth radius, and the standard refraction coefficient for visible light. */
const EARTH_RADIUS_M = 6_371_000;
const REFRACTION_K = 0.13;

export interface ViewshedOptions {
  /** Height of the observer's eye above ground. Default 2 m (a standing man). */
  obsHeightM?: number;
  /** Height of the thing being looked for above ground. Default 2 m (a man). */
  targetHeightM?: number;
  /** Maximum range in metres. Default 3,000 m. */
  maxRangeM?: number;
  /** Allow for Earth curvature and refraction. Default false (<0.6 m at 3 km). */
  earthCurvature?: boolean;
  /** Woods, buildings and hedges that block sight (see features/obstacles.ts). Default none. */
  obstacles?: Obstacles;
}

/**
 * Things standing on the ground that block sight. `heightM` is added to the
 * ground along each sight line. In `wood` cells a sight line may reach
 * `seeIntoWoodM` past the point where it entered the wood, and no further.
 */
export interface Obstacles {
  heightM: Float32Array;
  wood: Uint8Array;
  seeIntoWoodM: number;
}

export const VIEW_DEFAULTS = {
  obsHeightM: 2,
  targetHeightM: 2,
  maxRangeM: 3000,
  earthCurvature: false,
} as const;

/** Merge options over defaults, ignoring keys that are explicitly undefined. */
export function resolveViewOptions(opts: ViewshedOptions = {}): Required<Omit<ViewshedOptions, 'obstacles'>> {
  const out: Required<Omit<ViewshedOptions, 'obstacles'>> = { ...VIEW_DEFAULTS };
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined && k !== 'obstacles') (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Height lost to Earth curvature (net of refraction) at distance d. */
function curvatureDrop(d: number, enabled: boolean): number {
  return enabled ? ((1 - REFRACTION_K) * d * d) / (2 * EARTH_RADIUS_M) : 0;
}

/**
 * Viewshed: which cells an observer can see.
 * Returns a mask (1 = visible) the same shape as the grid.
 * The observer is placed at the centre of the cell containing `observer`.
 */
export function viewshed(g: Grid, observer: Point, opts: ViewshedOptions = {}): Mask {
  const { obsHeightM, targetHeightM, maxRangeM, earthCurvature } = resolveViewOptions(opts);
  const { width: w, cellM, data } = g;
  const out = new Uint8Array(w * g.height);
  const o = pointToCell(g, observer);
  if (!inBounds(g, o.col, o.row)) return out;
  const obs = opts.obstacles;
  const observerInWood = !!obs && obs.wood[o.row * w + o.col] === 1;

  const z0 = data[o.row * w + o.col] + obsHeightM;
  const R = Math.ceil(maxRangeM / cellM);
  const maxR2 = (maxRangeM / cellM) ** 2;
  out[o.row * w + o.col] = 1;

  const castRay = (tc: number, tr: number) => {
    const dc = tc - o.col;
    const dr = tr - o.row;
    const steps = Math.max(Math.abs(dc), Math.abs(dr));
    if (steps === 0) return;
    const sc = dc / steps;
    const sr = dr / steps;
    const stepLenCells = Math.hypot(sc, sr);
    let maxGrad = -Infinity;
    // Where this ray entered the wood it is in (metres), and the blocking
    // gradient at that point; -1 when not in a wood.
    let woodEntry = observerInWood ? 0 : -1;
    let gradAtEntry = -Infinity;
    for (let k = 1; k <= steps; k++) {
      const fc = o.col + sc * k;
      const fr = o.row + sr * k;
      const col = Math.round(fc);
      const row = Math.round(fr);
      if (!inBounds(g, col, row)) return;
      const dCells = stepLenCells * k;
      if (dCells > R + 1) return;
      const i = row * w + col;
      const cellInRange = (col - o.col) ** 2 + (row - o.row) ** 2 <= maxR2;
      const d = dCells * cellM;
      const zg = sampleBilinear(g, fc, fr) - curvatureDrop(d, earthCurvature);
      const targetGrad = (zg + targetHeightM - z0) / d;
      if (obs && obs.wood[i]) {
        if (woodEntry < 0) {
          woodEntry = d;
          gradAtEntry = maxGrad;
        }
        // Inside the treeline: seen only near the edge, and only if the edge itself is seen.
        if (cellInRange && d - woodEntry <= obs.seeIntoWoodM && targetGrad >= gradAtEntry) out[i] = 1;
      } else {
        woodEntry = -1;
        if (cellInRange && targetGrad >= maxGrad) out[i] = 1;
      }
      const top = zg + (obs ? obs.heightM[i] : 0);
      const blockGrad = (top - z0) / d;
      if (blockGrad > maxGrad) maxGrad = blockGrad;
    }
  };

  for (let i = -R; i <= R; i++) {
    castRay(o.col + i, o.row - R); // north edge
    castRay(o.col + i, o.row + R); // south edge
    castRay(o.col - R, o.row + i); // west edge
    castRay(o.col + R, o.row + i); // east edge
  }
  return out;
}

/**
 * Point-to-point line of sight. True if someone at `from` (eye at hFrom above
 * ground) can see something at `to` (hTo above ground).
 * Samples the ground every half cell along the line.
 */
export function lineOfSight(
  g: Grid,
  from: Point,
  to: Point,
  hFrom: number = VIEW_DEFAULTS.obsHeightM,
  hTo: number = VIEW_DEFAULTS.targetHeightM,
  earthCurvature = false,
  obstacles?: Obstacles,
): boolean {
  const D = distance(from, to);
  if (D < g.cellM) return true;
  const z0 = elevationAtPoint(g, from) + hFrom;
  const z1 = elevationAtPoint(g, to) + hTo - curvatureDrop(D, earthCurvature);
  const targetGrad = (z1 - z0) / D;
  const n = Math.ceil(D / (g.cellM / 2));
  const cellAt = (t: number) => {
    const c = pointToCell(g, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    return inBounds(g, c.col, c.row) ? c.row * g.width + c.col : -1;
  };
  const inWood = (t: number) => {
    const i = cellAt(t);
    return !!obstacles && i >= 0 && obstacles.wood[i] === 1;
  };
  // Wood at either end: the trees within `seeIntoWoodM` of that end do not
  // block, but the end must be no deeper than that into the wood.
  let skipNearTo = 0;
  let skipNearFrom = 0;
  if (obstacles) {
    const see = obstacles.seeIntoWoodM;
    if (inWood(1)) {
      let k = n - 1;
      while (k > 0 && inWood(k / n)) k--;
      const depth = D - (k / n) * D;
      if (depth > see + g.cellM / 2) return false;
      skipNearTo = see + g.cellM / 2;
    }
    if (inWood(0)) skipNearFrom = see + g.cellM / 2;
  }
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const d = t * D;
    // Ignore ground within half a cell of either end: that is the stand itself.
    if (d < g.cellM / 2 || D - d < g.cellM / 2) continue;
    const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    const { c, r } = pointToFractional(g, p);
    let zg = sampleBilinear(g, c, r) - curvatureDrop(d, earthCurvature);
    if (obstacles) {
      const i = cellAt(t);
      if (i >= 0) {
        const nearEndInWood = obstacles.wood[i] === 1 && (D - d <= skipNearTo || d <= skipNearFrom);
        if (!nearEndInWood) zg += obstacles.heightM[i];
      }
    }
    if ((zg - z0) / d > targetGrad) return false;
  }
  return true;
}

export interface Observer {
  point: Point;
  /** Eye height above ground; defaults to the options' obsHeightM. */
  heightM?: number;
}

/**
 * For each cell, how many of the observers can see it.
 * Useful for "how exposed is this ground?" maps.
 */
export function visibilityCount(g: Grid, observers: Observer[], opts: ViewshedOptions = {}): Uint16Array {
  const count = new Uint16Array(g.width * g.height);
  for (const ob of observers) {
    const v = viewshed(g, ob.point, { ...opts, obsHeightM: ob.heightM ?? opts.obsHeightM });
    for (let i = 0; i < v.length; i++) count[i] += v[i];
  }
  return count;
}

/** Everything that at least one of the observers can see. */
export function unionViewshed(g: Grid, observers: Observer[], opts: ViewshedOptions = {}): Mask {
  const count = visibilityCount(g, observers, opts);
  const out = new Uint8Array(count.length);
  for (let i = 0; i < count.length; i++) out[i] = count[i] > 0 ? 1 : 0;
  return out;
}

/** Cells within maxRange of at least one observer. */
export function inRangeMask(g: Grid, observers: Observer[], maxRangeM: number): Mask {
  const out = new Uint8Array(g.width * g.height);
  const r = maxRangeM / g.cellM;
  for (const ob of observers) {
    const o = pointToCell(g, ob.point);
    const R = Math.ceil(r);
    for (let row = Math.max(0, o.row - R); row <= Math.min(g.height - 1, o.row + R); row++) {
      for (let col = Math.max(0, o.col - R); col <= Math.min(g.width - 1, o.col + R); col++) {
        if ((col - o.col) ** 2 + (row - o.row) ** 2 <= r * r) out[row * g.width + col] = 1;
      }
    }
  }
  return out;
}

/**
 * Dead ground: cells within range of the observers that none of them can see.
 * (Ground beyond every observer's range is neither visible nor dead ground —
 * it is simply out of range.)
 */
export function deadGround(g: Grid, observers: Observer[], opts: ViewshedOptions = {}): Mask {
  const maxRangeM = opts.maxRangeM ?? VIEW_DEFAULTS.maxRangeM;
  const seen = unionViewshed(g, observers, opts);
  const range = inRangeMask(g, observers, maxRangeM);
  const out = new Uint8Array(seen.length);
  for (let i = 0; i < out.length; i++) out[i] = range[i] && !seen[i] ? 1 : 0;
  return out;
}

/**
 * Exposure of a position: which of the given enemy observers can see a
 * target of targetHeightM standing there. Returns the indices of those
 * observers (empty = unobserved).
 */
export function exposure(
  g: Grid,
  position: Point,
  enemyObservers: Observer[],
  opts: ViewshedOptions = {},
): number[] {
  const { obsHeightM, targetHeightM, maxRangeM, earthCurvature } = resolveViewOptions(opts);
  const seenBy: number[] = [];
  enemyObservers.forEach((ob, i) => {
    if (distance(ob.point, position) > maxRangeM) return;
    if (lineOfSight(g, ob.point, position, ob.heightM ?? obsHeightM, targetHeightM, earthCurvature, opts.obstacles)) {
      seenBy.push(i);
    }
  });
  return seenBy;
}

/** Share (0–1) of the cells in `area` that are visible in `visible`. */
export function coverage(visible: Mask, area: Mask): number {
  let inArea = 0;
  let seen = 0;
  for (let i = 0; i < area.length; i++) {
    if (area[i]) {
      inArea++;
      if (visible[i]) seen++;
    }
  }
  return inArea === 0 ? 0 : seen / inArea;
}

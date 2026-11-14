/**
 * Crests and skylining, relative to the direction of the enemy.
 *
 * Topographical crest: the highest line of a feature, where the ground starts
 * to fall away towards the enemy.
 *
 * Military crest: the highest point on the forward slope from which the whole
 * forward slope, down to its foot, can be seen. On a straight-sided slope it
 * coincides with the topographical crest; on a rounded (convex) slope it lies
 * forward of it, because the bulge hides the lower slope from the top.
 *
 * Method: we cut the box into parallel profiles (transects) running towards the
 * enemy, one cell apart, and find the crests along each profile. The crest
 * cells from all the profiles together form the crest lines.
 */
import {
  bearingVector,
  createGrid,
  elevationAtPoint,
  inBounds,
  pointToCell,
  pointToFractional,
  sampleBilinear,
  type Grid,
  type Mask,
  type Point,
} from './grid';
import { lineOfSight } from './viewshed';

export interface CrestOptions {
  /** Ground must fall at least this far (m) in front of a crest to count. Default 10. */
  minDropM?: number;
  /** Eye height used when finding the military crest. Default 2 m. */
  obsHeightM?: number;
  /** Rises smaller than this (m) are ignored when following a slope down. Default 0.5. */
  noiseM?: number;
}

export interface CrestResult {
  /** Topographical crest cells. */
  topographical: Mask;
  /** Military crest cells. */
  military: Mask;
}

/**
 * Sample a profile along a line through the box. Returns elevations at
 * cell-sized steps and the matching points (only the part inside the grid).
 */
function sampleProfile(g: Grid, origin: Point, dir: Point, halfLen: number) {
  const pts: Point[] = [];
  const z: number[] = [];
  const step = g.cellM;
  for (let s = -halfLen; s <= halfLen; s += step) {
    const p = { x: origin.x + dir.x * s, y: origin.y + dir.y * s };
    const c = pointToCell(g, p);
    if (!inBounds(g, c.col, c.row)) continue;
    const f = pointToFractional(g, p);
    pts.push(p);
    z.push(sampleBilinear(g, f.c, f.r));
  }
  return { pts, z };
}

/**
 * Crest lines for an enemy approaching from `enemyBearingDeg` (the bearing
 * from our position towards the enemy, e.g. 0 = enemy to the north).
 */
export function crestLine(g: Grid, enemyBearingDeg: number, opts: CrestOptions = {}): CrestResult {
  const { minDropM = 10, obsHeightM = 2, noiseM = 0.5 } = opts;
  const n = g.width * g.height;
  const topographical = new Uint8Array(n);
  const military = new Uint8Array(n);
  const u = bearingVector(enemyBearingDeg); // towards the enemy
  const v = { x: u.y, y: -u.x }; // across the front
  const halfDiag = (Math.hypot(g.width, g.height) * g.cellM) / 2;

  const mark = (m: Mask, p: Point) => {
    const c = pointToCell(g, p);
    if (inBounds(g, c.col, c.row)) m[c.row * g.width + c.col] = 1;
  };

  for (let off = -halfDiag; off <= halfDiag; off += g.cellM) {
    const origin = { x: v.x * off, y: v.y * off };
    const { pts, z } = sampleProfile(g, origin, u, halfDiag);
    const len = z.length;
    if (len < 3) continue;

    for (let k = 1; k < len - 1; k++) {
      // A crest is a local high point along the profile (plateaus: last cell
      // of the flat top on the enemy side).
      if (!(z[k] >= z[k - 1] && z[k] > z[k + 1])) continue;

      // Follow the forward slope down to its foot (ignoring small bumps).
      let foot = k;
      let lowest = z[k];
      for (let j = k + 1; j < len; j++) {
        if (z[j] > z[k]) break; // ground rises above the crest: stop
        if (z[j] < lowest) {
          lowest = z[j];
          foot = j;
        } else if (z[j] > lowest + noiseM) break; // forward slope has ended
      }
      if (z[k] - lowest < minDropM) continue;

      mark(topographical, pts[k]);

      // Military crest: highest point between crest and foot that can see
      // every point of the slope down to the foot.
      for (let m = k; m < foot; m++) {
        const eye = z[m] + obsHeightM;
        let maxGrad = -Infinity;
        let allSeen = true;
        for (let j = m + 1; j <= foot; j++) {
          const grad = (z[j] - eye) / (j - m);
          if (grad < maxGrad) {
            allSeen = false;
            break;
          }
          maxGrad = grad;
        }
        if (allSeen) {
          mark(military, pts[m]);
          break;
        }
      }
    }
  }
  return { topographical, military };
}

export interface SilhouetteOptions {
  /** Height of our man or vehicle. Default 2 m. */
  targetHeightM?: number;
  /** Enemy eye height. Default 2 m. */
  obsHeightM?: number;
  /** How far behind the point to look for a backdrop. Default 5,000 m. */
  lookBehindM?: number;
  /**
   * When only an enemy direction is given, where to place a notional enemy
   * observer along that bearing. Default 1,500 m. (See DECISIONS.md.)
   */
  notionalEnemyRangeM?: number;
}

export interface SilhouetteResult {
  /** True if the enemy would see this point against the sky. */
  silhouetted: boolean;
  /** Can the enemy observer see the point at all? */
  visibleToEnemy: boolean;
  /** Distance behind the point to the ground that forms the backdrop, if any. */
  backdropDistanceM: number | null;
  /**
   * True if the check ran off the edge of the data before finding a backdrop:
   * the answer "silhouetted" is then provisional.
   */
  ranOffGrid: boolean;
}

/**
 * Would a man (or vehicle) at `point` be skylined to the enemy?
 *
 * We extend the enemy's sight line past the point. If the ground behind ever
 * rises to meet that line, it forms a backdrop and the point is not skylined.
 * If the line clears all the ground behind, the point is seen against the sky.
 *
 * `enemy` is either the enemy observer's position or, if only the threat
 * direction is known, a bearing (degrees) from the point towards the enemy.
 */
export function isSilhouetted(
  g: Grid,
  point: Point,
  enemy: Point | number,
  opts: SilhouetteOptions = {},
): SilhouetteResult {
  const {
    targetHeightM = 2,
    obsHeightM = 2,
    lookBehindM = 5000,
    notionalEnemyRangeM = 1500,
  } = opts;

  let E: Point;
  if (typeof enemy === 'number') {
    const d = bearingVector(enemy);
    E = { x: point.x + d.x * notionalEnemyRangeM, y: point.y + d.y * notionalEnemyRangeM };
  } else {
    E = enemy;
  }

  const D = Math.hypot(point.x - E.x, point.y - E.y);
  const ux = (point.x - E.x) / D;
  const uy = (point.y - E.y) / D;
  const zE = elevationAtPoint(g, E) + obsHeightM;
  const zTop = elevationAtPoint(g, point) + targetHeightM;
  const gTop = (zTop - zE) / D;

  const visibleToEnemy = lineOfSight(g, E, point, obsHeightM, targetHeightM);

  for (let s = g.cellM; s <= lookBehindM; s += g.cellM / 2) {
    const p = { x: point.x + ux * s, y: point.y + uy * s };
    const c = pointToCell(g, p);
    if (!inBounds(g, c.col, c.row)) {
      return { silhouetted: true, visibleToEnemy, backdropDistanceM: null, ranOffGrid: true };
    }
    const zg = elevationAtPoint(g, p);
    if ((zg - zE) / (D + s) >= gTop) {
      return { silhouetted: false, visibleToEnemy, backdropDistanceM: s, ranOffGrid: false };
    }
  }
  return { silhouetted: true, visibleToEnemy, backdropDistanceM: null, ranOffGrid: false };
}

/** Convenience: crest masks as a grid-shaped layer for display (0 none, 1 topo, 2 military, 3 both). */
export function crestLayer(g: Grid, crest: CrestResult): Grid {
  const out = createGrid(g.width, g.height, g.cellM, g.meta);
  for (let i = 0; i < out.data.length; i++) {
    out.data[i] = (crest.topographical[i] ? 1 : 0) + (crest.military[i] ? 2 : 0);
  }
  return out;
}

/**
 * Enemy approaches and the NAI (PO decision, DECISIONS.md 35).
 *
 * 1. Cost-distance: for every cell, the cheapest "going" cost to reach it from
 *    the enemy edge of the box, and from the friendly edge (Dijkstra over the
 *    going layer, 8-connected).
 * 2. The best approach is the cheapest route from the enemy edge to the
 *    friendly edge. The *corridor* is every cell lying on a route no more
 *    than `slack` (default 10%) dearer than the best: the ground an enemy
 *    would sensibly use.
 * 3. The NAI is placed where the corridor is narrowest, part-way along the
 *    route: the point where the enemy is channelled. We also record what
 *    channels it (woods, water, steep ground, buildings) for the problem text.
 */
import { cellToPoint, distance, pointToCell, type Grid, type Mask, type Point } from '../terrain/grid';
import { COVER, GOING, type FeatureLayers } from '../features/layers';

/** Slope (degrees) above which ground counts as steep in the problem text. */
export const STEEP_DEG = 12;

export type Side = 'N' | 'E' | 'S' | 'W';
export const SIDE_BEARING: Record<Side, number> = { N: 0, E: 90, S: 180, W: 270 };
export const OPPOSITE: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };

export interface NAI {
  centre: Point;
  radiusM: number;
  /** Cells of the corridor inside the NAI. */
  mask: Mask;
  /** Corridor width at the NAI, in metres. */
  widthM: number;
  /** Distance along the route from the enemy edge, in metres. */
  alongM: number;
  /** What hems the enemy in here, e.g. ['wood', 'steep ground']. Empty = open ground. */
  channelledBy: string[];
}

export interface Approach {
  enemySide: Side;
  enemyBearingDeg: number;
  /** Best route, from the enemy edge to the friendly edge. */
  route: Point[];
  routeLengthM: number;
  /** Going cost of the best route (metres of open, level ground equivalent). */
  routeCost: number;
  /** Share of the route on roads or tracks (0–1). */
  roadShare: number;
  corridor: Mask;
  nai: NAI;
}

// ---------------------------------------------------------------------------
// A small binary min-heap of cell indices keyed by cost.

class MinHeap {
  private idx: number[] = [];
  private key: number[] = [];
  get size() {
    return this.idx.length;
  }
  push(i: number, k: number) {
    this.idx.push(i);
    this.key.push(k);
    let c = this.idx.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      this.swap(p, c);
      c = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.idx[0], this.key[0]];
    const lastI = this.idx.pop()!;
    const lastK = this.key.pop()!;
    if (this.idx.length) {
      this.idx[0] = lastI;
      this.key[0] = lastK;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1;
        const r = l + 1;
        let m = p;
        if (l < this.idx.length && this.key[l] < this.key[m]) m = l;
        if (r < this.idx.length && this.key[r] < this.key[m]) m = r;
        if (m === p) break;
        this.swap(p, m);
        p = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.idx[a], this.idx[b]] = [this.idx[b], this.idx[a]];
    [this.key[a], this.key[b]] = [this.key[b], this.key[a]];
  }
}

/** Cells along one edge of the box. */
export function edgeCells(g: Grid, side: Side): number[] {
  const out: number[] = [];
  const { width: w, height: h } = g;
  for (let k = 0; k < (side === 'N' || side === 'S' ? w : h); k++) {
    if (side === 'N') out.push(k);
    else if (side === 'S') out.push((h - 1) * w + k);
    else if (side === 'W') out.push(k * w);
    else out.push(k * w + (w - 1));
  }
  return out;
}

/**
 * Cheapest going cost from any source cell to every cell. Moving between two
 * cells costs the distance times the average going of the two.
 * Also returns the predecessor of each cell on its cheapest path.
 */
export function costDistance(g: Grid, going: Float32Array, sources: number[]): { cost: Float64Array; prev: Int32Array } {
  const { width: w, height: h, cellM } = g;
  const cost = new Float64Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  const heap = new MinHeap();
  for (const s of sources) {
    if (!Number.isFinite(going[s])) continue;
    cost[s] = 0;
    heap.push(s, 0);
  }
  const DC = [-1, 0, 1, -1, 1, -1, 0, 1];
  const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
  const STEP = DC.map((dc, k) => Math.hypot(dc, DR[k]) * cellM);
  while (heap.size) {
    const [i, k] = heap.pop();
    if (k > cost[i]) continue;
    const r = (i / w) | 0;
    const c = i - r * w;
    for (let d = 0; d < 8; d++) {
      const cc = c + DC[d];
      const rr = r + DR[d];
      if (cc < 0 || rr < 0 || cc >= w || rr >= h) continue;
      const j = rr * w + cc;
      const gj = going[j];
      if (!Number.isFinite(gj)) continue;
      const nk = k + (STEP[d] * (going[i] + gj)) / 2;
      if (nk < cost[j]) {
        cost[j] = nk;
        prev[j] = i;
        heap.push(j, nk);
      }
    }
  }
  return { cost, prev };
}

/** Going layer for ground with no feature data: slope only. */
export function slopeOnlyGoing(slopeDeg: Float32Array): Float32Array {
  const out = new Float32Array(slopeDeg.length);
  for (let i = 0; i < out.length; i++) {
    const s = slopeDeg[i];
    out[i] = s > GOING.slopeLimitDeg ? Infinity
      : s > GOING.slopeEasyDeg ? 1 + (3 * (s - GOING.slopeEasyDeg)) / (GOING.slopeLimitDeg - GOING.slopeEasyDeg)
      : 1;
  }
  return out;
}

export interface ApproachOptions {
  /** Corridor = routes up to this much dearer than the best. Default 0.1 (10%). */
  slack?: number;
  /** The NAI is placed between these fractions of the route from the enemy edge. Default 0.25–0.65. */
  naiWindow?: [number, number];
  /** NAI radius in metres. Default 250. */
  naiRadiusM?: number;
  /**
   * Going is raised gently towards the two side edges of the box (up to 15%
   * at the edge, plus up to 50% more in the last `flankMarginM`). On open
   * ground, where many routes cost the same, this makes the approach run
   * through the middle of the box instead of along its edge. Real obstacles
   * cost far more than this, so they still decide the route. Default 600 m.
   */
  flankMarginM?: number;
}

/** Going raised towards the two side edges (the ones the enemy does not cross). See `flankMarginM`. */
export function withFlankPenalty(g: Grid, going: Float32Array, enemySide: Side, marginM: number): Float32Array {
  const out = new Float32Array(going.length);
  const half = (g.width * g.cellM) / 2;
  const acrossX = enemySide === 'N' || enemySide === 'S';
  for (let r = 0; r < g.height; r++) {
    for (let c = 0; c < g.width; c++) {
      const p = cellToPoint(g, c, r);
      const d = half - Math.abs(acrossX ? p.x : p.y);
      const i = r * g.width + c;
      const off = 1 - d / half; // 0 on the centre line, 1 at the side edge
      out[i] = going[i] * (1 + 0.15 * off * off + 0.5 * Math.max(0, 1 - d / marginM));
    }
  }
  return out;
}

/**
 * Find the enemy's best approach from `enemySide` across the box, its
 * corridor and the NAI. Returns null if the enemy cannot cross at all.
 */
export function findApproach(
  g: Grid,
  going: Float32Array,
  slopeDeg: Float32Array,
  enemySide: Side,
  layers: FeatureLayers | null,
  opts: ApproachOptions = {},
): Approach | null {
  const slack = opts.slack ?? 0.1;
  const [w0, w1] = opts.naiWindow ?? [0.25, 0.65];
  const naiRadiusM = opts.naiRadiusM ?? 250;
  const flankMarginM = opts.flankMarginM ?? 600;
  const n = g.width * g.height;
  going = withFlankPenalty(g, going, enemySide, flankMarginM);
  const half = (g.width * g.cellM) / 2;
  const acrossX = enemySide === 'N' || enemySide === 'S';

  const fromEnemy = costDistance(g, going, edgeCells(g, enemySide));
  const fromFriend = costDistance(g, going, edgeCells(g, OPPOSITE[enemySide]));

  // Best crossing: the friendly-edge cell the enemy reaches most cheaply.
  let best = Infinity;
  let end = -1;
  for (const i of edgeCells(g, OPPOSITE[enemySide])) {
    if (fromEnemy.cost[i] < best) {
      best = fromEnemy.cost[i];
      end = i;
    }
  }
  if (end < 0 || !Number.isFinite(best)) return null;

  // Trace the route back to the enemy edge, then reverse it.
  const cells: number[] = [];
  for (let i = end; i >= 0; i = fromEnemy.prev[i]) cells.push(i);
  cells.reverse();
  const toPoint = (i: number) => cellToPoint(g, i % g.width, Math.floor(i / g.width));
  const route = cells.map(toPoint);
  const along: number[] = [0];
  for (let k = 1; k < route.length; k++) along.push(along[k - 1] + distance(route[k - 1], route[k]));
  const routeLengthM = along[along.length - 1];

  let onRoad = 0;
  if (layers) for (const i of cells) if (layers.route[i] >= 2) onRoad++;

  // Corridor.
  const corridor = new Uint8Array(n);
  const limit = best * (1 + slack);
  for (let i = 0; i < n; i++) if (fromEnemy.cost[i] + fromFriend.cost[i] <= limit) corridor[i] = 1;

  // Corridor width across the route, sampled every ~50 m within the NAI window.
  const inCorridor = (p: Point) => {
    const c = pointToCell(g, p);
    return c.col >= 0 && c.row >= 0 && c.col < g.width && c.row < g.height && corridor[c.row * g.width + c.col] === 1;
  };
  const maxReach = 1500;
  let bestK = -1;
  let bestWidth = Infinity;
  let bestEdges: Point[] = [];
  let lastSampled = -Infinity;
  for (let k = 0; k < route.length; k++) {
    const f = along[k] / routeLengthM;
    if (f < w0 || f > w1 || along[k] - lastSampled < 50) continue;
    // Keep the NAI well inside the box.
    if (half - Math.abs(acrossX ? route[k].x : route[k].y) < naiRadiusM + 150) continue;
    lastSampled = along[k];
    // Local direction of the route over ±100 m.
    const a = route[Math.max(0, indexAt(along, along[k] - 100))];
    const b = route[Math.min(route.length - 1, indexAt(along, along[k] + 100))];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const edges: Point[] = [];
    let width = 0;
    for (const sgn of [1, -1]) {
      let d = 0;
      while (d < maxReach) {
        const p = { x: route[k].x + sgn * nx * (d + g.cellM / 2), y: route[k].y + sgn * ny * (d + g.cellM / 2) };
        if (!inCorridor(p)) break;
        d += g.cellM / 2;
      }
      width += d;
      edges.push({ x: route[k].x + sgn * nx * (d + g.cellM), y: route[k].y + sgn * ny * (d + g.cellM) });
    }
    // Prefer the narrowest point; on a tie, the one nearest the middle of the window.
    const mid = (w0 + w1) / 2;
    if (width < bestWidth - 1e-6 || (Math.abs(width - bestWidth) < 1e-6 && Math.abs(f - mid) < Math.abs(along[bestK] / routeLengthM - mid))) {
      bestWidth = width;
      bestK = k;
      bestEdges = edges;
    }
  }
  if (bestK < 0) bestK = indexAt(along, routeLengthM * 0.45);

  const centre = route[bestK];
  const naiMask = new Uint8Array(n);
  const c0 = pointToCell(g, centre);
  const R = Math.ceil(naiRadiusM / g.cellM);
  for (let r = c0.row - R; r <= c0.row + R; r++) {
    for (let c = c0.col - R; c <= c0.col + R; c++) {
      if (r < 0 || c < 0 || r >= g.height || c >= g.width) continue;
      if ((r - c0.row) ** 2 + (c - c0.col) ** 2 > R * R) continue;
      const i = r * g.width + c;
      if (corridor[i]) naiMask[i] = 1;
    }
  }

  const channelledBy = bestWidth >= 2 * maxReach - 1 ? [] : whatChannels(g, bestEdges, layers, slopeDeg, going);

  return {
    enemySide,
    enemyBearingDeg: SIDE_BEARING[enemySide],
    route,
    routeLengthM,
    routeCost: best,
    roadShare: cells.length ? onRoad / cells.length : 0,
    corridor,
    nai: {
      centre,
      radiusM: naiRadiusM,
      mask: naiMask,
      widthM: Math.min(bestWidth, 2 * maxReach),
      alongM: along[bestK],
      channelledBy,
    },
  };
}

/** Index of the first route point at or beyond distance `d` along it. */
function indexAt(along: number[], d: number): number {
  let lo = 0;
  let hi = along.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (along[mid] < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Describe what lies just outside the corridor at the two edge points. */
function whatChannels(g: Grid, edges: Point[], layers: FeatureLayers | null, slopeDeg: Float32Array, going: Float32Array): string[] {
  const tally = new Map<string, number>();
  const add = (s: string) => tally.set(s, (tally.get(s) ?? 0) + 1);
  for (const e of edges) {
    const c = pointToCell(g, e);
    for (let dr = -3; dr <= 3; dr++) {
      for (let dc = -3; dc <= 3; dc++) {
        const r = c.row + dr;
        const cc = c.col + dc;
        if (r < 0 || cc < 0 || r >= g.height || cc >= g.width) continue;
        const i = r * g.width + cc;
        if (slopeDeg[i] > STEEP_DEG) add('steep ground');
        if (layers) {
          const cv = layers.cover[i];
          if (cv === COVER.wood) add('woods');
          else if (cv === COVER.water || layers.river[i]) add('water');
          else if (cv === COVER.wetland) add('marsh');
          else if (cv === COVER.builtUp || cv === COVER.building) add('buildings');
          else if (cv === COVER.scrub) add('scrub');
          if (layers.railway[i]) add('the railway');
        } else if (!Number.isFinite(going[i])) add('impassable ground');
      }
    }
  }
  return [...tally.entries()]
    .filter(([, k]) => k >= 4)
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);
}

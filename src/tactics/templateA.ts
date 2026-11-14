/**
 * Template A: OP and gun area (artillery). See CLAUDE.md §8.
 *
 * Given the enemy approach, its NAI and the likely enemy OPs, compute:
 *  - for every cell on the forward friendly side, the share of the NAI an OP
 *    there could see, how many enemy OPs could see it, and whether it is
 *    skylined;
 *  - covered gun areas: out of enemy view (vehicle height), slope under 6°,
 *    big enough for a battery;
 *  - the line of communication from the gun area to the OP;
 *  - the dilemma test and the quality gate.
 *
 * Every number here comes from the elevation data and geometry (core
 * principle 1). Nothing is guessed.
 */
import { bearingVector, cellToPoint, distance, pointToCell, type Grid, type Mask, type Point } from '../terrain/grid';
import { visibilityCount } from '../terrain/viewshed';
import { isSilhouetted } from '../terrain/crest';
import { COVER, ROUTE, type FeatureLayers } from '../features/layers';
import { costDistance, slopeOnlyGoing, type Approach } from './approach';
import { downsample, type EnemyOP } from './enemyOps';

/** Thresholds. Those marked PO are first guesses for the product owner to confirm. */
export const TEMPLATE_A = {
  /** OPs are sited in the forward friendly area: this far back from the centre line. */
  opZoneDepthM: 1600,
  /** Gun areas must be at least this far behind the centre line. */
  gunMinDepthM: 500,
  /** Gun area: maximum slope (brief: about 6°). */
  gunMaxSlopeDeg: 6,
  /** PO: smallest gun area for a battery, in hectares (4 ha ≈ 200 m × 200 m). */
  gunMinAreaHa: 4,
  /** Height of a gun or vehicle for "out of enemy view". */
  vehicleHeightM: 3,
  /** Brief: the alternative OP must be at least this far from the best-view OP… */
  altMinSeparationM: 300,
  /** …and see at least this share of what the best-view OP sees. */
  altMinViewRatio: 0.6,
  /** PO: an OP must see at least this share of the NAI to be worth considering. */
  minUsefulNaiShare: 0.3,
  /** PO: a line of communication is "long and exposed" above these. */
  locLongM: 1000,
  locExposedShare: 0.4,
  /** Brief: every stand within a 3 km round trip, i.e. 1.5 km out on paths. */
  maxStandPathM: 1500,
  /** NAI sample spacing for the visibility count. */
  naiSampleM: 75,
};

export interface OPCandidate {
  point: Point;
  /** Share (0–1) of the NAI visible from here (2 m eye, 2 m target). */
  naiShare: number;
  /** How many of the likely enemy OPs can see a man standing here. */
  seenBy: number;
  silhouetted: boolean;
}

export interface GunArea {
  centre: Point;
  areaHa: number;
  mask: Mask;
  /** Distance from the centre to the nearest road or track, in metres (Infinity if none known). */
  toRoadM: number;
  rangeToNaiM: number;
}

export interface LineOfCommunication {
  path: Point[];
  lengthM: number;
  /** Share of the route a vehicle on it would be seen by an enemy OP. */
  exposedShare: number;
}

export interface Dilemma {
  kind: 'op-exposure' | 'exposed-loc';
  /** Plain-English statement of the dilemma, from computed facts, for the DS notes. */
  text: string;
}

export interface TemplateAResult {
  /** True if the problem passes the quality gate and may be shown. */
  passed: boolean;
  /** Why it passed or failed, in plain English. */
  gate: string[];
  approach: Approach;
  enemyOps: EnemyOP[];
  bestViewOP: OPCandidate | null;
  alternativeOP: OPCandidate | null;
  /** The best OP the enemy cannot see at all, if any. */
  concealedOP: OPCandidate | null;
  gunAreas: GunArea[];
  locToBestOP: LineOfCommunication | null;
  dilemmas: Dilemma[];
  /** Layers for the DS overlay. */
  naiShare: Float32Array;
  enemySeesMan: Uint16Array;
  enemySeesVehicle: Uint16Array;
  /** True if public access was checked against map features. */
  accessChecked: boolean;
}

export interface TemplateAInput {
  grid: Grid;
  slopeDeg: Float32Array;
  reliefM: number;
  layers: FeatureLayers | null;
  approach: Approach;
  enemyOps: EnemyOP[];
  /** The user's position (local metres); stands are measured from here. Default: box centre. */
  start?: Point;
  /** If true (the default), fail the gate when access cannot be checked. */
  requireAccessCheck?: boolean;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const metres = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} km` : `${Math.round(x / 10) * 10} m`);

export function templateA(input: TemplateAInput): TemplateAResult {
  const { grid: g, slopeDeg, layers, approach, enemyOps } = input;
  const T = TEMPLATE_A;
  const n = g.width * g.height;
  const u = bearingVector(approach.enemyBearingDeg);
  const forward = (p: Point) => p.x * u.x + p.y * u.y; // + towards the enemy
  const gate: string[] = [];

  // 1. How much of the NAI can see each cell (= what an OP there would see,
  //    since eye and target are both 2 m). Done on a 30 m copy of the grid,
  //    the true resolution of the data, to keep it fast on a phone.
  const naiPts: Point[] = [];
  const step = Math.max(1, Math.round(T.naiSampleM / g.cellM));
  for (let r = 0; r < g.height; r += step)
    for (let c = 0; c < g.width; c += step) if (approach.nai.mask[r * g.width + c]) naiPts.push(cellToPoint(g, c, r));
  const cg = downsample(g, Math.max(1, Math.round(30 / g.cellM)));
  const naiCount = visibilityCount(cg, naiPts.map((p) => ({ point: p })), { obsHeightM: 2, targetHeightM: 2 });
  const naiShare = new Float32Array(n);
  for (let r = 0; r < g.height; r++)
    for (let c = 0; c < g.width; c++) {
      const cc = pointToCell(cg, cellToPoint(g, c, r));
      const inside = cc.col >= 0 && cc.row >= 0 && cc.col < cg.width && cc.row < cg.height;
      naiShare[r * g.width + c] = inside && naiPts.length ? naiCount[cc.row * cg.width + cc.col] / naiPts.length : 0;
    }

  // 2. What the enemy OPs can see: a man (2 m) and a vehicle or gun (3 m).
  const enemySeesMan = visibilityCount(g, enemyOps, { targetHeightM: 2 });
  const enemySeesVehicle = visibilityCount(g, enemyOps, { targetHeightM: T.vehicleHeightM });

  // 3. Where a stand may go, and how far it is on foot.
  const accessChecked = !!layers;
  const allowed = new Uint8Array(n);
  for (let i = 0; i < n; i++) allowed[i] = layers ? (layers.standOk[i] && !layers.excluded[i] ? 1 : 0) : 1;
  const start = input.start ?? { x: 0, y: 0 };
  const walk = walkingDistance(g, allowed, start);

  // 4. OP candidates in the forward friendly area.
  const cands: OPCandidate[] = [];
  for (let r = 0; r < g.height; r++) {
    for (let c = 0; c < g.width; c++) {
      const i = r * g.width + c;
      if (!allowed[i] || walk[i] > T.maxStandPathM || naiShare[i] < T.minUsefulNaiShare) continue;
      const p = cellToPoint(g, c, r);
      const f = forward(p);
      if (f >= 0 || f < -T.opZoneDepthM) continue;
      cands.push({ point: p, naiShare: naiShare[i], seenBy: enemySeesMan[i], silhouetted: false });
    }
  }
  const byView = [...cands].sort((a, b) => b.naiShare - a.naiShare || a.seenBy - b.seenBy);
  const bestViewOP = byView[0] ?? null;
  let alternativeOP: OPCandidate | null = null;
  let concealedOP: OPCandidate | null = null;
  if (bestViewOP) {
    bestViewOP.silhouetted = silhouetted(g, bestViewOP.point, enemyOps, approach.enemyBearingDeg);
    alternativeOP =
      byView.find(
        (c) =>
          distance(c.point, bestViewOP.point) >= T.altMinSeparationM &&
          c.naiShare >= T.altMinViewRatio * bestViewOP.naiShare &&
          c.seenBy < bestViewOP.seenBy,
      ) ?? null;
    if (!alternativeOP && bestViewOP.silhouetted) {
      // A position with the same exposure but not skylined also counts as less exposed.
      for (const c of byView) {
        if (distance(c.point, bestViewOP.point) < T.altMinSeparationM) continue;
        if (c.naiShare < T.altMinViewRatio * bestViewOP.naiShare) break;
        if (c.seenBy > bestViewOP.seenBy) continue;
        if (!silhouetted(g, c.point, enemyOps, approach.enemyBearingDeg)) {
          alternativeOP = c;
          break;
        }
      }
    }
    if (alternativeOP) alternativeOP.silhouetted = silhouetted(g, alternativeOP.point, enemyOps, approach.enemyBearingDeg);
    concealedOP = byView.find((c) => c.seenBy === 0) ?? null;
  }

  // 5. Covered gun areas.
  const suitable = new Uint8Array(n);
  for (let r = 0; r < g.height; r++) {
    for (let c = 0; c < g.width; c++) {
      const i = r * g.width + c;
      if (forward(cellToPoint(g, c, r)) > -T.gunMinDepthM) continue;
      if (enemySeesVehicle[i] || slopeDeg[i] >= T.gunMaxSlopeDeg) continue;
      if (layers) {
        const cv = layers.cover[i];
        if (layers.excluded[i] || (cv !== COVER.open && cv !== COVER.scrub)) continue;
      }
      suitable[i] = 1;
    }
  }
  const gunAreas = components(g, suitable, (T.gunMinAreaHa * 10_000) / (g.cellM * g.cellM)).map((mask) => {
    const centre = centroid(g, mask);
    return {
      centre,
      areaHa: (count(mask) * g.cellM * g.cellM) / 10_000,
      mask,
      toRoadM: layers ? nearestRouteM(g, layers, centre) : Infinity,
      rangeToNaiM: distance(centre, approach.nai.centre),
    };
  });
  // Best first: near a road or track, then larger.
  gunAreas.sort((a, b) => a.toRoadM - b.toRoadM || b.areaHa - a.areaHa);

  // 6. Line of communication from the best gun area to the best-view OP.
  const going = layers ? layers.going : slopeOnlyGoing(slopeDeg);
  const locToBestOP = gunAreas[0] && bestViewOP ? lineOfCommunication(g, going, gunAreas[0].centre, bestViewOP.point, enemySeesVehicle) : null;

  // 7. Dilemma tests (CLAUDE.md §8).
  const dilemmas: Dilemma[] = [];
  if (bestViewOP && alternativeOP && (bestViewOP.seenBy > 0 || bestViewOP.silhouetted)) {
    const exposedWhy = [
      bestViewOP.seenBy > 0 ? `${bestViewOP.seenBy} of ${enemyOps.length} likely enemy OPs can see it` : '',
      bestViewOP.silhouetted ? 'it is skylined' : '',
    ].filter(Boolean).join(' and ');
    dilemmas.push({
      kind: 'op-exposure',
      text:
        `The OP with the best view sees ${pct(bestViewOP.naiShare)} of the NAI, but ${exposedWhy}. ` +
        `A second position ${metres(distance(bestViewOP.point, alternativeOP.point))} away sees ${pct(alternativeOP.naiShare)} ` +
        `and can be seen by ${alternativeOP.seenBy} enemy OP${alternativeOP.seenBy === 1 ? '' : 's'}` +
        `${alternativeOP.silhouetted ? ' (also skylined)' : ''}. View or survival?`,
    });
  }
  if (locToBestOP && locToBestOP.lengthM >= T.locLongM && locToBestOP.exposedShare >= T.locExposedShare) {
    dilemmas.push({
      kind: 'exposed-loc',
      text:
        `The best covered gun area is ${metres(locToBestOP.lengthM)} by the easiest route from the best OP, ` +
        `and ${pct(locToBestOP.exposedShare)} of that route is in view of the enemy.`,
    });
  }

  // 8. Quality gate.
  let passed = true;
  const fail = (why: string) => {
    passed = false;
    gate.push(`✗ ${why}`);
  };
  const ok = (why: string) => gate.push(`✓ ${why}`);
  if (input.reliefM < 20) fail(`The ground is too flat for this problem (relief ${Math.round(input.reliefM)} m, needs 20 m).`);
  else ok(`Relief ${Math.round(input.reliefM)} m.`);
  if (approach.nai.channelledBy.length === 0) gate.push('• Nothing channels the enemy at the NAI: it is on open ground.');
  if (!bestViewOP) fail('No reachable OP position sees enough of the NAI.');
  if (!gunAreas.length) fail('No covered gun area big enough for a battery.');
  if (!dilemmas.length) fail('No real dilemma: the best OP is safe, or there is no good alternative.');
  else ok(`Dilemma: ${dilemmas.map((d) => d.kind).join(', ')}.`);
  const coas = (bestViewOP ? 1 : 0) + (alternativeOP ? 1 : 0);
  if (coas < 2 && !(dilemmas.some((d) => d.kind === 'exposed-loc') && gunAreas.length >= 2))
    fail('Fewer than two viable courses of action.');
  if (!accessChecked) {
    if (input.requireAccessCheck ?? true) fail('Public access could not be checked (map features did not load).');
    else gate.push('• Public access NOT checked: map features were not loaded.');
  } else ok('All stands are on public paths or access land, within a 3 km round trip.');

  return {
    passed, gate, approach, enemyOps, bestViewOP, alternativeOP, concealedOP, gunAreas, locToBestOP, dilemmas,
    naiShare, enemySeesMan, enemySeesVehicle, accessChecked,
  };
}

// ---------------------------------------------------------------------------
// Helpers

function silhouetted(g: Grid, p: Point, enemyOps: EnemyOP[], enemyBearingDeg: number): boolean {
  // Check against each enemy OP; if any sees the point against the sky, it is skylined.
  for (const e of enemyOps) {
    const s = isSilhouetted(g, p, e.point);
    if (s.visibleToEnemy && s.silhouetted && !s.ranOffGrid) return true;
  }
  return enemyOps.length === 0 ? isSilhouetted(g, p, enemyBearingDeg).silhouetted : false;
}

/** Walking distance (metres) from `start` over allowed cells; Infinity where unreachable. */
export function walkingDistance(g: Grid, allowed: Mask, start: Point): Float64Array {
  const going = new Float32Array(allowed.length);
  for (let i = 0; i < going.length; i++) going[i] = allowed[i] ? 1 : Infinity;
  // Start from the nearest allowed cell within 200 m of the user.
  const s = pointToCell(g, start);
  let best = -1;
  let bestD = Infinity;
  const R = Math.ceil(200 / g.cellM);
  for (let dr = -R; dr <= R; dr++)
    for (let dc = -R; dc <= R; dc++) {
      const r = s.row + dr;
      const c = s.col + dc;
      if (r < 0 || c < 0 || r >= g.height || c >= g.width || !allowed[r * g.width + c]) continue;
      const d = Math.hypot(dr, dc);
      if (d < bestD) {
        bestD = d;
        best = r * g.width + c;
      }
    }
  if (best < 0) return new Float64Array(allowed.length).fill(Infinity);
  const { cost } = costDistance(g, going, [best]);
  const off = bestD * g.cellM;
  for (let i = 0; i < cost.length; i++) cost[i] += off;
  return cost;
}

/** Connected (4-way) regions of a mask with at least `minCells` cells. */
function components(g: Grid, m: Mask, minCells: number): Mask[] {
  const seen = new Uint8Array(m.length);
  const out: Mask[] = [];
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue;
    const cells: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const r = (i / g.width) | 0;
      const c = i - r * g.width;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= g.width || rr >= g.height) continue;
        const j = rr * g.width + cc;
        if (m[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (cells.length >= minCells) {
      const mask = new Uint8Array(m.length);
      for (const i of cells) mask[i] = 1;
      out.push(mask);
    }
  }
  return out;
}

function count(m: Mask): number {
  let k = 0;
  for (let i = 0; i < m.length; i++) k += m[i];
  return k;
}

/** The cell of the region nearest its centre of mass (so it lies inside the region). */
function centroid(g: Grid, m: Mask): Point {
  let sx = 0, sy = 0, k = 0;
  for (let i = 0; i < m.length; i++)
    if (m[i]) {
      const p = cellToPoint(g, i % g.width, Math.floor(i / g.width));
      sx += p.x;
      sy += p.y;
      k++;
    }
  const mean = { x: sx / k, y: sy / k };
  let best = mean;
  let bestD = Infinity;
  for (let i = 0; i < m.length; i++)
    if (m[i]) {
      const p = cellToPoint(g, i % g.width, Math.floor(i / g.width));
      const d = distance(p, mean);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
  return best;
}

function nearestRouteM(g: Grid, layers: FeatureLayers, p: Point): number {
  const c0 = pointToCell(g, p);
  let best = Infinity;
  const R = Math.ceil(2000 / g.cellM);
  for (let r = Math.max(0, c0.row - R); r <= Math.min(g.height - 1, c0.row + R); r++)
    for (let c = Math.max(0, c0.col - R); c <= Math.min(g.width - 1, c0.col + R); c++)
      if (layers.route[r * g.width + c] >= ROUTE.track) best = Math.min(best, Math.hypot(r - c0.row, c - c0.col) * g.cellM);
  return best;
}

function lineOfCommunication(g: Grid, going: Float32Array, from: Point, to: Point, enemySees: Uint16Array): LineOfCommunication | null {
  const a = pointToCell(g, from);
  const b = pointToCell(g, to);
  const { cost, prev } = costDistance(g, going, [a.row * g.width + a.col]);
  const end = b.row * g.width + b.col;
  if (!Number.isFinite(cost[end])) return null;
  const cells: number[] = [];
  for (let i = end; i >= 0; i = prev[i]) cells.push(i);
  cells.reverse();
  const path = cells.map((i) => cellToPoint(g, i % g.width, Math.floor(i / g.width)));
  let len = 0;
  let exposed = 0;
  for (let k = 1; k < path.length; k++) {
    const d = distance(path[k - 1], path[k]);
    len += d;
    if (enemySees[cells[k]]) exposed += d;
  }
  return { path, lengthM: len, exposedShare: len ? exposed / len : 0 };
}

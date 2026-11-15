/**
 * Enemy company defence (PO, DECISIONS.md 109–116), on Russian doctrine and
 * lessons from Ukraine:
 *
 *  - a company strongpoint across the user's line of advance: two platoon
 *    strongpoints forward (about 400 × 300 m each, 500–900 m apart, which
 *    leaves a gap between them) and one in depth behind the gap;
 *  - sections (or, if dispersed, small teams) inside each platoon area,
 *    sited by the section logic the PO approved: fields of fire, flank or
 *    rear fire, reverse slope with an outpost on the crest, concealment,
 *    little dead ground;
 *  - the depth platoon sited to see into the forward platoons' dead ground;
 *  - company HQ behind, concealed;
 *  - optional elements, each included or not per scenario (PO 113): mines and
 *    obstacles, dummy positions, dispersed small teams, concealment against
 *    drones, drone surveillance and indirect fire.
 *
 * The direction of advance whose company defence scores highest is chosen.
 * Every placement is computed from the ground; weights and distances are
 * first figures for the PO to tune.
 */
import { gridMils, milsText } from '../geo/gridref';
import { bearingVector, distance, pointToCell, type Grid, type Mask, type Point } from '../terrain/grid';
import { viewshed, type Obstacles } from '../terrain/viewshed';
import { slope as slopeOf } from '../terrain/slope';
import type { FeatureLayers } from '../features/layers';
import { OPPOSITE, SIDE_BEARING, slopeOnlyGoing, type Side } from './approach';
import {
  analysisGrids,
  buildCtx,
  crestInFront,
  fwd,
  POSTURES,
  routeTowards,
  score,
  SECTION_SCORING,
  standable,
  type Ctx,
} from './sectionDefence';

export interface CompanyOptions {
  mines: boolean;
  dummies: boolean;
  dispersed: boolean;
  droneConcealment: boolean;
  isrFires: boolean;
}
export type OptionKey = keyof CompanyOptions;

/** Chance that the generator includes each element when left to decide. PO to tune. */
export const OPTION_CHANCE: Record<OptionKey, number> = {
  mines: 0.6,
  dummies: 0.5,
  dispersed: 0.4,
  droneConcealment: 0.6,
  isrFires: 0.5,
};

/** First figures, from doctrine (DECISIONS.md 112); PO to tune. */
export const COMPANY = {
  analysisCellM: 10,
  /**
   * Forward platoon centres this far ahead of the start: within the preferred
   * distance if the ground there allows a company defence; further out (up to
   * forwardMaxM) if nothing fits nearer, or the best ground further out is at
   * least `fartherIfBetterBy` times as good. PO, 15 Nov 2026: the enemy need
   * not be within 1,300 m, and the ground should win; so 1.0: the best ground
   * anywhere in range, with nearer ground winning a tie.
   */
  forwardMinM: 600,
  forwardPreferredM: 1300,
  forwardMaxM: 2500,
  fartherIfBetterBy: 1.0,
  /** Candidate positions are searched this far either side of the main route. */
  lateralMaxM: 1100,
  sampleM: 60,
  edgeMarginM: 150,
  platoonFrontM: 400,
  platoonDepthM: 300,
  forwardSpacingM: [500, 900] as const,
  /** The two forward platoons may differ in depth by at most this. */
  forwardStaggerM: 300,
  depthBehindM: [400, 800] as const,
  sectionsPerPlatoon: 3,
  sectionSpacingM: 100,
  /** Dispersed: this many small teams per platoon, at least this far apart. */
  teamsPerPlatoon: 5,
  teamSpacingM: 100,
  /** Mines: from this far in front of the forward positions, up to this deep. */
  mineFromM: 100,
  mineDepthM: [200, 500] as const,
  /** Mines lie within this distance of an approach route. */
  mineRouteM: 120,
  routes: 3,
  /** Mutual support: the ground within this distance of a position is "its" ground. */
  supportRadiusM: 100,
  /** Weight on mutual support when choosing positions (and between the forward platoons). */
  supportWeight: 1.0,
  /** A position counts as supported if another sees at least this share of the ground around it. */
  supportedShare: 0.3,
  /** Weight on the depth platoon seeing (covering by fire) the gap between the forward platoons. */
  gapWeight: 2,
};

export type PositionKind = 'section' | 'team' | 'outpost' | 'hq' | 'dummy';

export interface EnemyPosition {
  kind: PositionKind;
  platoon: string; // '1 Pl', '2 Pl', '3 Pl', 'Coy HQ', '—'
  label: string;
  point: Point;
  /** Number of men (approximate). */
  men: number;
}

export interface PlatoonArea {
  name: string;
  role: 'forward' | 'depth';
  centre: Point;
  /** Corners of the platoon area (local metres), for the map. */
  outline: Point[];
  positions: EnemyPosition[];
  /** True if its main position is on a reverse slope behind a crest. */
  reverseSlope: boolean;
}

export interface Gap {
  centre: Point;
  /** Distance between the nearest positions of the two forward platoons. */
  widthM: number;
  /** Share of the gap the depth platoon can see (and cover by fire). */
  coveredFromDepth: number;
  /** Share of the gap any fighting position can see (forward or depth). */
  coveredByAny: number;
}

export interface CompanyLayout {
  /** Edge nearest the attacker's side (approximate when the advance is not N/E/S/W). */
  attackerSide: Side;
  advanceBearingDeg: number;
  /** The attacker's likely routes forward from the start. */
  routes: Point[][];
  platoons: PlatoonArea[];
  hq: EnemyPosition | null;
  dummies: EnemyPosition[];
  options: CompanyOptions;
  gaps: Gap[];
  maskWidth: number;
  maskHeight: number;
  maskCellM: number;
  /** How many real positions cover each cell with fire (all round, within gun range); 2+ = interlocking. */
  killZone: Uint8Array;
  /** Ground within 300 m in front of the forward positions that no position can see. */
  deadGround: Mask;
  /** Mined and obstructed ground, if the option is on. */
  mines: Mask | null;
  /** Share of the ground under fire covered by two or more positions. */
  interlock: number;
  /** For each fighting position (label), the positions that can support it by fire. */
  support: { label: string; supportedBy: string[] }[];
  reasons: string[];
  log: string[];
}

export interface CompanyInput {
  grid: Grid;
  layers: FeatureLayers | null;
  obstacles?: Obstacles | null;
  /** Force elements on or off; any left undefined are decided by the generator. */
  options?: Partial<CompanyOptions>;
  /** Seed for the generator's choices; omit for the most defensible layout and no random elements. */
  seed?: number;
  start?: Point;
  /** Attacker sides to try (advance away from them): kept for tests. */
  sides?: Side[];
  /** Advance bearings to try, degrees. Default: four at right angles, randomly turned (16 points). */
  bearings?: number[];
  progress?: (message: string) => void;
}

/** Small seeded random number generator (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 16 points of the compass, for an advance bearing. */
export const COMPASS16 = [
  'north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east',
  'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west',
];
export const compass16 = (bearingDeg: number) => COMPASS16[Math.round((((bearingDeg % 360) + 360) % 360) / 22.5) % 16];
/** The advance as a grid bearing in mils (PO, 15 Nov 2026): "on 1590 mils". */
let dirCentre: { lat: number; lon: number } | undefined;
const DIR = (bearing: number) => `on ${dirCentre ? gridMils(bearing, dirCentre.lat, dirCentre.lon) : milsText(bearing)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

interface Cand {
  p: Point;
  total: number;
  reverse: boolean;
  vs: Mask;
}

/** Up to `routes` distinct routes forward: each new one avoids the ground near the last. */
function approachRoutes(cg: Grid, going: Float32Array, start: Point, bearingDeg: number, n: number): Point[][] {
  const g = new Float32Array(going);
  const out: Point[][] = [];
  for (let k = 0; k < n; k++) {
    const r = routeTowards(cg, g, start, bearingDeg);
    if (!r) break;
    if (!out.some((o) => similar(o, r))) out.push(r);
    // Make the ground near this route three times dearer for the next.
    const R = Math.ceil(150 / cg.cellM);
    for (const q of r) {
      const c = pointToCell(cg, q);
      for (let dr = -R; dr <= R; dr++)
        for (let dc = -R; dc <= R; dc++) {
          const rr = c.row + dr, cc = c.col + dc;
          if (rr < 0 || cc < 0 || rr >= cg.height || cc >= cg.width || dr * dr + dc * dc > R * R) continue;
          const i = rr * cg.width + cc;
          if (Number.isFinite(g[i]) && g[i] === going[i]) g[i] *= 3;
        }
    }
  }
  return out;
}

/** Two routes are the same if most of one lies within 100 m of the other. */
function similar(a: Point[], b: Point[]): boolean {
  let near = 0;
  for (let k = 0; k < b.length; k += 4) if (a.some((q) => distance(q, b[k]) < 100)) near++;
  return near / Math.ceil(b.length / 4) > 0.8;
}

/** Rectangle of a platoon area, aligned across the line of advance. */
function outline(centre: Point, u: Point, front: number, depth: number): Point[] {
  const v = { x: u.y, y: -u.x };
  const hf = front / 2, hd = depth / 2;
  return [
    [-hf, -hd], [hf, -hd], [hf, hd], [-hf, hd],
  ].map(([l, f]) => ({ x: centre.x + v.x * l + u.x * f, y: centre.y + v.y * l + u.y * f }));
}

function inArea(p: Point, centre: Point, u: Point, front: number, depth: number): boolean {
  const v = { x: u.y, y: -u.x };
  const dx = p.x - centre.x, dy = p.y - centre.y;
  return Math.abs(dx * v.x + dy * v.y) <= front / 2 && Math.abs(dx * u.x + dy * u.y) <= depth / 2;
}

/**
 * How well position `a` supports position `b`: the share of the ground
 * within 100 m of `b` that `a` can see (and so fire into). Uses `a`'s
 * viewshed (gun range).
 */
function supports(cg: Grid, a: Cand, b: Cand): number {
  const R = Math.ceil(COMPANY.supportRadiusM / cg.cellM);
  const c = pointToCell(cg, b.p);
  let total = 0, seen = 0;
  for (let dr = -R; dr <= R; dr++)
    for (let dc = -R; dc <= R; dc++) {
      if (dr * dr + dc * dc > R * R) continue;
      const r = c.row + dr, cc = c.col + dc;
      if (r < 0 || cc < 0 || r >= cg.height || cc >= cg.width) continue;
      total++;
      seen += a.vs[r * cg.width + cc];
    }
  return total ? seen / total : 0;
}

/** Mutual support between a new position and those already chosen: the best two-way support with any of them. */
function mutualWith(cg: Grid, c: Cand, chosen: Cand[]): number {
  let best = 0;
  for (const o of chosen) best = Math.max(best, (supports(cg, c, o) + supports(cg, o, c)) / 2);
  return best;
}

/**
 * Best positions within an area, kept apart, chosen one at a time: the first
 * on its own merits, each later one also on how well it and the positions
 * already chosen can fire into the ground around each other (PO: mutually
 * supporting positions with interlocking arcs).
 */
function bestIn(cg: Grid, cands: Cand[], centre: Point, u: Point, n: number, spacing: number): Cand[] {
  const inside = cands.filter((c) => inArea(c.p, centre, u, COMPANY.platoonFrontM, COMPANY.platoonDepthM));
  const out: Cand[] = [];
  while (out.length < n) {
    let best: Cand | null = null;
    let bestV = -Infinity;
    for (const c of inside) {
      if (out.includes(c) || out.some((o) => distance(o.p, c.p) < spacing)) continue;
      const v = c.total + (out.length ? COMPANY.supportWeight * mutualWith(cg, c, out) : 0);
      if (v > bestV) [bestV, best] = [v, c];
    }
    if (!best) break;
    out.push(best);
  }
  return out;
}

/** Position of every cell along (forward) and across (lateral) the line of advance, and its x, y. */
function cellFrames(cg: Grid, start: Point, u: Point) {
  const N = cg.width * cg.height;
  const F = new Float32Array(N), Lt = new Float32Array(N), X = new Float32Array(N), Y = new Float32Array(N);
  const half = (cg.width * cg.cellM) / 2;
  for (let r = 0; r < cg.height; r++)
    for (let c = 0; c < cg.width; c++) {
      const i = r * cg.width + c;
      const x = (c + 0.5) * cg.cellM - half - start.x;
      const y = half - (r + 0.5) * cg.cellM - start.y;
      X[i] = x + start.x;
      Y[i] = y + start.y;
      F[i] = x * u.x + y * u.y;
      Lt[i] = x * u.y - y * u.x;
    }
  return { F, Lt, X, Y };
}

/** Lay out one direction of advance. Returns null if no sensible defence fits. */
function layoutForSide(input: CompanyInput, base: ReturnType<typeof analysisGrids>, side: number, opts: CompanyOptions) {
  // `side` is the advance bearing, degrees (any of 16 compass points).
  const { cg, layers } = base;
  const C = COMPANY;
  const start = input.start ?? { x: 0, y: 0 };
  const slopeDeg = slopeOf(cg);
  const going = layers ? layers.going : slopeOnlyGoing(slopeDeg);
  const routes = approachRoutes(cg, going, start, side, C.routes);
  if (!routes.length) return { log: `Advancing ${DIR(side)}: no route forward.`, layout: null };

  const spec = { ...POSTURES.prepared, coverWeight: opts.droneConcealment ? 0.8 : POSTURES.prepared.coverWeight };
  const ctx: Ctx = buildCtx(base, spec, nearestSide((side + 180) % 360), start, routes, C.forwardMinM - 100, {
    advanceBearingDeg: side,
    minRouteCover: 0.1,
    openPenalty: opts.droneConcealment ? 0.5 : 0,
  });
  const u = ctx.u;
  const v = { x: u.y, y: -u.x };
  const lat = (p: Point) => (p.x - start.x) * v.x + (p.y - start.y) * v.y;
  const half = (cg.width * cg.cellM) / 2;

  // 1. Defensibility of every candidate position in the band ahead.
  const mainLat = (f: number) => {
    let best = routes[0][0];
    for (const q of routes[0]) if (Math.abs(fwd(ctx, q) - f) < Math.abs(fwd(ctx, best) - f)) best = q;
    return lat(best);
  };
  const cands: Cand[] = [];
  for (let y = -half + C.sampleM / 2; y < half; y += C.sampleM)
    for (let x = -half + C.sampleM / 2; x < half; x += C.sampleM) {
      const p = { x, y };
      const f = fwd(ctx, p);
      if (f < C.forwardMinM - C.platoonDepthM / 2 || f > C.forwardMaxM + C.depthBehindM[1] + C.platoonDepthM / 2) continue;
      if (half - Math.abs(x) < C.edgeMarginM || half - Math.abs(y) < C.edgeMarginM) continue;
      if (Math.abs(lat(p) - mainLat(f)) > C.lateralMaxM) continue;
      if (!standable(ctx, p)) continue;
      const s = score(ctx, p);
      if (s) cands.push({ p, total: s.total, reverse: s.reverseSlope, vs: s.vs });
    }
  if (cands.length < 6) return { log: `Advancing ${DIR(side)}: too little defensible ground ahead.`, layout: null };

  // 2. Two forward platoons: the pair of areas with the best positions, the
  //    right distance apart, at a similar depth.
  const n = opts.dispersed ? C.teamsPerPlatoon : C.sectionsPerPlatoon;
  const spacing = opts.dispersed ? C.teamSpacingM : C.sectionSpacingM;
  // A forward platoon must leave room behind it, inside the box, for the depth platoon.
  const depthRoom = C.depthBehindM[0] + C.platoonDepthM / 2;
  const inBox = (p: Point) => half - Math.abs(p.x) >= C.edgeMarginM && half - Math.abs(p.y) >= C.edgeMarginM;
  const centres = cands.filter((c) => {
    const f = fwd(ctx, c.p);
    return f >= C.forwardMinM && f <= C.forwardMaxM && inBox({ x: c.p.x + u.x * depthRoom, y: c.p.y + u.y * depthRoom });
  });
  const value = new Map<Cand, { v: number; picks: Cand[] }>();
  for (const c of centres) {
    const picks = bestIn(cg, cands, c.p, u, n, spacing);
    value.set(c, { v: picks.reduce((a, b) => a + b.total, 0) * (picks.length >= Math.min(3, n) ? 1 : 0.5), picks });
  }
  // Best pair within the preferred distance, and best pair anywhere.
  let near: [Cand, Cand] | null = null, nearV = -Infinity;
  let far: [Cand, Cand] | null = null, farV = -Infinity;
  for (const a of centres)
    for (const b of centres) {
      if (lat(a.p) >= lat(b.p)) continue;
      const d = lat(b.p) - lat(a.p);
      if (d < C.forwardSpacingM[0] || d > C.forwardSpacingM[1]) continue;
      if (Math.abs(fwd(ctx, a.p) - fwd(ctx, b.p)) > C.forwardStaggerM) continue;
      const va = value.get(a)!, vb = value.get(b)!;
      if (va.picks.some((x) => vb.picks.includes(x))) continue;
      // Bonus if the two forward platoons can support each other across the gap.
      let cross = 0;
      for (const x of va.picks) for (const y of vb.picks) cross = Math.max(cross, (supports(cg, x, y) + supports(cg, y, x)) / 2);
      const vv = va.v + vb.v + COMPANY.supportWeight * cross;
      if (vv > farV) [farV, far] = [vv, [a, b]];
      const isNear = Math.max(fwd(ctx, a.p), fwd(ctx, b.p)) <= C.forwardPreferredM;
      if (isNear && vv > nearV) [nearV, near] = [vv, [a, b]];
    }
  const pair = near && farV < C.fartherIfBetterBy * nearV ? near : far;
  const pairV = pair === near ? nearV : farV;
  if (!pair) return { log: `Advancing ${DIR(side)}: no two platoon areas fit the frontage.`, layout: null };

  const fwdPicks = [value.get(pair[0])!.picks, value.get(pair[1])!.picks];
  const forwardPositions = fwdPicks.flat();
  const frames = cellFrames(cg, start, u);

  // Dead ground in front of the forward positions (within 300 m), which the
  // depth platoon should be able to see into.
  const N = cg.width * cg.height;
  const seenFwd = new Uint8Array(N);
  for (const c of forwardPositions) for (let i = 0; i < N; i++) if (c.vs[i]) seenFwd[i] = 1;
  const frontLine = Math.min(...forwardPositions.map((c) => fwd(ctx, c.p)));
  const fwdDead = new Uint8Array(N);
  const deadCells: number[] = [];
  const latLo = Math.min(lat(pair[0].p), lat(pair[1].p)) - 300, latHi = Math.max(lat(pair[0].p), lat(pair[1].p)) + 300;
  for (let i = 0; i < N; i++) {
    const f = frames.F[i];
    if (f > frontLine + 50 || f < frontLine - 300 || seenFwd[i]) continue;
    if (frames.Lt[i] < latLo || frames.Lt[i] > latHi) continue;
    fwdDead[i] = 1;
    deadCells.push(i);
  }

  // 3. Depth platoon: behind, between the two forward platoons, sited to see
  //    into their dead ground and the gap, while staying hidden.
  const midF = (fwd(ctx, pair[0].p) + fwd(ctx, pair[1].p)) / 2;
  const loL = Math.min(lat(pair[0].p), lat(pair[1].p)) - 100, hiL = Math.max(lat(pair[0].p), lat(pair[1].p)) + 100;
  const deadTotal = deadCells.length;
  // The gap between the forward platoons: ground within 150 m of the midpoint
  // of their two nearest positions. Doctrine covers a gap with fire from depth.
  let ga = fwdPicks[0][0].p, gb = fwdPicks[1][0].p, gd = Infinity;
  for (const x of fwdPicks[0]) for (const y of fwdPicks[1]) if (distance(x.p, y.p) < gd) [gd, ga, gb] = [distance(x.p, y.p), x.p, y.p];
  const gapCentre = { x: (ga.x + gb.x) / 2, y: (ga.y + gb.y) / 2 };
  const gapCells: number[] = [];
  for (let i = 0; i < N; i++) if ((frames.X[i] - gapCentre.x) ** 2 + (frames.Y[i] - gapCentre.y) ** 2 <= 150 * 150) gapCells.push(i);
  const depthScore = (c: Cand) => {
    const vs = viewshed(cg, c.p, { obsHeightM: spec.eyeM, targetHeightM: SECTION_SCORING.attackerHeightM, maxRangeM: 1000, obstacles: ctx.obstacles });
    let seen = 0, gapSeen = 0;
    for (const i of deadCells) seen += vs[i];
    for (const i of gapCells) gapSeen += vs[i];
    const cc = pointToCell(cg, c.p);
    const exposure = ctx.attackerSees[cc.row * cg.width + cc.col] / ctx.nViewpoints;
    return (
      (deadTotal ? 2 * (seen / deadTotal) : 0) +
      (gapCells.length ? COMPANY.gapWeight * (gapSeen / gapCells.length) : 0) +
      0.5 * c.total -
      1.5 * exposure
    );
  };
  const depthCands = cands.filter((c) => {
    const f = fwd(ctx, c.p) - midF;
    return f >= C.depthBehindM[0] && f <= C.depthBehindM[1] && lat(c.p) >= loL && lat(c.p) <= hiL;
  });
  let depthCentre: Cand | null = null;
  let depthPicks: Cand[] = [];
  let depthBest = -Infinity;
  // Score each depth centre by the positions it would hold.
  const depthScored = new Map<Cand, number>();
  for (const c of depthCands) depthScored.set(c, depthScore(c));
  for (const c of depthCands) {
    const inside = depthCands
      .filter((d) => inArea(d.p, c.p, u, C.platoonFrontM, C.platoonDepthM))
      .sort((a, b) => depthScored.get(b)! - depthScored.get(a)!);
    const picks: Cand[] = [];
    for (const d of inside) {
      if (picks.length >= n) break;
      if (picks.every((o) => distance(o.p, d.p) >= spacing)) picks.push(d);
    }
    const val = picks.reduce((a, b) => a + depthScored.get(b)!, 0);
    if (picks.length && val > depthBest) [depthBest, depthCentre, depthPicks] = [val, c, picks];
  }

  return { log: '', layout: { routes, ctx, pair, fwdPicks, depthCentre, depthPicks, frontLine, value: pairV + Math.max(0, depthBest), cands, n, spacing, lat, fwdDead, deadTotal, frames } };
}

/** The box edge nearest a bearing. */
const nearestSide = (bearingDeg: number): Side => (['N', 'E', 'S', 'W'] as Side[])[Math.round((((bearingDeg % 360) + 360) % 360) / 90) % 4];

export function placeEnemyCompany(input: CompanyInput): CompanyLayout | null {
  dirCentre = input.grid.meta.centre;
  const random = input.seed === undefined ? null : rng(input.seed);
  const chance = (k: OptionKey) => (random ? random() < OPTION_CHANCE[k] : false);
  const options: CompanyOptions = {
    mines: input.options?.mines ?? chance('mines'),
    dummies: input.options?.dummies ?? chance('dummies'),
    dispersed: input.options?.dispersed ?? chance('dispersed'),
    droneConcealment: input.options?.droneConcealment ?? chance('droneConcealment'),
    isrFires: input.options?.isrFires ?? chance('isrFires'),
  };
  const base = analysisGrids(input, COMPANY.analysisCellM);
  const log: string[] = [];
  let best: { side: number; L: NonNullable<ReturnType<typeof layoutForSide>['layout']> } | null = null;
  // Advance bearings to try. Four at right angles, turned by 0, 22.5, 45 or
  // 67.5 degrees (own random stream), so any of the 16 compass points can come
  // up without trying all 16 (PO, 15 Nov 2026).
  const turn = input.seed === undefined ? 0 : Math.floor(rng(input.seed ^ 0x16) () * 4) * 22.5;
  const sides = input.bearings ?? (input.sides ? input.sides.map((s) => SIDE_BEARING[OPPOSITE[s]]) : [0, 90, 180, 270].map((b) => (b + turn) % 360));
  for (const [k, side] of sides.entries()) {
    input.progress?.(`Reading the ground for an enemy company: advance ${DIR(side)} (${k + 1} of ${sides.length})…`);
    const r = layoutForSide(input, base, side, options);
    if (!r.layout) {
      log.push(r.log);
      continue;
    }
    log.push(`Advancing ${DIR(side)}: company defence scores ${r.layout.value.toFixed(1)}.`);
    if (!best || r.layout.value > best.L.value) best = { side, L: r.layout };
  }
  if (!best) return null;

  const { side } = best;
  const L = best.L;
  const { ctx, pair, fwdPicks, depthCentre, depthPicks, cands } = L;
  const cg = ctx.cg;
  const u = ctx.u;
  const C = COMPANY;
  const N = cg.width * cg.height;

  // Platoons and their positions.
  const leftFirst = L.lat(pair[0].p) < L.lat(pair[1].p);
  const forwardOrder = leftFirst ? [0, 1] : [1, 0];
  const platoons: PlatoonArea[] = [];
  const posLabel = (k: number) => (options.dispersed ? `Team ${k + 1}` : `Section ${k + 1}`);
  const men = options.dispersed ? 3 : 8;
  forwardOrder.forEach((idx, k) => {
    const picks = fwdPicks[idx];
    const name = `En ${k + 1} Pl`;
    const positions: EnemyPosition[] = picks.map((c, j) => ({
      kind: options.dispersed ? 'team' : 'section', platoon: name, label: `${name} ${posLabel(j)}`, point: c.p, men,
    }));
    const reverse = picks.length > 0 && picks[0].reverse;
    if (reverse) {
      const crest = crestInFront(ctx, picks[0].p);
      if (crest && standable(ctx, crest.point)) {
        positions.push({ kind: 'outpost', platoon: name, label: `${name} outpost`, point: crest.point, men: 2 });
      }
    }
    platoons.push({
      name, role: 'forward', centre: pair[idx].p, reverseSlope: reverse,
      outline: outline(pair[idx].p, u, C.platoonFrontM, C.platoonDepthM), positions,
    });
  });
  if (depthCentre) {
    platoons.push({
      name: 'En 3 Pl', role: 'depth', centre: depthCentre.p, reverseSlope: depthPicks[0]?.reverse ?? false,
      outline: outline(depthCentre.p, u, C.platoonFrontM, C.platoonDepthM),
      positions: depthPicks.map((c, j) => ({ kind: options.dispersed ? 'team' : 'section', platoon: 'En 3 Pl', label: `En 3 Pl ${posLabel(j)}`, point: c.p, men })),
    });
  }
  const real = platoons.flatMap((p) => p.positions);

  // Company HQ: 150–400 m behind the depth platoon (or the forward line), as hidden as possible.
  let hq: EnemyPosition | null = null;
  {
    const ref = depthCentre?.p ?? pair[0].p;
    let bestHq: Point | null = null;
    let bestV = Infinity;
    for (let b = 150; b <= 400; b += 50)
      for (let l = -200; l <= 200; l += 50) {
        const p = { x: ref.x + u.x * b + (u.y) * l, y: ref.y + u.y * b + (-u.x) * l };
        if (!standable(ctx, p)) continue;
        const c = pointToCell(cg, p);
        if (c.col < 0 || c.row < 0 || c.col >= cg.width || c.row >= cg.height) continue;
        const i = c.row * cg.width + c.col;
        const v = ctx.attackerSees[i] + (ctx.obstacles && ctx.obstacles.heightM[i] >= 1 ? -0.5 : 0);
        if (v < bestV) [bestV, bestHq] = [v, p];
      }
    if (bestHq) hq = { kind: 'hq', platoon: 'Coy HQ', label: 'Coy HQ', point: bestHq, men: 6 };
  }

  // Dummies: good ground the enemy did not use, away from real positions.
  const dummies: EnemyPosition[] = [];
  if (options.dummies) {
    const order = [...cands].sort((a, b) => b.total - a.total);
    for (const c of order) {
      if (dummies.length >= 3) break;
      // Within the enemy's own area: up to 300 m in front of the forward line, 600 m behind it.
      const f = fwd(ctx, c.p);
      if (f < L.frontLine - 300 || f > L.frontLine + 600) continue;
      if (real.some((r) => distance(r.point, c.p) < 250) || dummies.some((d) => distance(d.point, c.p) < 250)) continue;
      dummies.push({ kind: 'dummy', platoon: '—', label: `Dummy ${dummies.length + 1}`, point: c.p, men: 0 });
    }
  }

  // Kill zone and dead ground in front, from all real fighting positions.
  const { F, X, Y } = L.frames;
  const killZone = new Uint8Array(N);
  const seen300 = new Uint8Array(N);
  const spec = POSTURES.prepared;
  const r2 = spec.rifleRangeM ** 2;
  const fighting = real.filter((r) => r.kind !== 'outpost' && r.kind !== 'hq');
  const views: Cand[] = [];
  for (const r of fighting) {
    const vs = viewshed(cg, r.point, { obsHeightM: spec.eyeM, targetHeightM: SECTION_SCORING.attackerHeightM, maxRangeM: spec.gunRangeM, obstacles: ctx.obstacles });
    views.push({ p: r.point, vs, total: 0, reverse: false });
    // Russian strongpoints are built for all-round defence: count fire in every direction.
    for (let i = 0; i < N; i++) {
      if (!vs[i]) continue;
      if (killZone[i] < 255) killZone[i]++;
      if ((X[i] - r.point.x) ** 2 + (Y[i] - r.point.y) ** 2 <= r2) seen300[i] = 1;
    }
  }
  const forwardReal = real.filter((r) => platoons.find((p) => p.name === r.platoon)?.role === 'forward' && r.kind !== 'outpost');
  const deadGround = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (seen300[i] || F[i] > L.frontLine) continue;
    if (forwardReal.some((r) => (X[i] - r.point.x) ** 2 + (Y[i] - r.point.y) ** 2 <= r2)) deadGround[i] = 1;
  }

  // Gap between the forward platoons, and how well the depth platoon covers it.
  const gaps: Gap[] = [];
  {
    const a = platoons[0].positions.filter((p) => p.kind !== 'outpost');
    const b = platoons[1].positions.filter((p) => p.kind !== 'outpost');
    let dMin = Infinity;
    let pa = a[0]?.point, pb = b[0]?.point;
    for (const x of a) for (const y of b) if (distance(x.point, y.point) < dMin) [dMin, pa, pb] = [distance(x.point, y.point), x.point, y.point];
    if (pa && pb) {
      const centre = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      // Cells within 150 m of the gap centre, in front of the depth platoon.
      let total = 0, covered = 0, any = 0;
      const depthVs = platoons[2]
        ? platoons[2].positions.map((p) => viewshed(cg, p.point, { obsHeightM: spec.eyeM, targetHeightM: SECTION_SCORING.attackerHeightM, maxRangeM: 1000, obstacles: ctx.obstacles }))
        : [];
      for (let i = 0; i < N; i++) {
        if ((X[i] - centre.x) ** 2 + (Y[i] - centre.y) ** 2 > 150 * 150) continue;
        total++;
        const fromDepth = depthVs.some((vs) => vs[i]);
        if (fromDepth) covered++;
        if (fromDepth || views.some((v) => v.vs[i])) any++;
      }
      gaps.push({ centre, widthM: dMin, coveredFromDepth: total ? covered / total : 0, coveredByAny: total ? any / total : 0 });
    }
  }

  // Mines and obstacles: across the approaches in front of the forward line,
  // where they are covered by fire or lie in the defence's dead ground.
  let mines: Mask | null = null;
  if (options.mines) {
    mines = new Uint8Array(N);
    const depth = random ? C.mineDepthM[0] + random() * (C.mineDepthM[1] - C.mineDepthM[0]) : C.mineDepthM[1];
    const lo = Math.min(...forwardReal.map((r) => L.lat(r.point))) - 200;
    const hi = Math.max(...forwardReal.map((r) => L.lat(r.point))) + 200;
    // Cells near any approach route.
    const nearRoute = new Uint8Array(N);
    const R = Math.ceil(C.mineRouteM / cg.cellM);
    for (const r of L.routes)
      for (const p of r) {
        const c = pointToCell(cg, p);
        for (let dr = -R; dr <= R; dr++)
          for (let dc = -R; dc <= R; dc++) {
            const rr = c.row + dr, cc = c.col + dc;
            if (rr >= 0 && cc >= 0 && rr < cg.height && cc < cg.width) nearRoute[rr * cg.width + cc] = 1;
          }
      }
    for (let i = 0; i < N; i++) {
      const f = L.frontLine - F[i];
      if (f < C.mineFromM || f > C.mineFromM + depth) continue;
      if (L.frames.Lt[i] < lo || L.frames.Lt[i] > hi) continue;
      if (!nearRoute[i] || !(killZone[i] || deadGround[i] || L.fwdDead[i])) continue;
      mines[i] = 1;
    }
  }

  // Interlocking arcs: share of the ground under fire covered by two or more positions.
  let under = 0, twoPlus = 0;
  for (let i = 0; i < N; i++) {
    if (!killZone[i]) continue;
    under++;
    if (killZone[i] >= 2) twoPlus++;
  }
  const interlock = under ? twoPlus / under : 0;
  // Mutual support: which other positions can fire into the ground around each one.
  const supportedBy = fighting.map((_, k) =>
    fighting.filter((_, j) => j !== k && supports(cg, views[j], views[k]) >= COMPANY.supportedShare).map((o) => o.label),
  );
  const unsupported = fighting.filter((_, k) => supportedBy[k].length === 0).map((r) => r.label);

  // Reasons (for the DS), from the computed facts.
  const reasons: string[] = [];
  reasons.push(
    `Company strongpoint blocking movement ${DIR(side)}: two platoons forward about ${Math.round(
      Math.abs(L.lat(pair[0].p) - L.lat(pair[1].p)),
    )} m apart and ${Math.round(L.frontLine)} m ahead of you, one platoon in depth.`,
  );
  for (const p of platoons) {
    const s = p.positions.filter((x) => x.kind !== 'outpost').length;
    reasons.push(
      `${p.name} (${p.role}): ${s} ${options.dispersed ? 'small teams' : 'sections'}${p.reverseSlope ? ', on a reverse slope behind a crest' : ''}` +
        `${p.positions.some((x) => x.kind === 'outpost') ? ', with an outpost on the crest' : ''}.`,
    );
  }
  reasons.push(`Interlocking arcs: ${pct(interlock)} of the ground under the company's fire is covered by two or more positions.`);
  reasons.push(
    `Mutual support: ${fighting.length - unsupported.length} of ${fighting.length} positions can be supported by fire from at least one other ` +
      `(it sees at least ${pct(COMPANY.supportedShare)} of the ground within ${COMPANY.supportRadiusM} m of them).` +
      (unsupported.length ? ` Not supported: ${unsupported.join(', ')}.` : ''),
  );
  if (gaps[0]) {
    reasons.push(
      `Gap between En 1 and En 2 Pl: about ${Math.round(gaps[0].widthM)} m between their nearest positions. Of the ground within 150 m of its centre, ` +
        `the depth platoon sees ${pct(gaps[0].coveredFromDepth)} and the company as a whole ${pct(gaps[0].coveredByAny)}.` +
        (gaps[0].coveredByAny < 0.5 ? ' The gap is poorly covered by fire: a weakness in this defence.' : ''),
    );
  }
  if (L.deadTotal) {
    let dz = 0;
    for (let i = 0; i < N; i++) dz += deadGround[i];
    reasons.push(`Dead ground within 300 m in front of the forward positions that no enemy position can see: about ${Math.round((dz * cg.cellM * cg.cellM) / 10000)} ha.`);
  }
  if (options.mines && mines) {
    let m = 0;
    for (let i = 0; i < N; i++) m += mines[i];
    reasons.push(`Mines and obstacles across the approaches: about ${Math.round((m * cg.cellM * cg.cellM) / 10000)} ha, from ${C.mineFromM} m in front of the forward positions.`);
  }
  if (options.dummies) reasons.push(`${dummies.length} dummy positions on good ground the enemy did not use.`);
  if (options.droneConcealment) reasons.push('Positions sited for concealment from drones: tree lines, hedges and cover preferred, open ground avoided.');
  if (options.isrFires) reasons.push('The enemy has drone surveillance over the approaches and indirect fire on call.');

  return {
    attackerSide: nearestSide((side + 180) % 360),
    advanceBearingDeg: side,
    routes: L.routes,
    platoons,
    hq,
    dummies,
    options,
    gaps,
    maskWidth: cg.width,
    maskHeight: cg.height,
    maskCellM: cg.cellM,
    killZone,
    deadGround,
    mines,
    interlock,
    support: fighting.map((r, k) => ({ label: r.label, supportedBy: supportedBy[k] })),
    reasons,
    log,
  };
}

/** Unit vector of the attacker's movement for a layout (for the map). */
export const advanceVector = (l: CompanyLayout) => bearingVector(l.advanceBearingDeg);

/**
 * Enemy section defence: read the ground and place a likely enemy section
 * blocking the user's line of advance (PO direction, DECISIONS.md 81–84, 97+).
 *
 * 1. Frame. For each direction of advance, find the easiest route (least
 *    "going") from the user's start to the far side of the box. The enemy
 *    blocks it.
 * 2. Candidates. Every position 250–900 m ahead of the start and within
 *    400 m of that route is scored on what a section commander looks for:
 *      - fields of fire over the approach (gun range) and over the route;
 *      - dead ground in front within rifle range (less is better);
 *      - concealment from where the attacker will be looking from;
 *      - not skylined;
 *      - enfilade: seeing the route obliquely, so fire runs along it;
 *      - nearby cover (hedge, wall, wood edge);
 *      - a covered route to the rear.
 *    The best few are refined at 10 m.
 * 3. Direction. The app keeps the direction whose best position scores
 *    highest: the most defensible block (PO decision 84).
 * 4. Layout. Two fire teams 40 m apart across the line of advance; the gun
 *    goes with the team that sees more of the route.
 *
 * Everything is computed from the ground, features and line of sight. The
 * weights and thresholds are first guesses for the PO to tune.
 */
import { bearingVector, cellToPoint, distance, pointToCell, type Grid, type Mask, type Point } from '../terrain/grid';
import { viewshed, visibilityCount, type Obstacles } from '../terrain/viewshed';
import { isSilhouetted } from '../terrain/crest';
import { slope as slopeOf } from '../terrain/slope';
import { COVER, ROUTE, type FeatureLayers } from '../features/layers';
import { costDistance, edgeCells, OPPOSITE, SIDE_BEARING, slopeOnlyGoing, type Side } from './approach';
import { downsample, downsampleObstacles } from './enemyOps';

export type Posture = 'prepared' | 'hasty';

export interface PostureSpec {
  label: string;
  /** How the section is described in the scenario. */
  description: string;
  strength: number;
  /** Eye height of a defender above the ground. */
  eyeM: number;
  /** How much of a defender shows above the ground to the attacker. */
  exposedM: number;
  rifleRangeM: number;
  gunRangeM: number;
  /** Extra weight on nearby cover: a hasty position relies on what is already there. */
  coverWeight: number;
}

/** PO to confirm (DECISIONS.md 98). */
export const POSTURES: Record<Posture, PostureSpec> = {
  prepared: {
    label: 'Prepared defence',
    description: 'dug in, in fire trenches',
    strength: 8,
    eyeM: 1.2,
    exposedM: 0.5,
    rifleRangeM: 300,
    gunRangeM: 600,
    coverWeight: 0.3,
  },
  hasty: {
    label: 'Hasty defence',
    description: 'in hasty fire positions, using the cover available',
    strength: 8,
    eyeM: 0.6,
    exposedM: 0.6,
    rifleRangeM: 300,
    gunRangeM: 600,
    coverWeight: 0.6,
  },
};

/** Scoring settings: first guesses, PO to tune (DECISIONS.md 99). */
export const SECTION_SCORING = {
  /** Height of an attacking man moving crouched, for fields of fire and dead ground. */
  attackerHeightM: 1.5,
  /** Height of a man moving upright, for the covered route to the rear. */
  manHeightM: 1.8,
  forwardMinM: 250,
  forwardMaxM: 900,
  lateralMaxM: 400,
  sampleM: 50,
  /** Positions are kept at least this far inside the box. */
  edgeMarginM: 200,
  refineM: 10,
  /** Analysis cell size: the LIDAR is thinned to this for speed (keeping the tallest obstacle in each block). */
  analysisCellM: 5,
  /** A position must see at least this share of the route in range to block it. */
  minRouteCover: 0.3,
  /** Fire teams this far apart, across the line of advance. */
  teamSpacingM: 40,
  /** "Fire along the route" if within this angle of it. */
  enfiladeDeg: 30,
  weights: { fields: 2, route: 1.5, dead: 1.5, exposure: 1.5, enfilade: 0.5, rear: 0.3, skyline: 0.5 },
};

export type Intel = 'exact' | 'area' | 'direction';

export interface SectionScores {
  /** Share of the approach in front within gun range that the section can see. */
  fieldsOfFire: number;
  /** Share of the route in front within gun range that the section can see. */
  routeCover: number;
  /** Share of the ground in front within rifle range that the section cannot see. */
  deadGround: number;
  /** Share of the attacker's viewpoints that can see the position. */
  exposure: number;
  /** Share of the route the section sees that it sees along its length (enfilade). */
  enfilade: number;
  nearCover: boolean;
  /** Share of the ground 50–150 m behind that the attacker cannot see. */
  coveredRear: number;
  skylined: boolean;
  total: number;
}

export interface FireTeam {
  label: string;
  point: Point;
  gun: boolean;
}

export interface SectionLayout {
  posture: Posture;
  /** Side of the box the attacker (the user) comes from. */
  attackerSide: Side;
  /** Bearing of the attacker's movement (e.g. 0 = moving north). */
  advanceBearingDeg: number;
  route: Point[];
  routeKind: 'road' | 'track' | 'across country';
  position: Point;
  teams: FireTeam[];
  scores: SectionScores;
  /** Other good positions considered (DS). */
  alternatives: { point: Point; total: number }[];
  /** Where the attacker was assumed to be looking from. */
  attackerViewpoints: Point[];
  /** Analysis grid the masks below are on. */
  maskWidth: number;
  maskHeight: number;
  maskCellM: number;
  /** Ground the section covers by fire (gun range for the gun team, rifle range otherwise). */
  killZone: Mask;
  /** Ground within rifle range in front that the section cannot see: the attacker's covered approach. */
  deadGround: Mask;
  /** Plain-English reasons for the choice, from the computed facts. */
  reasons: string[];
  /** One line per direction tried. */
  log: string[];
}

export interface SectionInput {
  grid: Grid;
  layers: FeatureLayers | null;
  obstacles?: Obstacles | null;
  posture: Posture;
  /** Where the user starts (local metres). Default: box centre. */
  start?: Point;
  /** Pick among the best few positions at random for variety (0–1). Omit for the best. */
  random?: number;
  sides?: Side[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Prepare a coarser analysis grid with matching features and obstacles. */
function analysisGrids(input: SectionInput) {
  const g = input.grid;
  const factor = Math.max(1, Math.round(SECTION_SCORING.analysisCellM / g.cellM));
  const cg = downsample(g, factor);
  const obstacles = input.obstacles ? downsampleObstacles(g, input.obstacles, factor, 'max') : undefined;
  // Land cover and going on the coarse grid: take the block's top-left cell
  // (features are 10 m+ wide, so nothing that matters is lost at 4 m).
  let layers: FeatureLayers | null = null;
  if (input.layers) {
    const L = input.layers;
    const pick = <T extends Uint8Array | Float32Array>(a: T, make: (n: number) => T): T => {
      const out = make(cg.width * cg.height);
      for (let r = 0; r < cg.height; r++) for (let c = 0; c < cg.width; c++) out[r * cg.width + c] = a[r * factor * g.width + c * factor];
      return out;
    };
    const u8 = (n: number) => new Uint8Array(n);
    layers = {
      ...L,
      cover: pick(L.cover, u8),
      route: pick(L.route, u8),
      river: pick(L.river, u8),
      stream: pick(L.stream, u8),
      railway: pick(L.railway, u8),
      hedge: pick(L.hedge, u8),
      cliff: pick(L.cliff, u8),
      crossing: pick(L.crossing, u8),
      excluded: pick(L.excluded, u8),
      standOk: pick(L.standOk, u8),
      going: pick(L.going, (n) => new Float32Array(n)),
    };
  }
  return { cg, obstacles, layers };
}

interface Ctx {
  cg: Grid;
  obstacles?: Obstacles;
  layers: FeatureLayers | null;
  spec: PostureSpec;
  u: Point; // direction of the attacker's movement
  start: Point;
  route: Point[];
  routeDir: Point[]; // unit direction of the route at each point
  attackerSees: Uint16Array; // how many attacker viewpoints see a defender at each cell
  attackerSeesMan: Uint16Array; // same, for a man moving upright
  nViewpoints: number;
  attackerBearing: number; // from the defence towards the attacker
}

const fwd = (ctx: Ctx, p: Point) => (p.x - ctx.start.x) * ctx.u.x + (p.y - ctx.start.y) * ctx.u.y;

function standable(ctx: Ctx, p: Point): boolean {
  const c = pointToCell(ctx.cg, p);
  if (c.col < 0 || c.row < 0 || c.col >= ctx.cg.width || c.row >= ctx.cg.height) return false;
  const i = c.row * ctx.cg.width + c.col;
  if (ctx.layers) {
    const cv = ctx.layers.cover[i];
    if (cv === COVER.water || cv === COVER.wetland || cv === COVER.building) return false;
  }
  return true;
}

/** Easiest route (least going) from the start to the given edge of the box. */
function routeFromStart(g: Grid, going: Float32Array, start: Point, toSide: Side): Point[] | null {
  const sc = pointToCell(g, start);
  const s0 = sc.row * g.width + sc.col;
  const { cost, prev } = costDistance(g, going, [s0]);
  let end = -1;
  let best = Infinity;
  for (const i of edgeCells(g, toSide)) if (cost[i] < best) [best, end] = [cost[i], i];
  if (end < 0 || !Number.isFinite(best)) return null;
  const cells: number[] = [];
  for (let i = end; i >= 0; i = prev[i]) cells.push(i);
  cells.reverse();
  return cells.map((i) => cellToPoint(g, i % g.width, Math.floor(i / g.width)));
}

/** Score one position. Returns null if it does not block the route. */
function score(ctx: Ctx, p: Point): (SectionScores & { vs: Mask }) | null {
  const { cg, spec } = ctx;
  const S = SECTION_SCORING;
  const vs = viewshed(cg, p, { obsHeightM: spec.eyeM, targetHeightM: S.attackerHeightM, maxRangeM: spec.gunRangeM, obstacles: ctx.obstacles });
  const pc = pointToCell(cg, p);
  const R = Math.ceil(spec.gunRangeM / cg.cellM);
  // Ground in front: cells whose offset from the position points back
  // towards the attacker (forward component below -20 m), within range.
  const cm = cg.cellM;
  const gun2 = (spec.gunRangeM / cm) ** 2;
  const rifle2 = (spec.rifleRangeM / cm) ** 2;
  const frontLimit = -20 / cm;
  let front = 0, frontSeen = 0, rifle = 0, rifleSeen = 0;
  for (let dr = -R; dr <= R; dr++) {
    const r = pc.row + dr;
    if (r < 0 || r >= cg.height) continue;
    for (let dc = -R; dc <= R; dc++) {
      const c = pc.col + dc;
      if (c < 0 || c >= cg.width) continue;
      // Offset in cells: east = dc, north = -dr.
      if (dc * ctx.u.x - dr * ctx.u.y > frontLimit) continue;
      const d2 = dc * dc + dr * dr;
      if (d2 > gun2) continue;
      const seen = vs[r * cg.width + c];
      front++;
      frontSeen += seen;
      if (d2 <= rifle2) {
        rifle++;
        rifleSeen += seen;
      }
    }
  }
  const fp = fwd(ctx, p);
  // Route in front, within gun range.
  let rIn = 0, rSeen = 0, rAlong = 0;
  const cosEnf = Math.cos((S.enfiladeDeg * Math.PI) / 180);
  ctx.route.forEach((q, k) => {
    if (fwd(ctx, q) > fp - 20 || distance(p, q) > spec.gunRangeM) return;
    rIn++;
    const qc = pointToCell(cg, q);
    if (!vs[qc.row * cg.width + qc.col]) return;
    rSeen++;
    const d = distance(p, q) || 1;
    const lx = (q.x - p.x) / d, ly = (q.y - p.y) / d;
    if (Math.abs(lx * ctx.routeDir[k].x + ly * ctx.routeDir[k].y) >= cosEnf) rAlong++;
  });
  const routeCover = rIn ? rSeen / rIn : 0;
  if (routeCover < S.minRouteCover) return null;

  const i = pc.row * cg.width + pc.col;
  const exposure = ctx.nViewpoints ? ctx.attackerSees[i] / ctx.nViewpoints : 0;

  // Cover within 15 m: something at least 1 m tall (hedge, wall, wood edge).
  let nearCover = false;
  if (ctx.obstacles) {
    const r15 = Math.ceil(15 / cg.cellM);
    for (let dr = -r15; dr <= r15 && !nearCover; dr++)
      for (let dc = -r15; dc <= r15; dc++) {
        const rr = pc.row + dr, cc = pc.col + dc;
        if (rr >= 0 && cc >= 0 && rr < cg.height && cc < cg.width && ctx.obstacles.heightM[rr * cg.width + cc] >= 1) {
          nearCover = true;
          break;
        }
      }
  }

  // Covered rear: ground 50–150 m behind, within 30 m either side.
  let rear = 0, rearHidden = 0;
  const v = { x: ctx.u.y, y: -ctx.u.x };
  for (let b = 50; b <= 150; b += cg.cellM * 2)
    for (let l = -30; l <= 30; l += cg.cellM * 2) {
      const q = { x: p.x + ctx.u.x * b + v.x * l, y: p.y + ctx.u.y * b + v.y * l };
      const qc = pointToCell(cg, q);
      if (qc.col < 0 || qc.row < 0 || qc.col >= cg.width || qc.row >= cg.height) continue;
      rear++;
      if (!ctx.attackerSeesMan[qc.row * cg.width + qc.col]) rearHidden++;
    }
  const coveredRear = rear ? rearHidden / rear : 0;

  const sil = isSilhouetted(cg, p, ctx.attackerBearing, { targetHeightM: spec.exposedM, notionalEnemyRangeM: 600 });
  const skylined = sil.silhouetted && sil.visibleToEnemy && !sil.ranOffGrid;

  const scores = {
    fieldsOfFire: front ? frontSeen / front : 0,
    routeCover,
    deadGround: rifle ? 1 - rifleSeen / rifle : 1,
    exposure,
    enfilade: rSeen ? rAlong / rSeen : 0,
    nearCover,
    coveredRear,
    skylined,
  };
  const w = S.weights;
  const total =
    w.fields * scores.fieldsOfFire +
    w.route * scores.routeCover -
    w.dead * scores.deadGround -
    w.exposure * scores.exposure +
    w.enfilade * scores.enfilade +
    spec.coverWeight * (nearCover ? 1 : 0) +
    w.rear * coveredRear -
    w.skyline * (skylined ? 1 : 0);
  return { ...scores, total, vs };
}

/** Place a section for one direction of advance. */
function placeForSide(input: SectionInput, base: ReturnType<typeof analysisGrids>, attackerSide: Side) {
  const { cg, obstacles, layers } = base;
  const S = SECTION_SCORING;
  const spec = POSTURES[input.posture];
  const slopeDeg = slopeOf(cg);
  const going = layers ? layers.going : slopeOnlyGoing(slopeDeg);
  // The attacker's route: the easiest way from the start (the user's point)
  // to the far side of the box in this direction.
  const start = input.start ?? { x: 0, y: 0 };
  const route = routeFromStart(cg, going, start, OPPOSITE[attackerSide]);
  if (!route) return { log: `Advancing ${dirName(attackerSide)}: no route from your position.`, best: null };

  const advanceBearingDeg = SIDE_BEARING[OPPOSITE[attackerSide]];
  const u = bearingVector(advanceBearingDeg);
  const routeDir = route.map((_, k) => {
    const a = route[Math.max(0, k - 3)];
    const b = route[Math.min(route.length - 1, k + 3)];
    const d = distance(a, b) || 1;
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  });

  // Where the attacker will be looking from: the start, points either side of
  // it, and the route between the start and the nearest candidate positions.
  const v = { x: u.y, y: -u.x };
  const viewpoints: Point[] = [start, { x: start.x + v.x * 200, y: start.y + v.y * 200 }, { x: start.x - v.x * 200, y: start.y - v.y * 200 }];
  for (const q of route) {
    const f = (q.x - start.x) * u.x + (q.y - start.y) * u.y;
    if (f > -300 && f < S.forwardMinM - 50 && !viewpoints.some((w) => distance(w, q) < 120)) viewpoints.push(q);
  }
  const vpObs = viewpoints.map((p) => ({ point: p }));
  const attackerSees = visibilityCount(cg, vpObs, { obsHeightM: 2, targetHeightM: spec.exposedM, maxRangeM: 1500, obstacles });
  const attackerSeesMan = visibilityCount(cg, vpObs, { obsHeightM: 2, targetHeightM: S.manHeightM, maxRangeM: 1500, obstacles });

  const ctx: Ctx = {
    cg, obstacles, layers, spec, u, start, route, routeDir, attackerSees, attackerSeesMan,
    nViewpoints: viewpoints.length,
    attackerBearing: SIDE_BEARING[attackerSide],
  };

  // Coarse search.
  const half = (cg.width * cg.cellM) / 2;
  const found: { p: Point; s: NonNullable<ReturnType<typeof score>> }[] = [];
  for (let y = -half + S.sampleM / 2; y < half; y += S.sampleM) {
    for (let x = -half + S.sampleM / 2; x < half; x += S.sampleM) {
      const p = { x, y };
      const f = fwd(ctx, p);
      if (f < S.forwardMinM || f > S.forwardMaxM) continue;
      // Stay well inside the box, so the ground around the position is known.
      if (half - Math.abs(p.x) < S.edgeMarginM || half - Math.abs(p.y) < S.edgeMarginM) continue;
      if (Math.min(...route.map((q) => distance(p, q))) > S.lateralMaxM) continue;
      if (!standable(ctx, p)) continue;
      const s = score(ctx, p);
      if (s) found.push({ p, s });
    }
  }
  if (!found.length) return { log: `Advancing ${dirName(attackerSide)}: no position ahead covers enough of the route.`, best: null };
  found.sort((a, b) => b.s.total - a.s.total);
  // The best few, at least 150 m apart (refined later, for the chosen direction only).
  const tops: typeof found = [];
  for (const f of found) {
    if (tops.length >= 4) break;
    if (!tops.some((t) => distance(t.p, f.p) < 150)) tops.push(f);
  }
  return { log: '', best: { tops, ctx, route, advanceBearingDeg, attackerSide, viewpoints } };
}

/** Refine each of the best positions by trying points around it at 10 m spacing. */
function refine(ctx: Ctx, tops: { p: Point; s: NonNullable<ReturnType<typeof score>> }[]) {
  const S = SECTION_SCORING;
  const out = tops.map((f) => {
    let best = f;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const p = { x: f.p.x + dx * S.refineM, y: f.p.y + dy * S.refineM };
        if (!standable(ctx, p)) continue;
        const s = score(ctx, p);
        if (s && s.total > best.s.total) best = { p, s };
      }
    return best;
  });
  return out.sort((a, b) => b.s.total - a.s.total);
}

const dirName = (attackerSide: Side) => {
  const to = OPPOSITE[attackerSide];
  return `${{ N: 'north', E: 'east', S: 'south', W: 'west' }[to]}`;
};

export function placeEnemySection(input: SectionInput): SectionLayout | null {
  const base = analysisGrids(input);
  const sides = input.sides ?? (['S', 'W', 'N', 'E'] as Side[]);
  const log: string[] = [];
  let chosen: NonNullable<ReturnType<typeof placeForSide>['best']> | null = null;
  for (const side of sides) {
    const r = placeForSide(input, base, side);
    if (!r.best) {
      log.push(r.log);
      continue;
    }
    const t = r.best.tops[0].s;
    log.push(`Advancing ${dirName(side)}: best blocking position scores ${t.total.toFixed(2)} (sees ${pct(t.routeCover)} of the route in range, dead ground ${pct(t.deadGround)}).`);
    if (!chosen || t.total > chosen.tops[0].s.total) chosen = r.best;
  }
  if (!chosen) return null;

  // Pick the best, or one of the best few for variety.
  const ctx = chosen.ctx;
  const tops = refine(ctx, chosen.tops);
  const pickFrom = tops.filter((t) => t.s.total >= tops[0].s.total - 0.4).slice(0, 3);
  const pick = input.random === undefined ? pickFrom[0] : pickFrom[Math.min(pickFrom.length - 1, Math.floor(input.random * pickFrom.length))];
  const { cg, spec } = ctx;
  const S = SECTION_SCORING;

  // Fire teams across the line of advance; the gun with the team that sees more of the route.
  const v = { x: ctx.u.y, y: -ctx.u.x };
  const at = (k: number) => {
    for (let shrink = 1; shrink >= 0; shrink -= 0.25) {
      const p = { x: pick.p.x + v.x * k * shrink * (S.teamSpacingM / 2), y: pick.p.y + v.y * k * shrink * (S.teamSpacingM / 2) };
      if (standable(ctx, p)) return p;
    }
    return pick.p;
  };
  const tA = at(-1), tB = at(1);
  const sA = score(ctx, tA), sB = score(ctx, tB);
  const gunA = (sA?.routeCover ?? 0) + (sA?.enfilade ?? 0) * 0.5 >= (sB?.routeCover ?? 0) + (sB?.enfilade ?? 0) * 0.5;
  const teams: FireTeam[] = [
    { label: gunA ? 'Fire team 1 (gun)' : 'Fire team 1', point: tA, gun: gunA },
    { label: gunA ? 'Fire team 2' : 'Fire team 2 (gun)', point: tB, gun: !gunA },
  ];

  // Kill zone and dead ground in front, from both teams.
  const n = cg.width * cg.height;
  const killZone = new Uint8Array(n);
  const seenRifle = new Uint8Array(n);
  for (const t of teams) {
    const range = t.gun ? spec.gunRangeM : spec.rifleRangeM;
    const vs = viewshed(cg, t.point, { obsHeightM: spec.eyeM, targetHeightM: S.attackerHeightM, maxRangeM: range, obstacles: ctx.obstacles });
    const rifleVs = t.gun ? viewshed(cg, t.point, { obsHeightM: spec.eyeM, targetHeightM: S.attackerHeightM, maxRangeM: spec.rifleRangeM, obstacles: ctx.obstacles }) : vs;
    for (let i = 0; i < n; i++) {
      const q = cellToPoint(cg, i % cg.width, Math.floor(i / cg.width));
      if (fwd(ctx, q) > fwd(ctx, pick.p) - 10) continue;
      if (vs[i]) killZone[i] = 1;
      if (rifleVs[i]) seenRifle[i] = 1;
    }
  }
  const deadGround = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const q = cellToPoint(cg, i % cg.width, Math.floor(i / cg.width));
    if (fwd(ctx, q) > fwd(ctx, pick.p) - 10) continue;
    if (distance(q, pick.p) <= spec.rifleRangeM && !seenRifle[i]) deadGround[i] = 1;
  }

  // What the route mostly is, for the scenario text.
  let road = 0, track = 0;
  if (ctx.layers) {
    for (const q of chosen.route) {
      const c = pointToCell(cg, q);
      const r = ctx.layers.route[c.row * cg.width + c.col];
      if (r >= ROUTE.minorRoad) road++;
      else if (r === ROUTE.track) track++;
    }
  }
  const len = chosen.route.length || 1;
  const routeKind: SectionLayout['routeKind'] = road / len > 0.5 ? 'road' : (road + track) / len > 0.5 ? 'track' : 'across country';

  const s = pick.s;
  const reasons = [
    `Sees ${pct(s.routeCover)} of the ${routeKind === 'across country' ? 'approach route' : routeKind} in front within ${spec.gunRangeM} m, and ${pct(s.fieldsOfFire)} of all the ground in front within that range.`,
    `Dead ground within ${spec.rifleRangeM} m in front: ${pct(s.deadGround)} (the attacker's covered approach).`,
    `Seen from ${Math.round(s.exposure * ctx.nViewpoints)} of the ${ctx.nViewpoints} places the attacker was assumed to look from${s.skylined ? '; skylined' : '; not skylined'}.`,
    `${pct(s.enfilade)} of the route it sees is seen along its length (enfilade).`,
    s.nearCover ? 'Cover within 15 m (hedge, wall or wood edge).' : 'No hedge, wall or wood edge within 15 m.',
    `${pct(s.coveredRear)} of the ground 50–150 m behind is hidden from the attacker (a covered route back).`,
  ];

  return {
    posture: input.posture,
    attackerSide: chosen.attackerSide,
    advanceBearingDeg: chosen.advanceBearingDeg,
    route: chosen.route,
    routeKind,
    position: pick.p,
    teams,
    scores: { fieldsOfFire: s.fieldsOfFire, routeCover: s.routeCover, deadGround: s.deadGround, exposure: s.exposure, enfilade: s.enfilade, nearCover: s.nearCover, coveredRear: s.coveredRear, skylined: s.skylined, total: s.total },
    alternatives: tops.filter((t) => t !== pick).map((t) => ({ point: t.p, total: t.s.total })),
    attackerViewpoints: chosen.viewpoints,
    maskWidth: cg.width,
    maskHeight: cg.height,
    maskCellM: cg.cellM,
    killZone,
    deadGround,
    reasons,
    log,
  };
}

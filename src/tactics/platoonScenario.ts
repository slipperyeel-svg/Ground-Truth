/**
 * Infantry platoon scenario against a generated enemy company, written to the
 * scenario guidelines in docs/SCENARIO_GUIDELINES.md (G1–G13, from Moltke's
 * Tactical Problems), with the PO's intent-based task types (DECISIONS.md 110),
 * variable information (111), optional enemy elements (113) and a second
 * phase in which the situation develops (G11).
 *
 * Every fact in the text comes from the computed layout, ground and features
 * (core principle 1). The quality gate (core principle 2) asks for a real
 * trade-off: a covered route that saves exposure at the cost of time, or
 * mines on the obvious route.
 */
import { bearingVector, cellToPoint, distance, pointToCell, type Grid, type Point } from '../terrain/grid';
import { localToLatLon } from '../terrain/elevation';
import { viewshed, type Obstacles } from '../terrain/viewshed';
import { slope as slopeOf } from '../terrain/slope';
import { fromBNG, fromUTM, gridRef, inGreatBritain, toBNG, toUTM } from '../geo/gridref';
import { latLonToLocal } from '../terrain/elevation';
import { COVER, type FeatureLayers } from '../features/layers';
import { costDistance, slopeOnlyGoing } from './approach';
import { analysisGrids } from './sectionDefence';
import type { CompanyLayout, EnemyPosition } from './companyDefence';
import { hhmm, sunTimes } from './sun';

export type TaskType = 'secure' | 'neutralise' | 'findFix' | 'screen';
export type InfoLevel = 'rich' | 'partial' | 'poor';

export const TASK_LABEL: Record<TaskType, string> = {
  secure: 'Secure ground beyond',
  neutralise: 'Neutralise enemy in an area',
  findFix: 'Find and fix',
  screen: 'Screen a flank',
};

/** The quality gate for movement: PO to tune (DECISIONS.md 127). */
export const SCENARIO_GATE = {
  /** The covered route must cut the share of the route under enemy fire by at least this much… */
  minExposureSaving: 0.2,
  /** …and cost at least this much extra distance (otherwise there is no trade-off). */
  minExtraLength: 0.15,
  /** Mines on the obvious route only make a dilemma if avoiding them costs at least this much extra distance. */
  minMineDetour: 0.1,
  /** Route cost multipliers for the "covered route" the DS computes. */
  firePenalty: 4,
  minePenalty: 30,
};

export interface EnemyReport {
  /** What the report says. */
  text: string;
  /** Who or what it comes from, and when. */
  source: string;
  reliability: 'good' | 'fair' | 'doubtful';
}

export interface RouteFacts {
  path: Point[];
  lengthM: number;
  /** Share of the route under enemy fire (at least one real position covers it). */
  underFire: number;
  /** Mined cells crossed. */
  minesCrossed: number;
}

/** Map markers for the situation (APP-6 symbols and tactical graphics are drawn from these). */
export interface ScenarioMarkers {
  /** Friendly units, always shown. */
  friendly: { label: string; designation: string; higher: string; point: Point; echelon: 'platoon' | 'company'; hq?: boolean; own?: boolean;
    /** APP-6 unit type: infantry, or mechanised infantry (armour oval) for a Boxer-mounted battlegroup. */
    kind: 'infantry' | 'mechanisedInfantry' }[];
  /** Friendly control measures (2 up): company boundary, start line, phase line. */
  control: { kind: 'boundary' | 'phaseLine'; path: Point[]; label: string; /** Boundary: units on its [left, right], looking forward. */ sides?: [string, string] }[];
  /** The battlegroup objective. */
  bgObjective: { point: Point; name: string; onMap: boolean };
  /** Effects arrows (axes of advance), always shown. */
  axes: { label: string; path: Point[]; own: boolean }[];
  /** The task graphic on the objective. */
  task: { kind: TaskType; objective: Point; from: Point; across: Point; label: string };
  /** Enemy the scenario says has been seen: shown as suspected, in phase 1 or once the situation develops. */
  sightings: { phase: 1 | 2; point: Point; echelon: 'team' | 'section' | 'platoon'; label: string; dummy?: boolean }[];
  /** A suspected minefield outline, if reported (phase 1) or found (phase 2). */
  minefields: { phase: 1 | 2; outline: Point[]; label: string }[];
}

export type BgType = 'light' | 'mechanised';

/**
 * Made-up British-style battalions (none is a real regiment), so the problems
 * read naturally without implying any real unit.
 */
export const BATTALIONS = [
  { short: '1 SR', full: '1st Battalion, The Sandhurst Rifles' },
  { short: '2 PENNINE', full: '2nd Battalion, The Pennine Rifles' },
  { short: '1 MARCHES', full: '1st Battalion, The Marches Regiment' },
  { short: '3 FENLAND', full: '3rd Battalion, The Fenland Light Infantry' },
];
const OBJ_NAMES = ['HAWK', 'FALCON', 'KESTREL', 'MERLIN', 'HARRIER', 'OSPREY'];
const PL_NAMES = ['OAK', 'ASH', 'ELM', 'BIRCH', 'ROWAN', 'HAZEL'];

export interface PlatoonScenario {
  task: TaskType;
  info: InfoLevel;
  title: string;
  /** "Who you are" and your force (G2–G3). */
  you: string;
  force: { element: string; detail: string }[];
  /** Higher intent and your task (G4). */
  situation: string;
  /** Battlegroup type for this problem (varies). */
  bgType: BgType;
  /** Friendly forces 2 up and 1 up, and flanks (PO, 15 Nov 2026). */
  friendlyForces: { element: string; detail: string }[];
  task_text: string;
  /** Enemy information, each with source and reliability (G5). */
  enemy: EnemyReport[];
  enemyGaps: string;
  /** Time and light (G6). */
  time: string;
  /** Ground facts not on the map (G7). */
  ground: string[];
  /** Own troops (G8) and weather (G9). */
  ownTroops: string;
  weather: string;
  /** Two or three questions (G10). */
  questions: string[];
  timeAllowed: string;
  /** The time the problem is set for (ms since 1970). */
  startMs: number;
  /** Phase 2: the situation develops (G11). Replaced in the app by developments worked out from the user's plan (planEvents.ts). */
  phase2: { time: string; messages: { time: string; from: string; text: string }[]; questions: string[] };
  /** Ground truth facts, revealed after the user decides (G13: no school solution). */
  ds: string[];
  /** The objective or focus point and computed routes, for the DS map. */
  objective: Point;
  markers: ScenarioMarkers;
  direct: RouteFacts | null;
  covered: RouteFacts | null;
  /** Why it passed the quality gate, or why it is weak. */
  gate: string;
  dataNote: string;
}

export interface ScenarioInput {
  grid: Grid;
  layers: FeatureLayers | null;
  obstacles?: Obstacles | null;
  layout: CompanyLayout;
  task?: TaskType;
  info?: InfoLevel;
  seed: number;
  /** "Now", for the date and light. Default: the current time. */
  now?: Date;
  /** Time zone for clock times (the device's, by default). */
  timeZone?: string;
}

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

const DIRS = ['north', 'east', 'south', 'west'];
const dirOf = (bearing: number) => DIRS[Math.round(bearing / 90) % 4];
const pct = (x: number) => `${Math.round(x * 100)}%`;
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

export function writePlatoonScenario(input: ScenarioInput): PlatoonScenario {
  const random = rng(input.seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
  const L = input.layout;
  const g = input.grid;
  const base = analysisGrids({ grid: g, layers: input.layers, obstacles: input.obstacles }, L.maskCellM);
  const cg = base.cg;
  const lay = base.layers;
  const going = lay ? lay.going : slopeOnlyGoing(slopeOf(cg));
  const u = bearingVector(L.advanceBearingDeg);
  const v = { x: u.y, y: -u.x }; // to the right of the advance
  const fwd = (p: Point) => p.x * u.x + p.y * u.y;
  const lat = (p: Point) => p.x * v.x + p.y * v.y;
  const dir = dirOf(L.advanceBearingDeg);
  const start = { x: 0, y: 0 };

  const ref = (p: Point, fig: 3 | 4 = 3) => {
    const c = g.meta.centre;
    if (!c) return `(${Math.round(p.x)} m E, ${Math.round(p.y)} m N)`;
    const ll = localToLatLon(c, p.x, p.y);
    return gridRef(ll.lat, ll.lon, fig).ref;
  };
  const square = (p: Point) => {
    const six = ref(p).split(' ');
    return six.length === 3 ? `${six[0]} ${six[1].slice(0, 2)} ${six[2].slice(0, 2)}` : six.join(' ');
  };
  /** Centre of the 1 km grid square containing p (what a report "in grid square X" can locate). */
  const squareCentre = (p: Point): Point => {
    const c = g.meta.centre;
    if (!c) return p;
    const ll = localToLatLon(c, p.x, p.y);
    let back: { lat: number; lon: number };
    if (inGreatBritain(ll.lat, ll.lon)) {
      const b = toBNG(ll.lat, ll.lon);
      back = fromBNG(Math.floor(b.easting / 1000) * 1000 + 500, Math.floor(b.northing / 1000) * 1000 + 500);
    } else {
      const t = toUTM(ll.lat, ll.lon);
      back = fromUTM({ ...t, easting: Math.floor(t.easting / 1000) * 1000 + 500, northing: Math.floor(t.northing / 1000) * 1000 + 500 });
    }
    return latLonToLocal(c, back.lat, back.lon);
  };
  const sightings: ScenarioMarkers['sightings'] = [];
  function mineOutline(): Point[] {
    let fMin = Infinity, fMax = -Infinity, lMin = Infinity, lMax = -Infinity;
    if (L.mines)
      for (let i = 0; i < L.mines.length; i++) {
        if (!L.mines[i]) continue;
        const q = cellToPoint(cg, i % cg.width, Math.floor(i / cg.width));
        const f = q.x * u.x + q.y * u.y, l = q.x * v.x + q.y * v.y;
        fMin = Math.min(fMin, f); fMax = Math.max(fMax, f); lMin = Math.min(lMin, l); lMax = Math.max(lMax, l);
      }
    if (!Number.isFinite(fMin)) return [];
    return [[lMin, fMin], [lMax, fMin], [lMax, fMax], [lMin, fMax]].map(([l, f]) => ({ x: u.x * f + v.x * l, y: u.y * f + v.y * l }));
  }
  const minefields: ScenarioMarkers['minefields'] = [];
  const N = cg.width * cg.height;
  const cellOf = (p: Point) => {
    const c = pointToCell(cg, p);
    return c.col >= 0 && c.row >= 0 && c.col < cg.width && c.row < cg.height ? c.row * cg.width + c.col : -1;
  };

  // ---- The enemy, as laid out --------------------------------------------
  const fwdPl = L.platoons.filter((p) => p.role === 'forward');
  const depthPl = L.platoons.find((p) => p.role === 'depth') ?? null;
  const main = L.routes[0];
  const distToMain = (p: Point) => Math.min(...main.map((q) => distance(p, q)));
  const blocking = [...fwdPl].sort((a, b) => distToMain(a.centre) - distToMain(b.centre))[0];
  const other = fwdPl.find((p) => p !== blocking) ?? blocking;
  const frontLine = Math.min(...fwdPl.flatMap((p) => p.positions.map((x) => fwd(x.point))));
  const real = L.platoons.flatMap((p) => p.positions);
  const outposts = real.filter((x) => x.kind === 'outpost');

  // ---- Routes: direct (easiest going) and covered (avoiding enemy fire and mines) ----
  const coveredGoing = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let c = going[i];
    if (L.killZone[i]) c *= 1 + SCENARIO_GATE.firePenalty * Math.min(3, L.killZone[i]);
    if (L.mines && L.mines[i]) c *= SCENARIO_GATE.minePenalty;
    coveredGoing[i] = c;
  }
  const s0 = cellOf(start);
  const plain = costDistance(cg, going, [s0]);
  const safe = costDistance(cg, coveredGoing, [s0]);
  const routeTo = (prev: Int32Array, cost: Float64Array, p: Point): RouteFacts | null => {
    const e = cellOf(p);
    if (e < 0 || !Number.isFinite(cost[e])) return null;
    const cells: number[] = [];
    for (let i = e; i >= 0; i = prev[i]) cells.push(i);
    cells.reverse();
    const path = cells.map((i) => cellToPoint(cg, i % cg.width, Math.floor(i / cg.width)));
    let len = 0, fire = 0, mines = 0;
    for (let k = 1; k < cells.length; k++) {
      const d = distance(path[k - 1], path[k]);
      len += d;
      if (L.killZone[cells[k]]) fire += d;
      if (L.mines && L.mines[cells[k]]) mines++;
    }
    return { path, lengthM: len, underFire: len ? fire / len : 0, minesCrossed: mines };
  };

  // ---- Task and objective --------------------------------------------------
  const half = (cg.width * cg.cellM) / 2 - 150;
  const clampBox = (p: Point) => ({ x: Math.max(-half, Math.min(half, p.x)), y: Math.max(-half, Math.min(half, p.y)) });
  const objectiveFor = (t: TaskType): { point: Point; name: string } => {
    if (t === 'secure') {
      const beyond = (depthPl ? fwd(depthPl.centre) : frontLine + 500) + 300;
      const q = main.find((p) => fwd(p) >= beyond) ?? main[main.length - 1];
      return { point: clampBox(q), name: groundName(q) };
    }
    if (t === 'neutralise') return { point: blocking.centre, name: `the enemy in grid square ${square(blocking.centre)}` };
    if (t === 'findFix') {
      const gp = L.gaps[0]?.centre ?? blocking.centre;
      return { point: { x: gp.x - u.x * 250, y: gp.y - u.y * 250 }, name: `the enemy's forward positions` };
    }
    // Screen: the flank on the side of the forward platoon away from the main route.
    const side = Math.sign(lat(other.centre) - lat(blocking.centre)) || 1;
    const p = { x: start.x + v.x * side * 700 + u.x * Math.max(300, frontLine - 300), y: start.y + v.y * side * 700 + u.y * Math.max(300, frontLine - 300) };
    return { point: clampBox(p), name: `the company's ${side > 0 ? 'right' : 'left'} flank` };
  };
  function groundName(p: Point): string {
    const i = cellOf(p);
    if (lay && i >= 0) {
      if (lay.crossing[i]) return `the crossing at ${ref(p)}`;
      if (lay.cover[i] === COVER.wood) return `the wood edge at ${ref(p)}`;
      if (lay.cover[i] === COVER.builtUp || lay.cover[i] === COVER.building) return `the buildings at ${ref(p)}`;
    }
    const h = cg.data[i] ?? 0;
    let higher = 0, n = 0;
    for (let k = 0; k < N; k += 37) {
      n++;
      if (cg.data[k] > h) higher++;
    }
    if (n && higher / n < 0.25) return `the high ground at ${ref(p)}`;
    return `the track junction area at ${ref(p)}`;
  }

  const evaluate = (t: TaskType) => {
    const obj = objectiveFor(t);
    const direct = routeTo(plain.prev, plain.cost, obj.point);
    const covered = routeTo(safe.prev, safe.cost, obj.point);
    let ok = false;
    let why = '';
    if (direct && covered) {
      const saving = direct.underFire - covered.underFire;
      const extra = direct.lengthM ? covered.lengthM / direct.lengthM - 1 : 0;
      if (direct.minesCrossed > 0 && covered.minesCrossed === 0 && extra >= SCENARIO_GATE.minMineDetour) {
        ok = true;
        why = `the obvious route crosses mines; a route avoiding them exists (${pct(extra)} longer).`;
      } else if (saving >= SCENARIO_GATE.minExposureSaving && extra >= SCENARIO_GATE.minExtraLength) {
        ok = true;
        why = `a covered route cuts the share under enemy fire from ${pct(direct.underFire)} to ${pct(covered.underFire)}, at the cost of ${pct(extra)} more distance.`;
      } else if (saving >= SCENARIO_GATE.minExposureSaving) {
        why = `a covered route is better and hardly longer: little dilemma.`;
      } else {
        why = `no route avoids the enemy's fire much better than the obvious one.`;
      }
    } else why = 'no route to the objective.';
    return { t, obj, direct, covered, ok, why };
  };
  const order: TaskType[] = input.task ? [input.task] : (['secure', 'neutralise', 'findFix', 'screen'] as TaskType[]).sort(() => random() - 0.5);
  const tried = order.map(evaluate);
  const chosen = tried.find((x) => x.ok) ?? tried[0];
  const task = chosen.t;
  const objective = chosen.obj;
  const info: InfoLevel = input.info ?? pick(['rich', 'partial', 'partial', 'poor'] as InfoLevel[]);

  // ---- Time and light (G6) ---------------------------------------------------
  const centre = g.meta.centre ?? { lat: 51.5, lon: -1 };
  const now0 = input.now ?? new Date();
  const sun = sunTimes(centre.lat, centre.lon, now0);
  const dawn = random() < 0.6 && sun.firstLight;
  const nowT = dawn ? new Date(sun.firstLight!.getTime() - 25 * 60_000) : new Date((sun.sunset ?? now0).getTime() - 165 * 60_000);
  const byT = new Date(nowT.getTime() + (dawn ? 180 : 120) * 60_000);
  const tz = input.timeZone;
  const dateStr = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: tz }).format(nowT);
  const time = dawn
    ? `${dateStr}. Time now ${hhmm(nowT, tz)}. First light ${hhmm(sun.firstLight, tz)}, sunrise ${hhmm(sun.sunrise, tz)}. Your task is to be complete by ${hhmm(byT, tz)}.`
    : `${dateStr}. Time now ${hhmm(nowT, tz)}. Sunset ${hhmm(sun.sunset, tz)}, last light ${hhmm(sun.lastLight, tz)}: about ${Math.round(((sun.lastLight ?? sun.sunset ?? byT).getTime() - nowT.getTime()) / 3_600_000 * 10) / 10} hours of light remain. Your task is to be complete by ${hhmm(byT, tz)}.`;
  const t2 = new Date(nowT.getTime() + 40 * 60_000);

  // ---- Who you are, your force, situation and task (G2–G4) -------------------
  const leftRight = (p: Point) => (lat(p) >= 0 ? 'right' : 'left');
  // 2 up: battlegroup name and type (own random stream, so the other choices for a seed are unchanged).
  const r2 = rng(input.seed ^ 0x5eed2);
  const pick2 = <T>(xs: T[]) => xs[Math.floor(r2() * xs.length)];
  const bgType: BgType = r2() < 0.5 ? 'light' : 'mechanised';
  const bn = pick2(BATTALIONS);
  const neighbour = pick2(BATTALIONS.filter((b) => b !== bn));
  const bgObjName = `OBJ ${pick2(OBJ_NAMES)}`;
  const plName = `PL ${pick2(PL_NAMES)}`;
  const bg = `${bn.short} BG`;
  const infKind = bgType === 'mechanised' ? 'mechanisedInfantry' as const : 'infantry' as const;
  const you = `You command 2 Platoon, B Company, ${bn.full}${bgType === 'mechanised' ? ' (mechanised, in Boxer)' : ''}. Your company commander is with Company HQ.`;
  const force = bgType === 'light'
    ? [
        { element: '3 sections', detail: '8 men each: two fire teams, one general-purpose machine gun' },
        { element: 'Platoon HQ', detail: 'platoon commander, platoon sergeant, signaller, a small reconnaissance drone (about 30 minutes in the air)' },
        { element: 'Fire support', detail: 'battlegroup mortars on call through your company commander' },
      ]
    : [
        { element: '3 sections', detail: '8 men each, carried in a Boxer: two fire teams, one general-purpose machine gun' },
        { element: 'Vehicles', detail: '4 Boxer (one per section, one for platoon HQ), each with a remote weapon station (heavy or grenade machine gun). They can give fire support wherever they can see the enemy and survive.' },
        { element: 'Platoon HQ', detail: 'platoon commander, platoon sergeant, signaller, a small reconnaissance drone (about 30 minutes in the air)' },
        { element: 'Fire support', detail: 'battlegroup mortars on call through your company commander' },
      ];
  const along = (() => {
    if (!lay) return '';
    let road = 0, track = 0;
    for (const p of main) {
      const i = cellOf(p);
      if (i < 0) continue;
      if (lay.route[i] >= 3) road++;
      else if (lay.route[i] === 2) track++;
    }
    return road / main.length > 0.4 ? ' along the road' : (road + track) / main.length > 0.4 ? ' along the track' : '';
  })();
  const situation =
    `${bg} is advancing ${dir}${along} from ${ref(start)}. Enemy are believed to be defending the ground ahead to block that advance. ` +
    `B Company leads.`;
  const taskText = {
    secure: `Secure ${objective.name} by ${hhmm(byT, tz)}, in order to allow the battlegroup to pass ${dir}.`,
    neutralise: `Neutralise ${objective.name}, in order to open the route ${dir} for the battlegroup.`,
    findFix: `Find ${objective.name} across the company's front and fix them, in order to allow the company to attack them in the flank.`,
    screen: `Screen ${objective.name} as it advances, in order to give early warning of enemy moving against it and to stop small parties.`,
  }[task];
  const noInstructions = info === 'poor' && random() < 0.3;
  const task_text = noInstructions
    ? `The company commander has been called away; you have no precise instructions beyond the battlegroup's aim. Act on your own judgement.`
    : taskText;

  // ---- Enemy information (G5) -----------------------------------------------
  const enemy: EnemyReport[] = [];
  const firstPos = (pl: typeof blocking) => pl.positions.find((x) => x.kind !== 'outpost') ?? pl.positions[0];
  const imagery = `Battlegroup drone imagery, ${hhmm(new Date(nowT.getTime() - 90 * 60_000), tz)} today`;
  if (info === 'rich') {
    const ech = L.options.dispersed ? 'team' : 'section';
    for (const pl of fwdPl) {
      const ps = pl.positions.filter((x) => x.kind !== 'outpost').slice(0, 2);
      enemy.push({ text: `Fresh trenches and firing positions at ${ps.map((x) => ref(x.point)).join(' and ')}.`, source: imagery, reliability: 'good' });
      for (const x of ps) sightings.push({ phase: 1, point: x.point, echelon: ech, label: '' });
    }
    // Dummies show up in imagery exactly like real positions.
    for (const d of L.dummies.slice(0, 2)) {
      enemy.push({ text: `Further trenches at ${ref(d.point)}.`, source: imagery, reliability: 'good' });
      sightings.push({ phase: 1, point: d.point, echelon: ech, label: '' });
    }
    if (depthPl) {
      enemy.push({ text: `Probable further positions in grid square ${square(depthPl.centre)}; vehicle tracks lead into it.`, source: imagery, reliability: 'fair' });
      sightings.push({ phase: 1, point: squareCentre(depthPl.centre), echelon: 'platoon', label: '?' });
    }
    if (L.mines) {
      enemy.push({ text: `Disturbed ground across the track ahead, possibly mines.`, source: imagery, reliability: 'fair' });
      minefields.push({ phase: 1, outline: mineOutline(), label: 'Suspected minefield' });
    }
    if (L.options.isrFires) enemy.push({ text: 'Enemy drones have been seen over the area since first light; artillery has fallen within minutes of our vehicles being seen.', source: 'Battlegroup HQ', reliability: 'good' });
  } else if (info === 'partial') {
    enemy.push({
      text: `A patrol was fired on last night from the area of grid square ${square(firstPos(blocking).point)}: at least one machine gun. Strength unknown.`,
      source: 'B Company patrol, 0200 today',
      reliability: 'fair',
    });
    sightings.push({ phase: 1, point: squareCentre(firstPos(blocking).point), echelon: 'section', label: 'MG' });
    if (L.mines) enemy.push({ text: 'The enemy laid mines along the track last week.', source: 'A local farmer', reliability: 'doubtful' });
  } else {
    enemy.push({
      text: `Enemy are believed to be holding the ground about ${km(Math.round(frontLine / 100) * 100)} ahead, between grid squares ${square(fwdPl[0].centre)} and ${square(fwdPl[fwdPl.length - 1].centre)}.`,
      source: "Your company commander's assessment",
      reliability: 'fair',
    });
  }
  const enemyGaps =
    info === 'rich'
      ? 'Positions under trees or overhead cover may not show in imagery.'
      : info === 'partial'
        ? `What is on either side of grid square ${square(firstPos(blocking).point)}, and in depth, is not known.`
        : 'Positions, strength and depth are not known.';

  // ---- Ground facts not on the map (G7) ----------------------------------
  const ground: string[] = [];
  if (lay) {
    let inWood = 0, open = 0, water: Point | null = null;
    for (const p of main) {
      const i = cellOf(p);
      if (i < 0) continue;
      if (lay.cover[i] === COVER.wood) inWood++;
      if (!water && (lay.stream[i] || lay.river[i])) water = p;
      if (base.obstacles) {
        const c = pointToCell(cg, p);
        let near = false;
        for (let dr = -2; dr <= 2 && !near; dr++)
          for (let dc = -2; dc <= 2; dc++) {
            const rr = c.row + dr, cc = c.col + dc;
            if (rr >= 0 && cc >= 0 && rr < cg.height && cc < cg.width && base.obstacles.heightM[rr * cg.width + cc] >= 1) {
              near = true;
              break;
            }
          }
        if (!near) open++;
      }
    }
    if (base.obstacles) ground.push(`The obvious route ${dir} runs in the open, with no hedge, wall or trees within 20 m, for about ${pct(open / main.length)} of its length.`);
    if (inWood) ground.push(`It passes through woods for about ${km(inWood * cg.cellM)}.`);
    if (water) ground.push(`It crosses a stream or ditch at ${ref(water)}.`);
  }
  {
    // What can be seen from the start, of the ground the enemy holds.
    const vs = viewshed(cg, start, { obsHeightM: 2, targetHeightM: 1.5, maxRangeM: 2500, obstacles: base.obstacles });
    let seen = 0, total = 0;
    for (const pl of fwdPl)
      for (const x of pl.positions) {
        const i = cellOf(x.point);
        if (i < 0) continue;
        total++;
        seen += vs[i];
      }
    ground.push(
      total && seen / total > 0.6
        ? 'From where you stand you can see most of the ground ahead where the enemy is thought to be.'
        : total && seen / total > 0.2
          ? 'From where you stand you can see some, but not all, of the ground ahead.'
          : 'From where you stand you cannot see the ground where the enemy is thought to be: it lies beyond a crest or behind cover.',
    );
  }

  // ---- Own troops (G8) and weather (G9) ---------------------------------------
  const ownTroops = `1 Platoon is advancing on your ${leftRight(other.centre) === 'left' ? 'right' : 'left'}. 3 Platoon and Company HQ are with you at ${ref(start)}, in reserve.`;
  const weather = pick([
    'Bright and dry; visibility good. Drones will fly.',
    'Low cloud and light rain; visibility about 800 m. Drones will struggle to fly.',
    'Mist in the low ground, clearing by mid-morning; visibility poor at first.',
    'Overcast and dry; visibility good.',
  ]);

  // ---- Questions (G10) ----------------------------------------------------------
  const questions: string[] = [];
  if (info !== 'rich') questions.push('Where do you expect the enemy to be, and why? Mark the positions you expect.');
  questions.push(
    {
      secure: `How will you secure ${objective.name}? Walk the route you would take and mark your key positions.`,
      neutralise: `How will you neutralise ${objective.name}? Mark your fire support position and your assault route, and walk your approach.`,
      findFix: 'How will you find the enemy and fix them? Mark where you will observe from and how you will fix them.',
      screen: 'Where will you place your screen? Walk to and mark your observation posts.',
    }[task],
  );
  questions.push('Give your outline orders to your section commanders.');

  // ---- Phase 2: the situation develops (G11) ------------------------------------------
  const messages: { time: string; from: string; text: string }[] = [];
  const at = (mins: number) => hhmm(new Date(t2.getTime() + mins * 60_000), tz);
  const mineOnRoute = L.mines && chosen.direct ? chosen.direct.path.find((p) => L.mines![cellOf(p)]) : undefined;
  const events: (() => void)[] = [];
  if (L.options.isrFires && info !== 'rich') {
    events.push(() => {
      const hit = chosen.direct?.path[Math.floor((chosen.direct?.path.length ?? 2) / 3)] ?? start;
      messages.push({ time: at(-10), from: 'Company HQ', text: 'Enemy drone seen overhead, heading back east.' });
      messages.push({ time: at(-2), from: 'Company HQ', text: `Six rounds of enemy artillery landed at ${ref(hit)}, on the route. No casualties.` });
    });
  }
  if (mineOnRoute) {
    events.push(() => {
      messages.push({ time: at(0), from: 'Your lead section', text: `Anti-personnel mines found on the track at ${ref(mineOnRoute)}. One man slightly injured.` });
      const r = 60;
      minefields.push({
        phase: 2,
        outline: [0, 1, 2, 3].map((k) => ({ x: mineOnRoute.x + r * Math.cos((k * Math.PI) / 2 + Math.PI / 4), y: mineOnRoute.y + r * Math.sin((k * Math.PI) / 2 + Math.PI / 4) })),
        label: 'Mines found',
      });
    });
  }
  if (L.dummies.length && info === 'rich') {
    events.push(() => {
      const d = L.dummies[0];
      const realNear = real.filter((x) => x.kind !== 'hq').sort((a, b) => distance(a.point, d.point) - distance(b.point, d.point))[0];
      messages.push({ time: at(0), from: '1 Platoon', text: `The trenches at ${ref(d.point)} are empty: a dummy. We are being fired on from about ${ref(realNear.point)}.` });
      sightings.push({ phase: 2, point: d.point, echelon: L.options.dispersed ? 'team' : 'section', label: '', dummy: true });
      sightings.push({ phase: 2, point: realNear.point, echelon: L.options.dispersed ? 'team' : 'section', label: '' });
    });
  }
  if (outposts.length) {
    events.push(() => {
      messages.push({ time: at(0), from: 'Your lead section', text: `Under machine-gun fire from about ${ref(outposts[0].point)}. Two or three men seen. We are in cover.` });
      sightings.push({ phase: 2, point: outposts[0].point, echelon: 'team', label: 'MG' });
    });
  }
  events.push(() => {
    const p = firstPos(other).point;
    messages.push({ time: at(5), from: '1 Platoon', text: `Pinned down by fire from about ${ref(p)}. Unable to move forward.` });
    sightings.push({ phase: 2, point: p, echelon: L.options.dispersed ? 'team' : 'section', label: '' });
  });
  // One or two events, in a random order.
  const nEv = Math.min(events.length, 1 + (random() < 0.5 ? 1 : 0));
  events.sort(() => random() - 0.5).slice(0, nEv).forEach((e) => e());
  messages.sort((a, b) => a.time.localeCompare(b.time));
  // Friendly units and effects arrows (always shown).
  const onePlSide = leftRight(other.centre) === 'left' ? 1 : -1; // 1 Pl is on the side away from the other enemy platoon
  const onePl = { x: start.x + v.x * onePlSide * 500, y: start.y + v.y * onePlSide * 500 };
  const behind = (d: number, l = 0) => ({ x: start.x - u.x * d + v.x * l, y: start.y - u.y * d + v.y * l });
  const friendly: ScenarioMarkers['friendly'] = [
    { label: '2 Pl (you)', designation: '2', higher: 'B', point: start, echelon: 'platoon', own: true, kind: infKind },
    { label: '1 Pl', designation: '1', higher: 'B', point: onePl, echelon: 'platoon', kind: infKind },
    { label: '3 Pl', designation: '3', higher: 'B', point: behind(400, -onePlSide * 200), echelon: 'platoon', kind: infKind },
    { label: 'B Coy HQ', designation: 'B', higher: '', point: behind(550, onePlSide * 250), echelon: 'company', hq: true, kind: infKind },
  ];
  const axisEnd = (from: Point, to: Point, short: number) => {
    const d = distance(from, to) || 1;
    short = Math.min(short, d * 0.5); // never let the arrow turn back on itself on close objectives
    return { x: to.x - ((to.x - from.x) / d) * short, y: to.y - ((to.y - from.y) / d) * short };
  };
  const axes: ScenarioMarkers['axes'] = [
    { label: '2 Pl', path: [start, axisEnd(start, objective.point, task === 'secure' ? 180 : task === 'findFix' ? 550 : 250)], own: true },
    { label: '1 Pl', path: [onePl, { x: onePl.x + u.x * Math.max(400, frontLine - 300), y: onePl.y + u.y * Math.max(400, frontLine - 300) }], own: false },
  ];
  const taskMarker: ScenarioMarkers['task'] = {
    kind: task,
    objective: objective.point,
    from: axes[0].path[1],
    across: v,
    label: { secure: 'S', neutralise: 'N', findFix: 'F', screen: 'S' }[task],
  };

  // ---- Friendly forces 2 up and 1 up (PO, 15 Nov 2026) --------------------------
  // A Coy is beyond 1 Pl; the other flank (towards the second enemy forward
  // platoon) is the battlegroup's open flank. C Coy is the battlegroup reserve.
  const onePlSideWord = onePlSide > 0 ? 'right' : 'left';
  const openSideWord = onePlSide > 0 ? 'left' : 'right';
  const bgObjFwd = Math.max(fwd(objective.point), depthPl ? fwd(depthPl.centre) : frontLine + 500) + 600;
  // On the main route if it reaches that far, otherwise straight on along the advance.
  const bgObjQ = main.find((p) => fwd(p) >= bgObjFwd) ?? { x: u.x * bgObjFwd, y: u.y * bgObjFwd };
  const bgObjOnMap = Math.abs(bgObjQ.x) <= half && Math.abs(bgObjQ.y) <= half && distance(bgObjQ, objective.point) > 450;
  const bgObjective = { point: bgObjQ, name: bgObjName, onMap: bgObjOnMap };
  const aCoy = clampBox({ x: start.x + v.x * onePlSide * 1300, y: start.y + v.y * onePlSide * 1300 });
  const cCoy = clampBox(behind(1400, -onePlSide * 150));
  friendly.push(
    { label: 'A Coy', designation: 'A', higher: '', point: aCoy, echelon: 'company', kind: infKind },
    { label: 'C Coy', designation: 'C', higher: '', point: cCoy, echelon: 'company', kind: infKind },
  );
  axes.push({ label: 'A Coy', path: [aCoy, clampBox({ x: aCoy.x + u.x * Math.max(500, frontLine), y: aCoy.y + u.y * Math.max(500, frontLine) })], own: false });
  const across = (f: number, l0: number, l1: number): Point[] => [l0, l1].map((l) => clampBox({ x: u.x * f + v.x * l, y: u.y * f + v.y * l }));
  const along2 = (l: number, f0: number, f1: number): Point[] => [f0, f1].map((f) => clampBox({ x: u.x * f + v.x * l, y: u.y * f + v.y * l }));
  const boundaryLat = onePlSide * 900;
  const control: ScenarioMarkers['control'] = [
    // B Coy / A Coy boundary; sides are [left, right] looking forward: B on our side, A on theirs.
    { kind: 'boundary', path: along2(boundaryLat, -1200, bgObjFwd + 300), label: 'I', sides: onePlSide > 0 ? ['B', 'A'] : ['A', 'B'] },
    { kind: 'phaseLine', path: across(150, -1600, 1600), label: 'SL' },
    { kind: 'phaseLine', path: across(Math.min(900, Math.max(400, frontLine - 300)), -1600, 1600), label: plName },
  ];
  const coyMission = {
    secure: `B Coy is to break through the enemy's forward line on the main route and secure ${objective.name}, in order to let ${bg} pass ${dir} to ${bgObjName}.`,
    neutralise: `B Coy is to destroy the enemy on the main route ${dir}, in order to open the way for ${bg} to ${bgObjName}.`,
    findFix: `B Coy is to find and destroy the enemy's forward positions across the company's front, in order to open the way for ${bg} to ${bgObjName}.`,
    screen: `B Coy is to break through the enemy's forward line on the main route, in order to open the way for ${bg} to ${bgObjName}.`,
  }[task];
  const coyScheme = {
    secure: `2 Pl (main effort) secures ${objective.name}. 1 Pl advances on the ${onePlSideWord} and fixes the enemy there, so they cannot turn on 2 Pl. 3 Pl is the company reserve, ready to reinforce 2 Pl or to face the open ${openSideWord} flank.`,
    neutralise: `2 Pl (main effort) neutralises the enemy on the main route. 1 Pl advances on the ${onePlSideWord} and fixes the enemy there. 3 Pl, in reserve, then passes through to exploit ${dir}.`,
    findFix: `2 Pl finds the enemy's forward positions and fixes them. 3 Pl (main effort) then attacks them in the flank. 1 Pl advances on the ${onePlSideWord} and keeps the enemy there busy.`,
    screen: `1 Pl (main effort) attacks along the main route, with 3 Pl following to pass through. 2 Pl screens the company's open ${openSideWord} flank.`,
  }[task];
  const friendlyForces = [
    {
      element: `2 up: ${bg}`,
      detail:
        (bgType === 'light'
          ? `Light role infantry: three rifle companies on foot, with mortars, anti-tank and reconnaissance platoons. `
          : `Mechanised infantry in Boxer, with a squadron of Challenger 3 tanks, mortars and engineers. `) +
        `Mission: ${bg} is to seize ${bgObjName} (${ref(bgObjective.point)}${bgObjOnMap ? '' : `, about ${km(bgObjFwd)} ${dir} of the start line, beyond this map`}), in order to allow the brigade to pass ${dir}. ` +
        `CO's intent: break the enemy's forward line quickly on the main route, before they can reinforce or bring artillery onto us; ` +
        `main effort B Coy; A Coy advances on B Coy's ${onePlSideWord} to fix the enemy there; C Coy, the battlegroup reserve, then passes through to ${bgObjName}. ` +
        `End state: the enemy ahead destroyed or withdrawn, the route ${dir} open, and ${bg} firm on ${bgObjName}.`,
    },
    {
      element: '1 up: B Coy',
      detail:
        `Mission: ${coyMission} OC's intent: move fast and use the ground; do not fight the enemy where he expects us. ${coyScheme} ` +
        `Start line ${ref(start)}; report crossing ${plName}.`,
    },
    {
      element: 'Flanks',
      detail:
        `${onePlSideWord[0].toUpperCase() + onePlSideWord.slice(1)}: A Coy, about 1.3 km away beyond 1 Pl, boundary marked on the map. ` +
        `${openSideWord[0].toUpperCase() + openSideWord.slice(1)}: open; ${neighbour.short} BG is about 5 km away, out of contact. ` +
        `Rear: C Coy (battlegroup reserve) at ${ref(cCoy)}.`,
    },
  ];

  const phase2 = {
    time: `${hhmm(t2, tz)}. Your platoon has moved off as you planned.`,
    messages,
    questions: ['What do you conclude from these reports?', 'What do you now do? Give your orders.'],
  };

  // ---- DS (G13) ------------------------------------------------------------------
  const ds: string[] = [];
  ds.push(...L.reasons);
  const posList = (xs: EnemyPosition[], pl: string) => xs.map((x) => `${x.label.replace(pl + ' ', '')} ${ref(x.point, 4)}`).join('; ');
  for (const p of L.platoons) ds.push(`${p.name}: ${posList(p.positions, p.name)}.`);
  if (L.hq) ds.push(`Coy HQ ${ref(L.hq.point, 4)}.`);
  if (L.dummies.length) ds.push(`Dummies (no enemy): ${L.dummies.map((d) => ref(d.point)).join('; ')}.`);
  // Ground truth only: the obvious route is a fact of the ground. The computed
  // best covered route and the gate's reasoning are not shown, so this never
  // reads as a school solution (PO, 15 Nov 2026); the gate still uses them.
  if (chosen.direct) {
    const d = chosen.direct;
    ds.push(
      `The obvious route to ${objective.name} (the easiest going): ${km(d.lengthM)}, ${pct(d.underFire)} of it under enemy fire` +
        `${d.minesCrossed ? `, crossing mines` : ''}.`,
    );
  }
  if (L.gaps[0]) ds.push(`The gap between the enemy forward platoons is about ${km(L.gaps[0].widthM)} wide, centred on ${ref(L.gaps[0].centre)}.`);
  ds.push(
    'There is no school solution. Judge your decision by the ground and the enemy as they really were: what the enemy could and ' +
      'could not see, where their fire fell, and whether your orders gave your intent and left your section commanders free to act on it.',
  );

  const m = g.meta;
  const dataNote =
    `Ground: ${m.source}, about ${m.sourceResolutionM} m; enemy layout computed from it at ${L.maskCellM} m. ` +
    'Check access on the ground before walking to any position.';

  return {
    task, info,
    title: `${TASK_LABEL[task]}: 2 Platoon, B Company, ${bn.short}, advancing ${dir}`,
    you, force, situation, bgType, friendlyForces, task_text, enemy, enemyGaps, time, ground, ownTroops, weather, questions,
    timeAllowed: '30 minutes for your plan; 10 minutes when the situation develops.',
    startMs: nowT.getTime(),
    phase2, ds,
    objective: objective.point,
    markers: { friendly, control, bgObjective, axes, task: taskMarker, sightings, minefields },
    direct: chosen.direct, covered: chosen.covered,
    gate: `${chosen.ok ? 'Passed' : 'Weak'}: ${chosen.why}`,
    dataNote,
  };
}

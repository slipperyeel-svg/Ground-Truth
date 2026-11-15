/**
 * The problem generator: reads the ground and its features, tries each enemy
 * direction, runs the template and its quality gate, and writes the problem
 * that passes in the classic format (General Situation, Special Situation,
 * Requirement, Time allowed).
 *
 * The wording is a first draft for the PO to review. It uses only computed
 * facts; the DS notes say where each number came from.
 */
import type { Grid, Point } from '../terrain/grid';
import { localToLatLon } from '../terrain/elevation';
import { slope } from '../terrain/slope';
import { classifyGround } from '../terrain/classify';
import { gridRef } from '../geo/gridref';
import type { FeatureLayers } from '../features/layers';
import { findApproach, slopeOnlyGoing, type Side } from './approach';
import { chooseEnemyOps } from './enemyOps';
import type { Obstacles } from '../terrain/viewshed';
import { templateA, type TemplateAResult } from './templateA';

const SIDE_NAME: Record<Side, string> = { N: 'north', E: 'east', S: 'south', W: 'west' };
const OPPOSITE_NAME: Record<Side, string> = { N: 'south', E: 'west', S: 'north', W: 'east' };

export interface ProblemText {
  title: string;
  generalSituation: string;
  specialSituation: string;
  requirement: string[];
  timeAllowed: string;
  /** Directing-staff notes: the computed facts behind the problem. Hidden until the user has answered. */
  dsNotes: string[];
  /** Data source and resolution, shown on every problem (core principle 3). */
  dataNote: string;
}

export interface Problem {
  template: 'A';
  enemySide: Side;
  result: TemplateAResult;
  text: ProblemText;
}

export interface GenerateOutcome {
  problem: Problem | null;
  /** One line per enemy direction tried, saying why it passed or failed. */
  log: string[];
}

export interface GenerateOptions {
  layers: FeatureLayers | null;
  /** Woods, buildings and hedges that block sight. */
  obstacles?: Obstacles | null;
  /** Order to try enemy directions in. Default: all four, N first. */
  sides?: Side[];
  /** Called with progress messages. */
  progress?: (msg: string) => void;
}

/** How good a passing problem is, to choose between directions. Higher is better. */
function rank(r: TemplateAResult): number {
  let s = r.dilemmas.length * 10;
  if (r.approach.nai.channelledBy.length) s += 20; // a real choke point beats open ground
  if (r.bestViewOP && r.alternativeOP) s += 5 * (r.bestViewOP.seenBy - r.alternativeOP.seenBy);
  s += 3 * r.approach.roadShare;
  return s;
}

export function generateProblem(g: Grid, opts: GenerateOptions): GenerateOutcome {
  const slopeDeg = slope(g);
  const ground = classifyGround(g);
  const going = opts.layers ? opts.layers.going : slopeOnlyGoing(slopeDeg);
  const log: string[] = [];
  let best: { side: Side; r: TemplateAResult; score: number } | null = null;

  for (const side of opts.sides ?? (['N', 'E', 'S', 'W'] as Side[])) {
    opts.progress?.(`Trying an enemy advance from the ${SIDE_NAME[side]}…`);
    const approach = findApproach(g, going, slopeDeg, side, opts.layers);
    if (!approach) {
      log.push(`From the ${SIDE_NAME[side]}: the enemy cannot cross the box.`);
      continue;
    }
    const enemyOps = chooseEnemyOps(g, approach.enemyBearingDeg, opts.layers, { view: { obstacles: opts.obstacles ?? undefined } });
    const r = templateA({
      grid: g, slopeDeg, reliefM: ground.reliefM, layers: opts.layers, approach, enemyOps,
      obstacles: opts.obstacles ?? undefined,
    });
    log.push(`From the ${SIDE_NAME[side]}: ${r.passed ? 'PASSED' : 'rejected'}. ${r.gate.filter((x) => !x.startsWith('✓')).join(' ')}`.trim());
    if (r.passed) {
      const score = rank(r);
      if (!best || score > best.score) best = { side, r, score };
    }
  }

  if (!best) return { problem: null, log };
  return { problem: { template: 'A', enemySide: best.side, result: best.r, text: writeProblem(g, best.side, best.r) }, log };
}

// ---------------------------------------------------------------------------
// Writing the problem

function refAt(g: Grid, p: Point): string {
  const c = g.meta.centre;
  if (!c) return `(${Math.round(p.x)} m E, ${Math.round(p.y)} m N of the centre)`;
  const ll = localToLatLon(c, p.x, p.y);
  return gridRef(ll.lat, ll.lon).ref;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const metres = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} km` : `${Math.round(x / 10) * 10} m`);
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function writeProblem(g: Grid, side: Side, r: TemplateAResult): ProblemText {
  const a = r.approach;
  const enemyFrom = SIDE_NAME[side];
  const ownSide = OPPOSITE_NAME[side];
  const routeKind = a.roadShare > 0.5 ? 'along the roads and tracks' : 'across country';
  const channel = a.nai.channelledBy.length
    ? `where the ground is narrowed by ${list(a.nai.channelledBy)} to a frontage of about ${metres(a.nai.widthM)}`
    : `on open ground about ${metres(a.nai.widthM)} wide`;

  const generalSituation =
    `Enemy forces are advancing from the ${enemyFrom}. Their reconnaissance is active on the high ground to the ${enemyFrom}. ` +
    `Friendly forces hold the ground to the ${ownSide} and intend to destroy the enemy with indirect fire as they close.`;

  const specialSituation =
    `You are the Battery Commander of a close support battery. Enemy armour is expected to move ${routeKind} ` +
    `and pass through NAI 1, centred at ${refAt(g, a.nai.centre)}, ${channel}. ` +
    `Your battery must be able to engage NAI 1, and you must be able to see it.`;

  const requirement = [
    'Walk to the position you would choose for your OP to observe NAI 1, and mark it.',
    'Choose and mark the battery gun area.',
    'State what the enemy can see of your OP and of your gun area, and from where.',
    'Give your outline orders for the battery.',
  ];

  const ds: string[] = [];
  ds.push(`NAI 1 at ${refAt(g, a.nai.centre)}: the enemy's cheapest route across the box is ${metres(a.routeLengthM)} long, ` +
    `${pct(a.roadShare)} of it on roads or tracks; the NAI is where its corridor is narrowest (${metres(a.nai.widthM)}).`);
  ds.push(`Likely enemy OPs (the points on the enemy side that see most of our ground): ` +
    r.enemyOps.map((o) => `${refAt(g, o.point)} (sees ${pct(o.friendlyViewShare)} of our half${o.concealed ? ', concealed' : ''})`).join('; ') + '.');
  if (r.bestViewOP) {
    const b = r.bestViewOP;
    ds.push(`Best view of NAI 1: ${refAt(g, b.point)}, sees ${pct(b.naiShare)} of it; seen by ${b.seenBy} of ${r.enemyOps.length} enemy OPs` +
      `${b.silhouetted ? '; skylined' : ''}.`);
  }
  if (r.alternativeOP) {
    const o = r.alternativeOP;
    ds.push(`Alternative OP: ${refAt(g, o.point)}, sees ${pct(o.naiShare)}; seen by ${o.seenBy}${o.silhouetted ? '; skylined' : ''}.`);
  }
  if (r.concealedOP && r.concealedOP !== r.alternativeOP) {
    const o = r.concealedOP;
    ds.push(`Best OP no enemy OP can see: ${refAt(g, o.point)}, sees ${pct(o.naiShare)} of NAI 1.`);
  }
  r.gunAreas.slice(0, 3).forEach((ga, k) => {
    ds.push(`Covered gun area ${k + 1}: ${refAt(g, ga.centre)}, ${ga.areaHa.toFixed(0)} ha of ground under 6° out of enemy view, ` +
      `${metres(ga.rangeToNaiM)} from NAI 1${Number.isFinite(ga.toRoadM) ? `, ${metres(ga.toRoadM)} from the nearest road or track` : ''}.`);
  });
  if (r.locToBestOP) {
    ds.push(`Gun area 1 to the best-view OP: ${metres(r.locToBestOP.lengthM)} by the easiest route, ${pct(r.locToBestOP.exposedShare)} of it in enemy view.`);
  }
  for (const d of r.dilemmas) ds.push(`Dilemma: ${d.text}`);

  const m = g.meta;
  const dataNote =
    `Ground: ${m.source}, about ${m.sourceResolutionM} m resolution${m.surfaceModel ? ' (a surface model: woods and buildings may read as raised ground)' : ''}. ` +
    `Hedges, walls, sunken lanes and folds smaller than this are not shown. ` +
    (r.accessChecked
      ? 'Woods, water, buildings, roads: OS open data; paths and hedges: OpenStreetMap. Woods, buildings and hedges block sight. ' +
        'Stands are not restricted to public paths: check access on the ground.'
      : 'Map features were not loaded: woods, roads and water are not taken into account.');

  return {
    title: `Template A — OP and gun area: enemy from the ${enemyFrom}`,
    generalSituation,
    specialSituation,
    requirement,
    timeAllowed: '30 minutes.',
    dsNotes: ds,
    dataNote,
  };
}

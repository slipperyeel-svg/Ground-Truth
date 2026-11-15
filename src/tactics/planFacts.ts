/**
 * Computed facts about the user's own plan, shown with the ground truth
 * (PO, 15 Nov 2026: plan capture; no school solution, so these are facts
 * only, never a verdict).
 *
 * For the route: its length, how much of it lay under enemy fire, the longest
 * open stretch under fire, mined ground crossed, and the nearest it came to an
 * enemy position. For each marked position: which enemy positions could see
 * it, which it could see, whether it lay under enemy fire or in mines, and the
 * nearest enemy.
 *
 * Heights: an enemy dug in looks out at 1.2 m and shows 0.5 m; our man is
 * taken as 1.5 m (crouched or kneeling), as in the enemy generator.
 */
import { distance, type Grid, type Point } from '../terrain/grid';
import { lineOfSight, type Obstacles } from '../terrain/viewshed';
import type { CompanyLayout, EnemyPosition } from './companyDefence';
import { POSTURES, SECTION_SCORING } from './sectionDefence';

export interface PlanMark {
  /** e.g. 'OP', 'Fire support', 'FUP'. */
  kind: string;
  label: string;
  point: Point;
}

export interface PlanInput {
  route: Point[];
  positions: PlanMark[];
}

export interface PlanFacts {
  route: string[];
  positions: { label: string; facts: string[] }[];
}

export const PLAN_HEIGHTS = {
  enemyEyeM: POSTURES.prepared.eyeM,
  enemyShowsM: POSTURES.prepared.exposedM,
  ourManM: SECTION_SCORING.attackerHeightM,
  /** Enemy beyond this range are not listed as seeing or seen. */
  maxRangeM: 1500,
};

const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`);

export function planFacts(
  grid: Grid,
  obstacles: Obstacles | null,
  L: CompanyLayout,
  plan: PlanInput,
  ref: (p: Point) => string,
): PlanFacts {
  const H = PLAN_HEIGHTS;
  const enemy: EnemyPosition[] = [...L.platoons.flatMap((p) => p.positions), ...(L.hq ? [L.hq] : [])];
  // Cell of the enemy's analysis masks (fire, mines) for a local point; -1 outside.
  const maskCell = (p: Point) => {
    const c = L.maskCellM;
    const col = Math.floor((p.x + (L.maskWidth * c) / 2) / c);
    const row = Math.floor(((L.maskHeight * c) / 2 - p.y) / c);
    return col >= 0 && row >= 0 && col < L.maskWidth && row < L.maskHeight ? row * L.maskWidth + col : -1;
  };
  const underFire = (p: Point) => {
    const i = maskCell(p);
    return i >= 0 ? L.killZone[i] : 0;
  };
  const mined = (p: Point) => {
    const i = maskCell(p);
    return i >= 0 && !!L.mines && !!L.mines[i];
  };
  const obs = obstacles ?? undefined;
  const nearest = (p: Point) => {
    let best: EnemyPosition | null = null, d = Infinity;
    for (const e of enemy) {
      const dd = distance(p, e.point);
      if (dd < d) [d, best] = [dd, e];
    }
    return best ? { e: best, d } : null;
  };

  // ---- Route ----
  const route: string[] = [];
  if (plan.route.length >= 2) {
    const step = 5;
    let len = 0, fire = 0, mines = 0, run = 0, longest = 0, firstFire = -1;
    let closest = Infinity, closestTo: EnemyPosition | null = null;
    for (let k = 1; k < plan.route.length; k++) {
      const a = plan.route[k - 1], b = plan.route[k];
      const d = distance(a, b);
      const n = Math.max(1, Math.ceil(d / step));
      for (let s = 1; s <= n; s++) {
        const p = { x: a.x + ((b.x - a.x) * s) / n, y: a.y + ((b.y - a.y) * s) / n };
        const ds = d / n;
        len += ds;
        if (underFire(p)) {
          fire += ds;
          run += ds;
          longest = Math.max(longest, run);
          if (firstFire < 0) firstFire = len;
        } else run = 0;
        if (mined(p)) mines += ds;
        const ne = nearest(p);
        if (ne && ne.d < closest) [closest, closestTo] = [ne.d, ne.e];
      }
    }
    route.push(`Your route: ${metres(len)} long.`);
    route.push(
      fire > 0
        ? `${Math.round((fire / len) * 100)}% of it (${metres(fire)}) lay under enemy fire, first after ${metres(firstFire)}; the longest stretch under fire without a break was ${metres(longest)}.`
        : 'None of it lay under enemy fire.',
    );
    if (L.mines) route.push(mines > 0 ? `It crossed about ${metres(mines)} of mined ground.` : 'It crossed no mined ground.');
    if (closestTo) route.push(`It came within ${metres(closest)} of the nearest enemy position (${closestTo.label}, ${ref(closestTo.point)}).`);
  }

  // ---- Positions ----
  const positions = plan.positions.map((m) => {
    const facts: string[] = [];
    const seenBy: string[] = [];
    const sees: string[] = [];
    for (const e of enemy) {
      const d = distance(m.point, e.point);
      if (d > H.maxRangeM) continue;
      if (lineOfSight(grid, e.point, m.point, H.enemyEyeM, H.ourManM, false, obs)) seenBy.push(`${e.label} (${metres(d)})`);
      if (lineOfSight(grid, m.point, e.point, H.ourManM, H.enemyShowsM, false, obs)) sees.push(`${e.label} (${metres(d)})`);
    }
    const seenDummies = L.dummies.filter(
      (x) => distance(m.point, x.point) <= H.maxRangeM && lineOfSight(grid, m.point, x.point, H.ourManM, H.enemyShowsM, false, obs),
    );
    const within = `within ${metres(H.maxRangeM)}`;
    facts.push(seenBy.length ? `Seen by ${seenBy.length} enemy position${seenBy.length > 1 ? 's' : ''}: ${seenBy.join('; ')}.` : `No enemy position ${within} could see it.`);
    facts.push(sees.length ? `From it you could see ${sees.length}: ${sees.join('; ')}.` : `From it you could see no enemy position ${within}.`);
    if (seenDummies.length) facts.push(`It also overlooked ${seenDummies.length} dummy position${seenDummies.length > 1 ? 's' : ''} (no enemy there).`);
    const f = underFire(m.point);
    facts.push(f ? `It lay under enemy fire (${f} position${f > 1 ? 's' : ''} could bring fire onto it).` : 'It lay outside the enemy\'s fire.');
    if (mined(m.point)) facts.push('It lay in mined ground.');
    const ne = nearest(m.point);
    if (ne) facts.push(`Nearest enemy: ${ne.e.label}, ${metres(ne.d)} away.`);
    return { label: `${m.label} (${ref(m.point)})`, facts };
  });

  return { route, positions };
}

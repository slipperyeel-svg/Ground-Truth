/**
 * Likely enemy OPs (PO decision, DECISIONS.md 36): the points on the enemy
 * side of the box that see most of the friendly area, spaced at least 300 m
 * apart, with a preference for wood edges, buildings and crests where a real
 * OP would hide.
 *
 * Viewsheds for the candidates are computed on a coarser copy of the grid
 * (30 m cells by default, the true resolution of the data) to keep the cost
 * down on a phone.
 */
import { bearingVector, cellToPoint, createGrid, distance, pointToCell, type Grid, type Point } from '../terrain/grid';
import { viewshed, type Observer, type ViewshedOptions } from '../terrain/viewshed';
import { COVER, type FeatureLayers } from '../features/layers';

export interface EnemyOP extends Observer {
  /** Share (0–1) of the friendly half of the box this OP can see. */
  friendlyViewShare: number;
  /** True if the OP is beside woods, scrub or buildings (somewhere to hide). */
  concealed: boolean;
}

export interface EnemyOpOptions {
  count?: number;
  spacingM?: number;
  candidateStepM?: number;
  coarseCellM?: number;
  view?: ViewshedOptions;
  /** Score bonus for a concealed position. Default 1.15. */
  concealmentBonus?: number;
  /**
   * PO: enemy OPs must be at least this far in front of the box's centre
   * line (into enemy ground), not on top of our forward positions. Default 500 m.
   */
  minStandoffM?: number;
}

/** Average blocks of cells to make a coarser grid. */
export function downsample(g: Grid, factor: number): Grid {
  if (factor <= 1) return g;
  const w = Math.floor(g.width / factor);
  const h = Math.floor(g.height / factor);
  const out = createGrid(w, h, g.cellM * factor, g.meta);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      let s = 0;
      for (let dr = 0; dr < factor; dr++)
        for (let dc = 0; dc < factor; dc++) s += g.data[(r * factor + dr) * g.width + c * factor + dc];
      out.data[r * w + c] = s / (factor * factor);
    }
  }
  return out;
}

/** True if woods, scrub or buildings lie within `radiusM` of the point. */
function nearConcealment(g: Grid, layers: FeatureLayers, p: Point, radiusM: number): boolean {
  const c = pointToCell(g, p);
  const R = Math.ceil(radiusM / g.cellM);
  for (let dr = -R; dr <= R; dr++) {
    for (let dc = -R; dc <= R; dc++) {
      const r = c.row + dr;
      const cc = c.col + dc;
      if (r < 0 || cc < 0 || r >= g.height || cc >= g.width) continue;
      const cv = layers.cover[r * g.width + cc];
      if (cv === COVER.wood || cv === COVER.scrub || cv === COVER.builtUp || cv === COVER.building) return true;
    }
  }
  return false;
}

export function chooseEnemyOps(
  g: Grid,
  enemyBearingDeg: number,
  layers: FeatureLayers | null,
  opts: EnemyOpOptions = {},
): EnemyOP[] {
  const count = opts.count ?? 6;
  const spacingM = opts.spacingM ?? 300;
  const step = opts.candidateStepM ?? 200;
  const bonus = opts.concealmentBonus ?? 1.15;
  const factor = Math.max(1, Math.round((opts.coarseCellM ?? 30) / g.cellM));
  const cg = downsample(g, factor);
  const u = bearingVector(enemyBearingDeg);
  const half = (g.width * g.cellM) / 2;

  // Friendly half of the coarse grid: the side away from the enemy.
  const friendly: number[] = [];
  for (let r = 0; r < cg.height; r++)
    for (let c = 0; c < cg.width; c++) {
      const p = cellToPoint(cg, c, r);
      if (p.x * u.x + p.y * u.y < 0) friendly.push(r * cg.width + c);
    }

  // Score candidates on the enemy half.
  const scored: { p: Point; share: number; concealed: boolean; score: number }[] = [];
  for (let y = -half + step / 2; y < half; y += step) {
    for (let x = -half + step / 2; x < half; x += step) {
      const p = { x, y };
      if (p.x * u.x + p.y * u.y < (opts.minStandoffM ?? 500)) continue;
      if (layers) {
        const c = pointToCell(g, p);
        const cv = layers.cover[c.row * g.width + c.col];
        if (cv === COVER.water || cv === COVER.wetland) continue;
      }
      const vs = viewshed(cg, p, opts.view);
      let seen = 0;
      for (const i of friendly) seen += vs[i];
      const share = friendly.length ? seen / friendly.length : 0;
      const concealed = layers ? nearConcealment(g, layers, p, 60) : false;
      scored.push({ p, share, concealed, score: share * (concealed ? bonus : 1) });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // Greedy pick, keeping them apart.
  const picked: EnemyOP[] = [];
  for (const s of scored) {
    if (picked.length >= count) break;
    if (s.share <= 0) break;
    if (picked.some((o) => distance(o.point, s.p) < spacingM)) continue;
    picked.push({ point: s.p, friendlyViewShare: s.share, concealed: s.concealed });
  }
  return picked;
}

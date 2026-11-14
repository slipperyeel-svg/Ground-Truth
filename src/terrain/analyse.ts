/**
 * One call that runs the whole M1 analysis on a box. Used by the Web Worker
 * and the performance test. Templates (M3+) will call the individual
 * functions directly.
 */
import { bearingVector, type Grid, type Mask, type Point } from './grid';
import { slope, hillshade } from './slope';
import { classifyLandforms, tpi } from './tpi';
import { classifyGround, type GroundClassification } from './classify';
import { crestLine, type CrestResult } from './crest';
import { inRangeMask, resolveViewOptions, unionViewshed, type Observer, type ViewshedOptions } from './viewshed';

export interface AnalysisInput {
  grid: Grid;
  /** Bearing from the box centre towards the enemy. */
  enemyBearingDeg: number;
  /** Likely enemy observation points; if omitted, a line along the enemy edge is used. */
  enemyObservers?: Observer[];
  view?: ViewshedOptions;
}

export interface AnalysisResult {
  slope: Float32Array;
  hillshade: Uint8ClampedArray;
  tpiSmall: Float32Array;
  tpiLarge: Float32Array;
  landforms: Uint8Array;
  ground: GroundClassification;
  crest: CrestResult;
  enemyObservers: Observer[];
  enemyView: Mask;
  deadGround: Mask;
  timingsMs: Record<string, number>;
}

/**
 * Placeholder enemy observers: a line of points across the enemy side of the
 * box, 300 m in from the edge. Template A will replace this with positions
 * chosen from the ground (see DECISIONS.md — to agree with the product owner).
 */
export function defaultEnemyObservers(g: Grid, enemyBearingDeg: number, count = 7): Observer[] {
  const u = bearingVector(enemyBearingDeg);
  const v = { x: u.y, y: -u.x };
  const half = (g.width * g.cellM) / 2;
  const depth = half - 300;
  const obs: Observer[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1) - 0.5) * 2 * (half - 300);
    const p: Point = { x: u.x * depth + v.x * t, y: u.y * depth + v.y * t };
    obs.push({ point: p });
  }
  return obs;
}

export function analyse(input: AnalysisInput): AnalysisResult {
  const { grid, enemyBearingDeg } = input;
  const t: Record<string, number> = {};
  const time = <T>(name: string, f: () => T): T => {
    const s = performance.now();
    const r = f();
    t[name] = Math.round(performance.now() - s);
    return r;
  };

  const slp = time('slope', () => slope(grid));
  const hs = time('hillshade', () => hillshade(grid));
  const tpiSmall = time('tpiSmall', () => tpi(grid, 150));
  const tpiLarge = time('tpiLarge', () => tpi(grid, 600));
  const landforms = time('landforms', () => classifyLandforms(grid));
  const ground = time('classifyGround', () => classifyGround(grid));
  const crest = time('crest', () => crestLine(grid, enemyBearingDeg));
  const enemyObservers = input.enemyObservers ?? defaultEnemyObservers(grid, enemyBearingDeg);
  const enemyView = time('enemyViewshed', () => unionViewshed(grid, enemyObservers, input.view));
  const dg = time('deadGround', () => {
    // Same as deadGround(), reusing the enemy viewshed already computed.
    const range = inRangeMask(grid, enemyObservers, resolveViewOptions(input.view).maxRangeM);
    const out = new Uint8Array(range.length);
    for (let i = 0; i < out.length; i++) out[i] = range[i] && !enemyView[i] ? 1 : 0;
    return out;
  });
  t.total = Object.values(t).reduce((a, b) => a + b, 0);

  return {
    slope: slp,
    hillshade: hs,
    tpiSmall,
    tpiLarge,
    landforms,
    ground,
    crest,
    enemyObservers,
    enemyView,
    deadGround: dg,
    timingsMs: t,
  };
}

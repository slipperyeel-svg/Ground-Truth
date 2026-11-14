import { describe, expect, it } from 'vitest';
import { coneHill, flatPlane, fromFunction } from '../src/terrain/synthetic';
import { slope } from '../src/terrain/slope';
import { distance, type Point } from '../src/terrain/grid';
import { buildLayers } from '../src/features/layers';
import type { FeatureSet, MapFeature } from '../src/features/osm';
import { findApproach, slopeOnlyGoing } from '../src/tactics/approach';
import { chooseEnemyOps, downsample } from '../src/tactics/enemyOps';

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 },
];
const set = (features: Partial<MapFeature>[]): FeatureSet => ({
  features: features.map((f) => ({ osmId: 't', ...f }) as MapFeature),
  source: 'test',
  attribution: '',
});

describe('enemy approach and NAI', () => {
  it('channels the enemy through a gap between woods and puts the NAI in the gap', () => {
    const g = flatPlane(4000, 20);
    const L = buildLayers(g, set([
      { kind: 'wood', shape: 'area', rings: [rect(-2000, -200, -100, 200)] },
      { kind: 'wood', shape: 'area', rings: [rect(100, -200, 2000, 200)] },
    ]));
    const a = findApproach(g, L.going, slope(g), 'N', L)!;
    expect(a).not.toBeNull();
    expect(a.route[0].y).toBeGreaterThan(1900); // starts at the north edge
    expect(a.route[a.route.length - 1].y).toBeLessThan(-1900); // ends at the south edge
    expect(Math.abs(a.nai.centre.x)).toBeLessThan(150);
    expect(Math.abs(a.nai.centre.y)).toBeLessThan(300);
    expect(a.nai.widthM).toBeLessThan(400);
    expect(a.nai.channelledBy).toContain('woods');
  });

  it('prefers a road to open ground', () => {
    const g = flatPlane(4000, 20);
    const L = buildLayers(g, set([
      { kind: 'minor-road', shape: 'line', rings: [[{ x: 1200, y: 2000 }, { x: 1200, y: -2000 }]], publicAccess: true },
    ]));
    const a = findApproach(g, L.going, slope(g), 'N', L)!;
    expect(a.roadShare).toBeGreaterThan(0.9);
    expect(Math.abs(a.nai.centre.x - 1200)).toBeLessThan(30);
  });

  it('crosses a river only at the bridge', () => {
    const g = flatPlane(4000, 20);
    const L = buildLayers(g, set([
      { kind: 'river', shape: 'line', rings: [[{ x: -2000, y: 0 }, { x: 2000, y: 0 }]] },
      { kind: 'track', shape: 'line', rings: [[{ x: -800, y: 100 }, { x: -800, y: -100 }]], bridge: true },
    ]));
    const a = findApproach(g, L.going, slope(g), 'N', L)!;
    const crossing = a.route.find((p) => Math.abs(p.y) < 15)!;
    expect(Math.abs(crossing.x + 800)).toBeLessThan(30);
    expect(distance(a.nai.centre, { x: -800, y: 0 })).toBeLessThan(150);
    expect(a.nai.channelledBy).toContain('water');
  });

  it('returns null if the enemy cannot cross', () => {
    const g = flatPlane(2000, 20);
    const L = buildLayers(g, set([{ kind: 'water', shape: 'area', rings: [rect(-1100, -100, 1100, 100)] }]));
    expect(findApproach(g, L.going, slope(g), 'N', L)).toBeNull();
  });

  it('works on slope alone, going round a steep hill', () => {
    const g = coneHill(4000, 20, { radiusM: 900, peak: 400 });
    const s = slope(g);
    const a = findApproach(g, slopeOnlyGoing(s), s, 'N', null)!;
    expect(a).not.toBeNull();
    // The route avoids the steep cone (centre at 0,0).
    expect(Math.min(...a.route.map((p) => Math.hypot(p.x, p.y)))).toBeGreaterThan(500);
  });
});

describe('enemy OPs', () => {
  it('downsamples by averaging', () => {
    const g = fromFunction(120, 10, (x) => x);
    const c = downsample(g, 3);
    expect(c.width).toBe(4);
    expect(c.cellM).toBe(30);
    expect(c.data[0]).toBeCloseTo(-45, 5);
  });

  it('puts OPs on the high ground on the enemy side, spaced apart', () => {
    // A hill on the enemy (north) side; folded ground on the friendly side,
    // whose folds only a high observer can see into.
    const hill = coneHill(4000, 20, { cx: 0, cy: 1200, radiusM: 700, peak: 60, base: 0 });
    const g = fromFunction(4000, 20, (_x, y) => 100 + (y < 0 ? 8 * Math.sin(y / 150) : 0));
    for (let i = 0; i < g.data.length; i++) g.data[i] += hill.data[i];
    const ops = chooseEnemyOps(g, 0, null, { count: 4, view: { maxRangeM: 6000 } });
    expect(ops.length).toBe(4);
    expect(ops[0].point.y).toBeGreaterThan(0);
    expect(distance(ops[0].point, { x: 0, y: 1200 })).toBeLessThan(600);
    for (let a = 0; a < ops.length; a++)
      for (let b = a + 1; b < ops.length; b++) expect(distance(ops[a].point, ops[b].point)).toBeGreaterThanOrEqual(300);
    expect(ops[0].friendlyViewShare).toBeGreaterThan(0.5);
  });

  it('prefers a position by a wood when the view is equal', () => {
    const g = flatPlane(4000, 20, 100);
    const L = buildLayers(g, set([{ kind: 'wood', shape: 'area', rings: [rect(0, 450, 200, 650)] }]));
    const ops = chooseEnemyOps(g, 0, L, { count: 1 });
    expect(ops[0].concealed).toBe(true);
  });
});

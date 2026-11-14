import { describe, expect, it } from 'vitest';
import { flatPlane } from '../src/terrain/synthetic';
import { pointToCell, type Point } from '../src/terrain/grid';
import { lineOfSight, viewshed } from '../src/terrain/viewshed';
import { buildLayers } from '../src/features/layers';
import { buildObstacles } from '../src/features/obstacles';
import type { FeatureSet, MapFeature } from '../src/features/osm';

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 },
];
const set = (features: Partial<MapFeature>[]): FeatureSet => ({
  features: features.map((f) => ({ osmId: 't', ...f }) as MapFeature),
  source: 'test',
  attribution: '',
});

describe('woods, buildings and hedges block sight', () => {
  const g = flatPlane(2000, 10, 100);
  const L = buildLayers(g, set([
    { kind: 'wood', shape: 'area', rings: [rect(-300, 0, 300, 200)] },
    { kind: 'building', shape: 'area', rings: [rect(600, -300, 640, -260)] },
    { kind: 'hedge', shape: 'line', rings: [[{ x: -900, y: -300 }, { x: -500, y: -300 }]] },
  ]));
  const obstacles = buildObstacles(g, L);
  const me = { x: 0, y: -500 };
  const vs = viewshed(g, me, { obstacles });
  const seen = (p: Point) => {
    const c = pointToCell(g, p);
    return vs[c.row * g.width + c.col] === 1;
  };

  it('sees the treeline and 15 m into the wood, but no deeper', () => {
    expect(seen({ x: 0, y: 5 })).toBe(true);
    expect(seen({ x: 0, y: 15 })).toBe(true);
    expect(seen({ x: 0, y: 40 })).toBe(false);
    expect(seen({ x: 0, y: 150 })).toBe(false);
  });

  it('cannot see the ground behind the wood, but can beside it', () => {
    expect(seen({ x: 0, y: 400 })).toBe(false);
    expect(seen({ x: 700, y: 400 })).toBe(true);
  });

  it('without obstacles, the flat ground is all visible', () => {
    const bare = viewshed(g, me);
    const c = pointToCell(g, { x: 0, y: 400 });
    expect(bare[c.row * g.width + c.col]).toBe(1);
  });

  it('a building hides what is directly behind it', () => {
    // Ray from (0,-500) through the building at (620,-280) continues to about (900,-180).
    expect(seen({ x: 900, y: -180 })).toBe(false);
  });

  it('a hedge hides a prone man behind it but not a standing one', () => {
    const behind = { x: -700, y: -250 };
    const from = { x: -700, y: -900 };
    expect(lineOfSight(g, from, behind, 2, 0.5, false, obstacles)).toBe(false);
    expect(lineOfSight(g, from, behind, 2, 2.5, false, obstacles)).toBe(true);
    expect(lineOfSight(g, from, behind, 2, 0.5)).toBe(true); // ignoring obstacles
  });

  it('line of sight agrees with the viewshed about woods', () => {
    expect(lineOfSight(g, me, { x: 0, y: 5 }, 2, 2, false, obstacles)).toBe(true);
    expect(lineOfSight(g, me, { x: 0, y: 150 }, 2, 2, false, obstacles)).toBe(false);
    expect(lineOfSight(g, me, { x: 0, y: 400 }, 2, 2, false, obstacles)).toBe(false);
  });

  it('from inside a wood you see only the nearby trees', () => {
    const inside = viewshed(g, { x: 0, y: 100 }, { obstacles });
    const at = (p: Point) => inside[pointToCell(g, p).row * g.width + pointToCell(g, p).col];
    expect(at({ x: 0, y: 110 })).toBe(1);
    expect(at({ x: 0, y: -400 })).toBe(0);
  });

  it('does not count the trees twice where the elevation data already includes them', () => {
    const raised = flatPlane(2000, 10, 100);
    const Lr = buildLayers(raised, set([{ kind: 'wood', shape: 'area', rings: [rect(-300, 0, 300, 200)] }]));
    // A surface model shows the wood as 10 m of extra "ground".
    for (let i = 0; i < raised.data.length; i++) if (Lr.cover[i] === 1) raised.data[i] += 10;
    const ob = buildObstacles(raised, Lr);
    const c = pointToCell(raised, { x: 0, y: 100 });
    const i = c.row * raised.width + c.col;
    expect(raised.data[i] + ob.heightM[i]).toBeCloseTo(115, 0); // ground 100 + 15 m trees, not 125
  });
});

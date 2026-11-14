import { describe, expect, it } from 'vitest';
import { countMask, pointToCell, type Grid, type Mask, type Point } from '../src/terrain/grid';
import { coneHill, flatPlane, fromFunction, straightRidge, vValley } from '../src/terrain/synthetic';
import {
  coverage,
  deadGround,
  exposure,
  inRangeMask,
  lineOfSight,
  unionViewshed,
  viewshed,
} from '../src/terrain/viewshed';

const at = (g: Grid, m: Mask, p: Point) => {
  const c = pointToCell(g, p);
  return m[c.row * g.width + c.col];
};

describe('viewshed on a flat plane', () => {
  it('sees everything within range and nothing beyond it', () => {
    const g = flatPlane(4000, 10);
    const v = viewshed(g, { x: 0, y: 0 }, { maxRangeM: 1500 });
    const range = inRangeMask(g, [{ point: { x: 0, y: 0 } }], 1500);
    expect(countMask(v)).toBe(countMask(range));
    expect(at(g, v, { x: 1400, y: 0 })).toBe(1);
    expect(at(g, v, { x: 1000, y: 1000 })).toBe(1);
    expect(at(g, v, { x: 1600, y: 0 })).toBe(0);
  });

  it('loses the far ground to Earth curvature at long range', () => {
    // Eye at 2 m, target almost at ground level: horizon is roughly 6–7 km.
    const g = flatPlane(20000, 50);
    const opts = { obsHeightM: 2, targetHeightM: 0.1, maxRangeM: 9500, earthCurvature: true };
    const v = viewshed(g, { x: 0, y: 0 }, opts);
    expect(at(g, v, { x: 4000, y: 0 })).toBe(1);
    expect(at(g, v, { x: 9000, y: 0 })).toBe(0);
  });
});

describe('viewshed around a cone hill', () => {
  const g = coneHill(4000, 10, { radiusM: 1000, peak: 100 });

  it('cannot see the far side of the hill from its foot', () => {
    const v = viewshed(g, { x: 0, y: 1500 });
    expect(at(g, v, { x: 0, y: 500 })).toBe(1); // near slope
    expect(at(g, v, { x: 0, y: -500 })).toBe(0); // far slope
    expect(at(g, v, { x: 0, y: -1400 })).toBe(0); // ground in the hill's shadow
    expect(at(g, v, { x: 1500, y: 0 })).toBe(1); // open ground to the flank
  });

  it('sees everything from the summit of a straight-sided cone', () => {
    const v = viewshed(g, { x: 0, y: 0 }, { maxRangeM: 1900 });
    const range = inRangeMask(g, [{ point: { x: 0, y: 0 } }], 1900);
    // Allow a handful of cells lost to discretisation at the summit.
    expect(countMask(v) / countMask(range)).toBeGreaterThan(0.995);
  });
});

describe('viewshed across a ridge', () => {
  const g = straightRidge(4000, 10, { heightM: 80, halfWidthM: 800 });

  it('hides the reverse slope from an observer on the forward side', () => {
    const v = viewshed(g, { x: 0, y: 1500 });
    expect(at(g, v, { x: 0, y: 400 })).toBe(1); // forward slope
    expect(at(g, v, { x: 0, y: -400 })).toBe(0); // reverse slope
    expect(at(g, v, { x: 600, y: -300 })).toBe(0);
  });

  it('sees both sides from the crest', () => {
    const v = viewshed(g, { x: 0, y: 0 });
    expect(at(g, v, { x: 0, y: 700 })).toBe(1);
    expect(at(g, v, { x: 0, y: -700 })).toBe(1);
  });
});

describe('viewshed in a V-shaped valley', () => {
  const g = vValley(4000, 10, { gradient: 0.05 });

  it('sees both valley sides from the floor (concave ground hides nothing)', () => {
    const v = viewshed(g, { x: 0, y: 0 }, { maxRangeM: 1800 });
    const range = inRangeMask(g, [{ point: { x: 0, y: 0 } }], 1800);
    expect(countMask(v)).toBe(countMask(range));
  });

  it('sees the opposite side from high on one side', () => {
    const v = viewshed(g, { x: 1200, y: 0 });
    expect(at(g, v, { x: -1200, y: 0 })).toBe(1);
  });
});

describe('target height', () => {
  it('lets a vehicle be seen where a man is hidden', () => {
    // A 2.2 m bank 200 m in front of the observer, on flat ground.
    const g = fromFunction(2000, 10, (_x, y) => (y > 180 && y < 220 ? 102.2 : 100));
    const obs = { x: 0, y: 0 };
    const target = { x: 0, y: 700 };
    expect(lineOfSight(g, obs, target, 2, 2)).toBe(false); // man hidden
    expect(lineOfSight(g, obs, target, 2, 3)).toBe(true); // vehicle visible
    const man = viewshed(g, obs, { targetHeightM: 2 });
    const veh = viewshed(g, obs, { targetHeightM: 3 });
    expect(at(g, man, target)).toBe(0);
    expect(at(g, veh, target)).toBe(1);
  });
});

describe('line of sight agrees with the viewshed', () => {
  it('matches on a sample of cells around a cone hill', () => {
    const g = coneHill(3000, 10, { radiusM: 700, peak: 80 });
    const obs = { x: -1000, y: 900 };
    const v = viewshed(g, obs, { maxRangeM: 3000 });
    let agree = 0;
    let total = 0;
    for (let x = -1400; x <= 1400; x += 100) {
      for (let y = -1400; y <= 1400; y += 100) {
        total++;
        if ((lineOfSight(g, obs, { x, y }) ? 1 : 0) === at(g, v, { x, y })) agree++;
      }
    }
    // The two methods discretise differently; cells right on the edge of
    // dead ground can disagree. Expect very close agreement.
    expect(agree / total).toBeGreaterThan(0.97);
  });
});

describe('union viewshed and dead ground', () => {
  const g = straightRidge(4000, 10, { heightM: 80, halfWidthM: 800 });
  const north = { point: { x: 0, y: 1500 } };
  const south = { point: { x: 0, y: -1500 } };

  it('dead ground is what no observer sees, within range', () => {
    const dg = deadGround(g, [north], { maxRangeM: 3000 });
    expect(at(g, dg, { x: 0, y: -400 })).toBe(1);
    expect(at(g, dg, { x: 0, y: 400 })).toBe(0);
  });

  it('two observers either side of the ridge leave almost no dead ground', () => {
    const both = unionViewshed(g, [north, south], { maxRangeM: 3000 });
    const dg = deadGround(g, [north, south], { maxRangeM: 3000 });
    expect(countMask(dg) / both.length).toBeLessThan(0.01);
  });

  it('reports which enemy observers can see a position', () => {
    expect(exposure(g, { x: 0, y: 400 }, [north, south])).toEqual([0]);
    expect(exposure(g, { x: 0, y: -400 }, [north, south])).toEqual([1]);
    expect(exposure(g, { x: 0, y: 0 }, [north, south])).toEqual([0, 1]); // on the crest
  });

  it('computes the share of an area that is visible', () => {
    const v = viewshed(g, north.point);
    const forwardSlope = new Uint8Array(g.width * g.height);
    for (let row = 0; row < g.height; row++) {
      for (let col = 0; col < g.width; col++) {
        const y = 2000 - (row + 0.5) * 10;
        if (y > 100 && y < 700) forwardSlope[row * g.width + col] = 1;
      }
    }
    expect(coverage(v, forwardSlope)).toBeGreaterThan(0.95);
  });
});

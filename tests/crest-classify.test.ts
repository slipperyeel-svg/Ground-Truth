import { describe, expect, it } from 'vitest';
import { cellToPoint, countMask, type Grid, type Mask } from '../src/terrain/grid';
import { coneHill, convexRidge, flatPlane, rolling, straightRidge, vValley } from '../src/terrain/synthetic';
import { crestLine, isSilhouetted } from '../src/terrain/crest';
import { classifyGround } from '../src/terrain/classify';

/** y-coordinates (northings) of marked cells in the central column. */
function marksInColumn(g: Grid, m: Mask, col = Math.floor(g.width / 2)): number[] {
  const ys: number[] = [];
  for (let row = 0; row < g.height; row++) {
    if (m[row * g.width + col]) ys.push(cellToPoint(g, col, row).y);
  }
  return ys;
}

describe('crest lines', () => {
  it('puts both crests on the spine of a straight-sided ridge', () => {
    const g = straightRidge(4000, 10, { heightM: 80, halfWidthM: 800 });
    const c = crestLine(g, 0); // enemy to the north
    const topo = marksInColumn(g, c.topographical);
    const mil = marksInColumn(g, c.military);
    expect(topo).toHaveLength(1);
    expect(Math.abs(topo[0])).toBeLessThanOrEqual(10);
    expect(mil).toHaveLength(1);
    expect(Math.abs(mil[0] - topo[0])).toBeLessThanOrEqual(10);
  });

  it('puts the military crest forward of the topographical crest on a rounded ridge', () => {
    const g = convexRidge(4000, 10, { heightM: 60, widthM: 900 });
    const north = crestLine(g, 0);
    const topoN = marksInColumn(g, north.topographical)[0];
    const milN = marksInColumn(g, north.military)[0];
    expect(Math.abs(topoN)).toBeLessThanOrEqual(10);
    expect(milN).toBeGreaterThan(topoN + 100); // well forward, towards the enemy (north)

    // With the enemy to the south, the military crest moves to the south face.
    const south = crestLine(g, 180);
    const milS = marksInColumn(g, south.military)[0];
    expect(milS).toBeLessThan(-100);
  });

  it('forms a continuous line across the front', () => {
    const g = straightRidge(2000, 10, { heightM: 80, halfWidthM: 600 });
    const c = crestLine(g, 0);
    // One topographical crest cell in (nearly) every column.
    expect(countMask(c.topographical)).toBeGreaterThanOrEqual(g.width * 0.95);
  });

  it('finds no crest on flat ground', () => {
    const c = crestLine(flatPlane(2000, 10), 0);
    expect(countMask(c.topographical)).toBe(0);
  });
});

describe('skylining', () => {
  const ridge = straightRidge(6000, 10, { heightM: 80, halfWidthM: 800 });

  it('skylines a man on the crest to an enemy below on the forward side', () => {
    const r = isSilhouetted(ridge, { x: 0, y: 0 }, { x: 0, y: 1500 });
    expect(r.silhouetted).toBe(true);
    expect(r.visibleToEnemy).toBe(true);
  });

  it('gives a man halfway down the forward slope a backdrop', () => {
    const r = isSilhouetted(ridge, { x: 0, y: 400 }, { x: 0, y: 1500 });
    expect(r.silhouetted).toBe(false);
    expect(r.backdropDistanceM).not.toBeNull();
  });

  it('accepts a bearing instead of an enemy position', () => {
    expect(isSilhouetted(ridge, { x: 0, y: 0 }, 0).silhouetted).toBe(true);
    expect(isSilhouetted(ridge, { x: 0, y: 400 }, 0).silhouetted).toBe(false);
  });

  it('flags a provisional answer when the check runs off the data', () => {
    const small = straightRidge(2000, 10, { heightM: 80, halfWidthM: 600 });
    const r = isSilhouetted(small, { x: 0, y: -900 }, { x: 0, y: 500 });
    expect(r.ranOffGrid).toBe(true);
  });
});

describe('ground classification', () => {
  it('classes a flat plane as flat', () => {
    expect(classifyGround(flatPlane(4000, 10)).ground).toBe('flat');
  });

  it('classes a straight ridge as ridge', () => {
    expect(classifyGround(straightRidge(4000, 10, { heightM: 80, halfWidthM: 800 })).ground).toBe('ridge');
  });

  it('classes a V-shaped valley as valley', () => {
    expect(classifyGround(vValley(4000, 10, { gradient: 0.05 })).ground).toBe('valley');
  });

  it('classes an isolated hill and undulating ground as rolling', () => {
    expect(classifyGround(coneHill(4000, 10, { radiusM: 800, peak: 60 })).ground).toBe('rolling');
    expect(classifyGround(rolling(4000, 10, 15)).ground).toBe('rolling');
  });

  it('explains its decision in plain English', () => {
    const c = classifyGround(flatPlane(4000, 10));
    expect(c.reasons.join(' ')).toMatch(/Relief 0 m/);
  });
});

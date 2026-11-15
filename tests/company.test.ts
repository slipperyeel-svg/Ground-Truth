import { describe, expect, it } from 'vitest';
import { straightRidge } from '../src/terrain/synthetic';
import { placeEnemyCompany, COMPANY } from '../src/tactics/companyDefence';
import { bearingVector, type Point } from '../src/terrain/grid';

// A 4 km box at 10 m: a broad ridge running east–west 1 km north of the start.
const ground = straightRidge(4000, 10, { ridgeY: 1000, heightM: 40, halfWidthM: 900, base: 100 });
for (let i = 0; i < ground.data.length; i++) {
  // Some gentle folds along the ridge, so not every position is equal.
  const c = i % ground.width;
  ground.data[i] += 4 * Math.sin(c / 25);
}

const along = (p: Point, bearing: number) => {
  const u = bearingVector(bearing);
  return { f: p.x * u.x + p.y * u.y, l: p.x * u.y - p.y * u.x };
};

describe('enemy company defence', () => {
  const L = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { mines: true, dummies: true, dispersed: false, droneConcealment: false, isrFires: true } })!;

  it('has two platoons forward and one in depth, at doctrinal spacing', () => {
    expect(L).not.toBeNull();
    expect(L.advanceBearingDeg).toBe(0);
    const fwd = L.platoons.filter((p) => p.role === 'forward');
    const depth = L.platoons.filter((p) => p.role === 'depth');
    expect(fwd).toHaveLength(2);
    expect(depth).toHaveLength(1);
    const a = along(fwd[0].centre, 0), b = along(fwd[1].centre, 0), d = along(depth[0].centre, 0);
    const sep = Math.abs(a.l - b.l);
    expect(sep).toBeGreaterThanOrEqual(COMPANY.forwardSpacingM[0]);
    expect(sep).toBeLessThanOrEqual(COMPANY.forwardSpacingM[1]);
    const behind = d.f - (a.f + b.f) / 2;
    expect(behind).toBeGreaterThanOrEqual(COMPANY.depthBehindM[0]);
    expect(behind).toBeLessThanOrEqual(COMPANY.depthBehindM[1]);
    // Depth platoon sits between the forward two.
    expect(d.l).toBeGreaterThanOrEqual(Math.min(a.l, b.l) - 100);
    expect(d.l).toBeLessThanOrEqual(Math.max(a.l, b.l) + 100);
  });

  it('puts three sections in each platoon, spaced apart, and leaves a gap', () => {
    for (const p of L.platoons) {
      const s = p.positions.filter((x) => x.kind === 'section');
      expect(s.length).toBeGreaterThanOrEqual(2);
      expect(s.length).toBeLessThanOrEqual(3);
    }
    expect(L.gaps).toHaveLength(1);
    expect(L.gaps[0].widthM).toBeGreaterThan(150);
    expect(L.hq).not.toBeNull();
  });

  it('includes the optional elements when asked', () => {
    expect(L.mines).not.toBeNull();
    expect(L.mines!.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(L.dummies.length).toBeGreaterThan(0);
    expect(L.reasons.join(' ')).toMatch(/drone surveillance/);
  });

  it('uses small dispersed teams when asked', () => {
    const D = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { dispersed: true, mines: false, dummies: false, droneConcealment: false, isrFires: false } })!;
    const teams = D.platoons[0].positions.filter((x) => x.kind === 'team');
    expect(teams.length).toBeGreaterThan(3);
    expect(teams[0].men).toBeLessThanOrEqual(4);
    expect(D.mines).toBeNull();
  });

  it('chooses the optional elements the same way for the same seed', () => {
    const a = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], seed: 7 })!;
    const b = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], seed: 7 })!;
    expect(a.options).toEqual(b.options);
  });

  it('runs all four directions in reasonable time', () => {
    const t = performance.now();
    placeEnemyCompany({ grid: ground, layers: null, seed: 1 });
    const ms = performance.now() - t;
    console.log(`company defence, 4 directions, 4 km at 10 m: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(30000);
  }, 60000);
});

describe('dummy positions', () => {
  it('sit within the enemy area, not out in front of it', () => {
    const L = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { dummies: true, mines: false, dispersed: false, droneConcealment: false, isrFires: false } })!;
    const front = Math.min(...L.platoons.filter((p) => p.role === 'forward').flatMap((p) => p.positions.map((x) => x.point.y)));
    for (const d of L.dummies) expect(d.point.y).toBeGreaterThanOrEqual(front - 310);
  });
});

describe('mutual support and interlocking arcs', () => {
  it('reports interlocking arcs and which positions support each other', () => {
    const L = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { mines: false, dummies: false, dispersed: false, droneConcealment: false, isrFires: false } })!;
    expect(L.interlock).toBeGreaterThan(0.3);
    expect(L.support.length).toBeGreaterThanOrEqual(6);
    // Most positions should be supported by at least one other.
    const supported = L.support.filter((s) => s.supportedBy.length > 0).length;
    expect(supported / L.support.length).toBeGreaterThan(0.6);
    expect(L.reasons.join(' ')).toMatch(/Interlocking arcs: \d+%/);
    expect(L.reasons.join(' ')).toMatch(/Mutual support: \d+ of \d+/);
  });
});

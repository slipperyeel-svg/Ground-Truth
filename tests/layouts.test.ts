import { describe, expect, it } from 'vitest';
import { straightRidge } from '../src/terrain/synthetic';
import { LAYOUT_TYPES, placeEnemyCompany, type LayoutType } from '../src/tactics/companyDefence';

// The same ground as the company tests: a broad east–west ridge 1 km north of the start.
const ground = straightRidge(4000, 10, { ridgeY: 1000, heightM: 40, halfWidthM: 900, base: 100 });
for (let i = 0; i < ground.data.length; i++) ground.data[i] += 4 * Math.sin((i % ground.width) / 25);
const opts = { mines: false, dummies: false, dispersed: false, droneConcealment: false, isrFires: false };
const place = (layout: LayoutType) => placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: opts, layout })!;

describe('enemy company layouts (PO, 19 Nov 2026)', () => {
  const expected: Record<LayoutType, string> = {
    twoUp: 'depth,forward,forward',
    oneUp: 'depth,depth,forward',
    threeUp: 'forward,forward,forward',
    strongpoint: 'depth,depth,forward',
    screen: 'forward,forward,screen',
    counterattack: 'forward,forward,reserve',
    echelon: 'depth,depth,forward',
  };
  for (const t of LAYOUT_TYPES)
    it(`builds ${t}`, () => {
      const L = place(t);
      expect(L.layout).toBe(t);
      expect(L.platoons.map((p) => p.role).sort().join(',')).toBe(expected[t]);
      expect(L.reasons[0].length).toBeGreaterThan(20);
    }, 60_000);

  it('puts the depth of one up, two back behind its forward platoon', () => {
    const L = place('oneUp');
    const f = (p: { y: number }) => p.y; // advancing north
    const fwdP = L.platoons.find((p) => p.role === 'forward')!;
    for (const d of L.platoons.filter((p) => p.role === 'depth')) expect(f(d.centre)).toBeGreaterThan(f(fwdP.centre) + 250);
  });

  it('holds the counter-attack force back and out of the fire plan', () => {
    const L = place('counterattack');
    const r = L.platoons.find((p) => p.role === 'reserve')!;
    const front = Math.min(...L.platoons.filter((p) => p.role === 'forward').map((p) => p.centre.y));
    expect(r.centre.y - front).toBeGreaterThanOrEqual(450);
    expect(L.support.some((s) => s.label.includes(r.name))).toBe(false);
  });

  it('puts the screen well in front of the main position', () => {
    const L = place('screen');
    const scr = L.platoons.find((p) => p.role === 'screen')!;
    const main = Math.min(...L.platoons.filter((p) => p.role === 'forward').flatMap((p) => p.positions.filter((x) => x.kind !== 'outpost').map((x) => x.point.y)));
    for (const t of scr.positions) expect(main - t.point.y).toBeGreaterThan(400);
  });

  it('chooses among the layouts that fit when seeded, with variety', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) seen.add(placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: opts, seed })!.layout);
    expect(seen.size).toBeGreaterThan(1);
  }, 300_000);
});

describe('spacing between enemy elements varies (PO, 20 Nov 2026)', () => {
  const at = (spread: 'close' | 'very wide') =>
    placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: opts, layout: 'twoUp', spread })!;
  /** Smallest distance between two sections of the same platoon, over the company. */
  const minSpacing = (L: ReturnType<typeof at>) => {
    let m = Infinity;
    for (const p of L.platoons) {
      const s = p.positions.filter((x) => x.kind === 'section');
      for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) m = Math.min(m, Math.hypot(s[i].point.x - s[j].point.x, s[i].point.y - s[j].point.y));
    }
    return m;
  };
  it('a very wide company is spread wider than a close one', () => {
    const close = at('close'), wide = at('very wide');
    expect(close.spread.name).toBe('close');
    expect(wide.spread.factor).toBe(1.6);
    expect(minSpacing(close)).toBeGreaterThanOrEqual(74);
    expect(minSpacing(wide)).toBeGreaterThanOrEqual(159);
    expect(wide.reasons.join(' ')).toMatch(/Spacing: very wide/);
  }, 120_000);
  it('seeded problems vary the spacing', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) seen.add(placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: opts, layout: 'twoUp', seed })!.spread.name);
    expect(seen.size).toBeGreaterThan(1);
  }, 300_000);
});

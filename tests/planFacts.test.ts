import { describe, expect, it } from 'vitest';
import { straightRidge } from '../src/terrain/synthetic';
import { placeEnemyCompany } from '../src/tactics/companyDefence';
import { planFacts } from '../src/tactics/planFacts';
import type { Point } from '../src/terrain/grid';

// The same ground as the company tests: a broad east–west ridge 1 km north of the start.
const ground = straightRidge(4000, 10, { ridgeY: 1000, heightM: 40, halfWidthM: 900, base: 100 });
for (let i = 0; i < ground.data.length; i++) ground.data[i] += 4 * Math.sin((i % ground.width) / 25);
const L = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { mines: true, dummies: true, dispersed: false, droneConcealment: false, isrFires: true } })!;
const ref = (p: Point) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;

describe('facts about the user plan', () => {
  const enemy = L.platoons.flatMap((p) => p.positions);
  const target = enemy[0].point;

  it('reports a straight route into the enemy as under fire', () => {
    const f = planFacts(ground, null, L, { routes: [{ who: '1 Section', points: [{ x: 0, y: 0 }, target] }], positions: [] }, ref);
    expect(f.route[0]).toMatch(/^1 Section's route: /);
    expect(f.route.join(' ')).toMatch(/lay under enemy fire/);
    expect(f.route.join(' ')).not.toMatch(/None of it/);
    expect(f.route.join(' ')).toMatch(/came within 0 m|came within \d+ m/);
  });

  it('reports a route kept well back as out of fire', () => {
    const f = planFacts(ground, null, L, { routes: [{ who: '1 Section', points: [{ x: -1500, y: -1500 }, { x: 1500, y: -1500 }] }], positions: [] }, ref);
    expect(f.route.join(' ')).toMatch(/None of it lay under enemy fire/);
  });

  it('says which enemy positions see a position close in front of them, and which it sees', () => {
    const p = { x: target.x, y: target.y - 150 };
    const f = planFacts(ground, null, L, { routes: [], positions: [{ kind: 'Fire support', label: 'Fire support', point: p }] }, ref);
    expect(f.positions).toHaveLength(1);
    const text = f.positions[0].facts.join(' ');
    expect(text).toMatch(/Seen by \d+ enemy position/);
    expect(text).toMatch(/Nearest enemy: /);
  });

  it('gives no route facts without a route', () => {
    expect(planFacts(ground, null, L, { routes: [], positions: [] }, ref).route).toHaveLength(0);
  });
});

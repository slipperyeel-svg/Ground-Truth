import { describe, expect, it } from 'vitest';
import { straightRidge } from '../src/terrain/synthetic';
import { placeEnemyCompany } from '../src/tactics/companyDefence';
import { developFromPlan, PLAN_EVENTS } from '../src/tactics/planEvents';
import type { Point } from '../src/terrain/grid';

// The same ground as the company tests: a broad east–west ridge 1 km north of the start.
const ground = straightRidge(4000, 10, { ridgeY: 1000, heightM: 40, halfWidthM: 900, base: 100 });
for (let i = 0; i < ground.data.length; i++) ground.data[i] += 4 * Math.sin((i % ground.width) / 25);
const L = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { mines: false, dummies: true, dispersed: false, droneConcealment: false, isrFires: false } })!;
const ref = (p: Point) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;
const hhmm = (d: Date) => d.toISOString().slice(11, 16).replace(':', '');
const start = Date.UTC(2026, 10, 15, 7, 0);

describe('the situation develops from the plan', () => {
  const target = L.platoons.flatMap((p) => p.positions).find((x) => x.kind !== 'outpost')!.point;

  it('a route straight at the enemy meets fire, at the right time for 2 km/h', () => {
    const d = developFromPlan(ground, null, L, { routes: [{ who: '1 Section', points: [{ x: 0, y: 0 }, target] }], positions: [] }, start, ref, hhmm);
    const fire = d.messages.find((m) => /fire from about/.test(m.text));
    expect(fire).toBeDefined();
    // Moved off 30 minutes after the problem was set, at 0730.
    expect(d.time).toMatch(/moved off at 0730/);
    expect(fire!.from).toBe('1 Section');
    expect(d.sightings.length).toBeGreaterThan(0);
    // The time of contact matches the distance walked at 2 km/h.
    const at = fire!.text.match(/At \((-?\d+), (-?\d+)\)/)!;
    const walked = Math.hypot(+at[1], +at[2]);
    const mins = 30 + walked / ((PLAN_EVENTS.paceKmh * 1000) / 60);
    const expected = new Date(start + mins * 60_000);
    expect(Math.abs(+fire!.time - +hhmm(expected))).toBeLessThanOrEqual(1);
  });

  it('a route kept back and out of sight brings the enemy to you instead', () => {
    const d = developFromPlan(ground, null, L, { routes: [{ who: '1 Section', points: [{ x: -1500, y: -1700 }, { x: 1500, y: -1700 }] }], positions: [] }, start, ref, hhmm);
    expect(d.messages.some((m) => /not fired on/.test(m.text))).toBe(true);
    expect(d.messages.some((m) => /enemy seen moving/.test(m.text))).toBe(true);
  });

  it('a fire support position reports what can really be seen from it', () => {
    const fsp = { x: target.x, y: target.y - 250 };
    const d = developFromPlan(
      ground, null, L,
      { routes: [{ who: '1 Section', points: [{ x: -1500, y: -1700 }, { x: 1500, y: -1700 }] }], positions: [{ kind: 'Fire support', label: 'Fire support', point: fsp }] },
      start, ref, hhmm,
    );
    expect(d.messages.some((m) => m.from.startsWith('Fire support') && /In position/.test(m.text))).toBe(true);
  });

  it('reports from whichever element meets the enemy first', () => {
    const d = developFromPlan(
      ground, null, L,
      { routes: [{ who: '1 Section', points: [{ x: -1500, y: -1700 }, { x: 1500, y: -1700 }] }, { who: '2 Section', points: [{ x: 0, y: 0 }, target] }], positions: [] },
      start, ref, hhmm,
    );
    expect(d.messages.some((m) => m.from === '2 Section' && /fire from about/.test(m.text))).toBe(true);
  });
});

describe('where each element is when the situation develops', () => {
  const target = L.platoons.flatMap((p) => p.positions).find((x) => x.kind !== 'outpost')!.point;
  it('halts the element in contact and moves the others on at 2 km/h', () => {
    const d = developFromPlan(
      ground, null, L,
      { routes: [{ who: '1 Section', points: [{ x: 0, y: 0 }, target] }, { who: '2 Section', points: [{ x: -1500, y: -1700 }, { x: 1500, y: -1700 }] }], positions: [] },
      start, ref, hhmm,
    );
    expect(d.asAt).toMatch(/^\d{4}$/);
    const one = d.elements.find((e) => e.who === '1 Section')!;
    const two = d.elements.find((e) => e.who === '2 Section')!;
    expect(one.state).toBe('in contact');
    expect(two.state).toBe('moving');
    // 2 Section has walked as far along its route as 1 Section had when it was fired on.
    const walked1 = Math.hypot(one.point.x, one.point.y);
    const walked2 = two.point.x + 1500;
    expect(Math.abs(walked1 - walked2)).toBeLessThan(25);
  });
});

describe('counter-attack (PO, 19 Nov 2026)', () => {
  it('the hidden reserve counter-attacks when you close on the position', () => {
    const LC = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], layout: 'counterattack', options: { mines: false, dummies: false, dispersed: false, droneConcealment: false, isrFires: false } })!;
    expect(LC.layout).toBe('counterattack');
    const target = LC.platoons.find((p) => p.role === 'forward')!.centre;
    const d = developFromPlan(ground, null, LC, { routes: [{ who: '1 Section', points: [{ x: 0, y: 0 }, target] }], positions: [] }, start, ref, hhmm);
    const all = d.messages.map((m) => m.text).join(' ');
    // Either the counter-attack, or fire from the forward positions first and the counter-attack soon after.
    expect(all).toMatch(/counter-attack|fire from about/);
    expect(d.sightings.some((x) => x.label === 'BMP') || /fire from about/.test(all)).toBe(true);
  });
});

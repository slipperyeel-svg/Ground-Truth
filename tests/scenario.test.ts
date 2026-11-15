import { describe, expect, it } from 'vitest';
import { straightRidge } from '../src/terrain/synthetic';
import { placeEnemyCompany } from '../src/tactics/companyDefence';
import { writePlatoonScenario, type TaskType } from '../src/tactics/platoonScenario';

const ground = straightRidge(4000, 10, { ridgeY: 1000, heightM: 40, halfWidthM: 900, base: 100 });
for (let i = 0; i < ground.data.length; i++) ground.data[i] += 4 * Math.sin((i % ground.width) / 25);
ground.meta = { ...ground.meta, centre: { lat: 51.25, lon: -1.9 } };
const layout = placeEnemyCompany({ grid: ground, layers: null, sides: ['S'], options: { mines: true, dummies: true, dispersed: false, droneConcealment: false, isrFires: true } })!;
const now = new Date(Date.UTC(2026, 10, 15, 12));

describe('platoon scenario (Moltke guidelines G1–G13)', () => {
  it('contains every guideline element', () => {
    const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 3, now, timeZone: 'Europe/London' });
    expect(s.you).toMatch(/You command 2 Platoon/); // G2
    expect(s.force.length).toBeGreaterThanOrEqual(3); // G3
    expect(s.situation).toMatch(/advancing on 0000 mils|advancing on 6390 mils|advancing on 0010 mils/); // G4: grid bearing in mils
    expect(s.task_text.length).toBeGreaterThan(20);
    expect(s.enemy.length).toBeGreaterThan(0); // G5
    for (const e of s.enemy) expect(e.source.length).toBeGreaterThan(3);
    expect(s.enemyGaps.length).toBeGreaterThan(10);
    expect(s.time).toMatch(/Time now \d{4}/); // G6
    expect(s.ground.length).toBeGreaterThan(0); // G7
    expect(s.ownTroops).toMatch(/1 Platoon/); // G8
    expect(s.weather.length).toBeGreaterThan(5); // G9
    expect(s.questions.length).toBeGreaterThanOrEqual(2); // G10
    expect(s.questions.length).toBeLessThanOrEqual(3);
    expect(s.phase2.messages.length).toBeGreaterThan(0); // G11
    expect(s.ds.join(' ')).toMatch(/no school solution/); // G13
    expect(s.ds.join(' ')).not.toMatch(/best covered route|quality gate/i); // never shown as an answer
    // G1: the visible problem is short.
    const words = [s.you, s.situation, s.task_text, ...s.enemy.map((e) => e.text), s.enemyGaps, s.time, ...s.ground, s.ownTroops, s.weather, ...s.questions]
      .join(' ').split(/\s+/).length;
    expect(words).toBeLessThan(400);
  });

  it('writes each task type', () => {
    for (const task of ['secure', 'neutralise', 'findFix', 'screen'] as TaskType[]) {
      const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 5, task, info: 'partial', now, timeZone: 'Europe/London' });
      expect(s.task).toBe(task);
      expect(s.direct).not.toBeNull();
      expect(s.covered).not.toBeNull();
      expect(s.gate).toMatch(/^(Passed|Weak)/);
    }
  });

  it('gives more, and more reliable, information at richer levels', () => {
    const rich = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 9, info: 'rich', now });
    const poor = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 9, info: 'poor', now });
    expect(rich.enemy.length).toBeGreaterThan(poor.enemy.length);
    expect(rich.enemy.some((e) => e.reliability === 'good')).toBe(true);
    // Poor information asks the user to find the enemy first.
    expect(poor.questions[0]).toMatch(/Where do you expect the enemy/);
  });

  it('keeps the covered route out of fire better than the obvious one', () => {
    const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 2, task: 'secure', now });
    expect(s.covered!.underFire).toBeLessThanOrEqual(s.direct!.underFire + 1e-9);
  });
});

describe('time and light (PO, 15 Nov 2026)', () => {
  const at = (h: number, m: number) =>
    writePlatoonScenario({ grid: ground, layers: null, layout, seed: 3, now: new Date(Date.UTC(2026, 10, 15, h, m)), timeZone: 'Europe/London' }).time;
  it('uses the time given, and rounds "complete by" to the nearest ten minutes', () => {
    expect(at(10, 7)).toMatch(/Time now 1007\./);
    expect(at(10, 7)).toMatch(/complete by 1210\./);
    expect(at(6, 21)).toMatch(/complete by 0820\./);
    expect(at(6, 26)).toMatch(/complete by 0830\./);
  });
  it('describes the light for the time of day', () => {
    // Mid-November on Salisbury Plain: first light about 0650, sunrise about 0725, sunset about 1615.
    expect(at(6, 21)).toMatch(/It is dark\. First light 06\d\d, sunrise 07\d\d\./);
    expect(at(10, 7)).toMatch(/Sunset 16\d\d, last light 16\d\d: about \d+(\.\d)? hours of light remain\./);
    expect(at(20, 0)).toMatch(/It is dark: last light was 16\d\d\. First light tomorrow 06\d\d/);
    expect(at(16, 30)).toMatch(/Sunset was 16\d\d, last light 16\d\d: about \d+ minutes of light remain\./);
  });
});

describe('objectives and boundaries (PO, 15 Nov 2026)', () => {
  it('names your objective as well as the battlegroup objective', () => {
    const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 3, task: 'secure', info: 'partial', now, timeZone: 'Europe/London' });
    expect(s.markers.task.code).toMatch(/^OBJ [A-Z]+$/);
    expect(s.markers.task.code).not.toBe(s.markers.bgObjective.name);
    expect(s.task_text).toContain(s.markers.task.code!);
  });
  it('draws a platoon boundary with 1 Pl, the B/A company boundary and the battlegroup boundary', () => {
    const s = writePlatoonScenario({ grid: ground, layers: null, layout, seed: 3, now, timeZone: 'Europe/London' });
    const b = s.markers.control.filter((c) => c.kind === 'boundary').map((c) => c.label).sort();
    expect(b).toEqual(['I', 'II', '•••']);
  });
});

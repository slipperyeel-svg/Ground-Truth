import { describe, expect, it } from 'vitest';
import { flatPlane, straightRidge } from '../src/terrain/synthetic';
import { distance } from '../src/terrain/grid';
import { placeEnemySection } from '../src/tactics/sectionDefence';

describe('enemy section placement', () => {
  // A ridge running east–west 500 m north of the start, rising 30 m.
  const ridge = straightRidge(2000, 5, { ridgeY: 500, heightM: 30, halfWidthM: 600, base: 100 });

  it('blocks an advance north from the ridge, facing the attacker', () => {
    const s = placeEnemySection({ grid: ridge, layers: null, posture: 'prepared', sides: ['S'] })!;
    expect(s).not.toBeNull();
    expect(s.attackerSide).toBe('S');
    expect(s.advanceBearingDeg).toBe(0);
    // Either on the crest or forward slope, or on the reverse slope covering the
    // crest within rifle-to-gun range (a legitimate reverse-slope defence).
    expect(s.position.y).toBeGreaterThanOrEqual(250);
    expect(s.position.y - 500).toBeLessThanOrEqual(450);
    expect(s.scores.routeCover).toBeGreaterThan(0.5);
  });

  it('lays out two fire teams 40 m apart, one with the gun', () => {
    const s = placeEnemySection({ grid: ridge, layers: null, posture: 'prepared', sides: ['S'] })!;
    expect(s.teams).toHaveLength(2);
    expect(s.teams.filter((t) => t.gun)).toHaveLength(1);
    expect(distance(s.teams[0].point, s.teams[1].point)).toBeGreaterThan(20);
    expect(distance(s.teams[0].point, s.teams[1].point)).toBeLessThanOrEqual(41);
  });

  it('maps a kill zone in front, and gives plain-English reasons', () => {
    const s = placeEnemySection({ grid: ridge, layers: null, posture: 'hasty', sides: ['S'] })!;
    expect(s.killZone.reduce((a, b) => a + b, 0)).toBeGreaterThan(1000);
    expect(s.reasons.length).toBeGreaterThan(4);
    expect(s.reasons[0]).toMatch(/Sees \d+% of the/);
  });

  it('prefers the direction with the most defensible block', () => {
    // On a ridge running east–west, a block of movement north or south (across the
    // ridge) is stronger than one of movement east or west (along it).
    const s = placeEnemySection({ grid: ridge, layers: null, posture: 'prepared' })!;
    expect(['S', 'N']).toContain(s.attackerSide);
    expect(s.log).toHaveLength(4);
  });

  it('runs on a 2 km box at 2 m in reasonable time', () => {
    const fine = flatPlane(2000, 2, 100);
    for (let i = 0; i < fine.data.length; i++) fine.data[i] += 20 * Math.sin(i / fine.width / 60);
    const t = performance.now();
    placeEnemySection({ grid: fine, layers: null, posture: 'prepared' });
    const ms = performance.now() - t;
    console.log(`section placement, 4 directions, 2 km at 2 m: ${Math.round(ms)} ms`);
    expect(ms).toBeLessThan(20000);
  }, 30000);
});

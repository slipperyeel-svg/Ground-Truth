import { describe, expect, it } from 'vitest';
import { analyse } from '../src/terrain/analyse';
import { rolling, straightRidge } from '../src/terrain/synthetic';

/**
 * Brief target: full analysis of a 4 km box in under 5 s on a mid-range phone.
 * A mid-range phone runs this kind of code roughly 3–5× slower than a laptop
 * or this test server, so we require under 1 s here to leave headroom.
 */
describe('performance', () => {
  it('analyses a 4 km box at 10 m cells in under 1 s on a desktop-class CPU', () => {
    const g = rolling(4000, 10, 20);
    analyse({ grid: g, enemyBearingDeg: 0 }); // warm-up (JIT)
    const r = analyse({ grid: g, enemyBearingDeg: 0 });
    console.log('Timings (ms):', JSON.stringify(r.timingsMs));
    expect(r.timingsMs.total).toBeLessThan(1000);
  });

  it('produces sensible joined-up results on a ridge with the enemy to the north', () => {
    const g = straightRidge(4000, 10, { heightM: 80, halfWidthM: 800 });
    const r = analyse({ grid: g, enemyBearingDeg: 0 });
    expect(r.ground.ground).toBe('ridge');
    // Enemy on the north edge: the south (reverse) slope should be largely dead ground.
    let dead = 0;
    let south = 0;
    for (let row = 220; row < 280; row++) {
      for (let col = 50; col < 350; col++) {
        south++;
        dead += r.deadGround[row * g.width + col];
      }
    }
    expect(dead / south).toBeGreaterThan(0.9);
  });
});

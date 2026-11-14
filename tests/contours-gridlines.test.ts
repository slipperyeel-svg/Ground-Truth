import { describe, expect, it } from 'vitest';
import { contours, chooseInterval } from '../src/terrain/contours';
import { coneHill, flatPlane, vValley } from '../src/terrain/synthetic';
import { gridLines } from '../src/geo/gridlines';
import { toBNG } from '../src/geo/gridref';

describe('contours', () => {
  it('draws closed circles of the right radius round a cone hill', () => {
    // Cone: 100 m base, rises 100 m over 1,000 m radius → the 150 m contour is at 500 m.
    const g = coneHill(3000, 10, { radiusM: 1000, peak: 100, base: 100 });
    const lines = contours(g, 10);
    const c150 = lines.filter((l) => l.heightM === 150);
    expect(c150).toHaveLength(1);
    const pts = c150[0].points;
    const first = pts[0];
    const last = pts[pts.length - 1];
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(1); // closed
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(500, -1);
  });

  it('marks every fifth contour as an index contour', () => {
    const g = coneHill(3000, 10, { radiusM: 1000, peak: 100, base: 100 });
    const lines = contours(g, 10);
    expect(lines.find((l) => l.heightM === 150)!.index).toBe(true);
    expect(lines.find((l) => l.heightM === 160)!.index).toBe(false);
  });

  it('draws straight contours along a valley side', () => {
    const g = vValley(2000, 10, { gradient: 0.05, floor: 100 });
    const lines = contours(g, 10).filter((l) => l.heightM === 120);
    // Two lines, one each side, at x = ±400 m.
    expect(lines).toHaveLength(2);
    for (const l of lines) for (const p of l.points) expect(Math.abs(p.x)).toBeCloseTo(400, 0);
  });

  it('draws nothing on flat ground and picks a 5 m interval for gentle relief', () => {
    expect(contours(flatPlane(1000, 10, 100.5), 5)).toHaveLength(0);
    expect(chooseInterval(vValley(1000, 10, { gradient: 0.02 }))).toBe(5);
    expect(chooseInterval(vValley(4000, 10, { gradient: 0.05 }))).toBe(10);
  });
});

describe('grid lines', () => {
  it('draws BNG 1 km lines across a 4 km box in Britain', () => {
    const box = { south: 51.16, west: -1.86, north: 51.196, east: -1.803 };
    const fc = gridLines(box);
    const eastings = fc.features.filter((f) => f.properties.kind === 'easting');
    const northings = fc.features.filter((f) => f.properties.kind === 'northing');
    expect(eastings.length).toBeGreaterThanOrEqual(3);
    expect(northings.length).toBeGreaterThanOrEqual(3);
    // Each easting line really is at a whole kilometre.
    const [lon, lat] = (eastings[0].geometry as { coordinates: number[][] }).coordinates[5];
    const e = toBNG(lat, lon).easting;
    expect(Math.abs(e - Math.round(e / 1000) * 1000)).toBeLessThan(0.5);
  });

  it('falls back to UTM outside Britain', () => {
    const fc = gridLines({ south: 51.98, west: 8.47, north: 52.02, east: 8.53 });
    expect(fc.features.length).toBeGreaterThan(4);
  });
});

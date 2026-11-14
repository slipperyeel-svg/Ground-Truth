import { describe, expect, it } from 'vitest';
import { cellToPoint, elevationAtPoint, percentile, pointToCell } from '../src/terrain/grid';
import { coneHill, flatPlane, straightRidge, vValley } from '../src/terrain/synthetic';
import { aspect, hillshade, slope } from '../src/terrain/slope';
import { classifyLandforms, LANDFORM_CODES, tpi } from '../src/terrain/tpi';

describe('grid coordinates', () => {
  it('round-trips cell ↔ point, with row 0 at the north', () => {
    const g = flatPlane(1000, 10);
    const p = cellToPoint(g, 0, 0);
    expect(p.x).toBeCloseTo(-495);
    expect(p.y).toBeCloseTo(495); // north-west corner
    expect(pointToCell(g, p)).toEqual({ col: 0, row: 0 });
    expect(pointToCell(g, { x: 0.1, y: 0.1 })).toEqual({ col: 50, row: 49 });
  });

  it('interpolates elevation between cells', () => {
    const g = vValley(1000, 10, { gradient: 0.1 });
    expect(elevationAtPoint(g, { x: 200, y: 0 })).toBeCloseTo(120, 0);
  });

  it('computes percentiles', () => {
    expect(percentile(new Float32Array([5, 1, 3, 2, 4]), 50)).toBe(3);
  });
});

describe('slope', () => {
  it('is zero on flat ground', () => {
    const s = slope(flatPlane(500, 10));
    expect(Math.max(...s)).toBe(0);
  });

  it('matches the known gradient of a valley side', () => {
    const g = vValley(1000, 10, { gradient: 0.1 }); // 1 in 10
    const s = slope(g);
    const expected = (Math.atan(0.1) * 180) / Math.PI; // ≈ 5.71°
    const c = pointToCell(g, { x: 250, y: 0 });
    expect(s[c.row * g.width + c.col]).toBeCloseTo(expected, 2);
  });

  it('gives the aspect of a slope (downhill direction)', () => {
    const g = vValley(1000, 10, { gradient: 0.1 });
    const a = aspect(g);
    const east = pointToCell(g, { x: 250, y: 0 });
    const west = pointToCell(g, { x: -250, y: 0 });
    // East side of a valley faces west (downhill towards the floor), and vice versa.
    expect(a[east.row * g.width + east.col]).toBeCloseTo(270, 1);
    expect(a[west.row * g.width + west.col]).toBeCloseTo(90, 1);
  });
});

describe('hillshade', () => {
  it('lights north-west faces and darkens south-east faces', () => {
    const g = coneHill(2000, 10, { radiusM: 800, peak: 200 });
    const hs = hillshade(g);
    const nw = pointToCell(g, { x: -300, y: 300 });
    const se = pointToCell(g, { x: 300, y: -300 });
    expect(hs[nw.row * g.width + nw.col]).toBeGreaterThan(hs[se.row * g.width + se.col] + 50);
  });
});

describe('TPI and landforms', () => {
  it('is positive on a hill top and negative in a valley floor', () => {
    const hill = coneHill(4000, 10, { radiusM: 1000, peak: 100 });
    const t = tpi(hill, 300);
    const top = pointToCell(hill, { x: 0, y: 0 });
    expect(t[top.row * hill.width + top.col]).toBeGreaterThan(10);

    const valley = vValley(4000, 10, { gradient: 0.05 });
    const tv = tpi(valley, 300);
    const floor = pointToCell(valley, { x: 0, y: 0 });
    expect(tv[floor.row * valley.width + floor.col]).toBeLessThan(-5);
  });

  it('classifies a ridge crest as ridge and its flanks as slope', () => {
    const g = straightRidge(4000, 10, { heightM: 80, halfWidthM: 800 });
    const lf = classifyLandforms(g);
    const crest = pointToCell(g, { x: 0, y: 0 });
    const flank = pointToCell(g, { x: 0, y: 400 });
    expect(LANDFORM_CODES[lf[crest.row * g.width + crest.col]]).toBe('ridge');
    expect(LANDFORM_CODES[lf[flank.row * g.width + flank.col]]).toBe('slope');
  });

  it('classifies a flat plane as flat everywhere', () => {
    const lf = classifyLandforms(flatPlane(2000, 10));
    expect(new Set(lf)).toEqual(new Set([LANDFORM_CODES.indexOf('flat')]));
  });
});

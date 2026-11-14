import { describe, expect, it } from 'vitest';
import {
  bngGridRef,
  bngSquareLetters,
  fromBNG,
  gridRef,
  inGreatBritain,
  mgrsGridRef,
  toBNG,
  toUTM,
} from '../src/geo/gridref';

describe('British National Grid', () => {
  it('names 100 km squares correctly', () => {
    expect(bngSquareLetters(0, 0)).toBe('SV'); // false origin, south-west of Scilly
    expect(bngSquareLetters(437000, 115000)).toBe('SU'); // Hampshire
    expect(bngSquareLetters(530000, 180000)).toBe('TQ'); // London
    expect(bngSquareLetters(216600, 771200)).toBe('NN'); // Ben Nevis
    expect(bngSquareLetters(-1, 0)).toBeNull();
  });

  it('truncates rather than rounds the figures', () => {
    expect(bngGridRef(412399, 145699, 3)).toBe('SU 123 456');
    expect(bngGridRef(412399, 145699, 4)).toBe('SU 1239 4569');
    expect(bngGridRef(400050, 100050, 3)).toBe('SU 000 000');
  });

  it('puts Ben Nevis summit at NN 166 712', () => {
    const { easting, northing } = toBNG(56.79685, -5.003508);
    // Summit coordinates are approximate; the 7-parameter shift is good to ~5 m.
    expect(Math.abs(easting - 216666)).toBeLessThan(20);
    expect(Math.abs(northing - 771288)).toBeLessThan(20);
    expect(bngGridRef(easting, northing, 3)).toBe('NN 166 712');
  });

  it('round-trips WGS84 ↔ BNG', () => {
    const { easting, northing } = toBNG(51.1789, -1.8262);
    const back = fromBNG(easting, northing);
    expect(back.lat).toBeCloseTo(51.1789, 6);
    expect(back.lon).toBeCloseTo(-1.8262, 6);
  });
});

describe('choosing the grid', () => {
  it('recognises Great Britain and excludes Ireland and the Continent', () => {
    expect(inGreatBritain(51.18, -1.83)).toBe(true); // Salisbury Plain
    expect(inGreatBritain(57.5, -4.2)).toBe(true); // Inverness
    expect(inGreatBritain(55.3, -5.8)).toBe(true); // Mull of Kintyre
    expect(inGreatBritain(51.88, -5.27)).toBe(true); // St Davids
    expect(inGreatBritain(50.07, -5.7)).toBe(true); // Land's End
    expect(inGreatBritain(54.15, -4.5)).toBe(true); // Isle of Man
    expect(inGreatBritain(54.6, -5.93)).toBe(false); // Belfast
    expect(inGreatBritain(53.35, -6.26)).toBe(false); // Dublin
    expect(inGreatBritain(48.86, 2.35)).toBe(false); // Paris
    expect(inGreatBritain(50.95, 1.85)).toBe(false); // Calais
  });

  it('gives BNG in Britain and MGRS elsewhere', () => {
    expect(gridRef(51.18, -1.83).system).toBe('BNG');
    expect(gridRef(52.0, 8.5).system).toBe('MGRS'); // Sennelager area
  });
});

describe('MGRS', () => {
  it('matches the standard Washington Monument example (18S UJ 23487 06483)', () => {
    // Our input lat/lon is only good to ~10 m, so check to eight figures.
    expect(mgrsGridRef(38.8895, -77.0352, 4)).toBe('18S UJ 2348 0648');
    expect(mgrsGridRef(38.8895, -77.0352, 3)).toBe('18S UJ 234 064');
  });

  it('handles an even zone and the southern hemisphere', () => {
    // Even zone (row letters offset by 5)
    expect(mgrsGridRef(52.0, 8.5)).toMatch(/^32U [A-Z]{2} \d{3} \d{3}$/);
    // Sydney Opera House: 56H LH 34...
    expect(mgrsGridRef(-33.8568, 151.2153)).toMatch(/^56H LH \d{3} \d{3}$/);
  });

  it('applies the Norway zone exception', () => {
    expect(toUTM(60.39, 5.32).zone).toBe(32); // Bergen
  });
});

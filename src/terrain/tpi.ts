/**
 * Topographic Position Index (TPI): a cell's height minus the mean height of
 * the ground around it. Positive = higher than its surroundings (ridge, spur,
 * hilltop). Negative = lower (valley, re-entrant). Near zero = flat or a
 * uniform slope.
 *
 * For speed the "surroundings" is a square window of half-width radiusM,
 * computed with a summed-area table, so the cost does not depend on radius.
 * A square window is a standard approximation of the circular one and makes
 * no practical difference to landform classes.
 */
import type { Grid } from './grid';
import { slope as slopeOf } from './slope';

export function tpi(g: Grid, radiusM: number): Float32Array {
  const { width: w, height: h, data } = g;
  const rad = Math.max(1, Math.round(radiusM / g.cellM));

  // Summed-area table with a one-cell zero border: S[(r+1)*(w+1) + (c+1)].
  const W = w + 1;
  const S = new Float64Array(W * (h + 1));
  for (let r = 0; r < h; r++) {
    let rowSum = 0;
    for (let c = 0; c < w; c++) {
      rowSum += data[r * w + c];
      S[(r + 1) * W + (c + 1)] = S[r * W + (c + 1)] + rowSum;
    }
  }

  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    const r0 = Math.max(0, r - rad);
    const r1 = Math.min(h - 1, r + rad);
    for (let c = 0; c < w; c++) {
      const c0 = Math.max(0, c - rad);
      const c1 = Math.min(w - 1, c + rad);
      const sum =
        S[(r1 + 1) * W + (c1 + 1)] - S[r0 * W + (c1 + 1)] - S[(r1 + 1) * W + c0] + S[r0 * W + c0];
      const n = (r1 - r0 + 1) * (c1 - c0 + 1);
      out[r * w + c] = data[r * w + c] - sum / n;
    }
  }
  return out;
}

export type Landform = 'ridge' | 'spur' | 'slope' | 'valley' | 'reentrant' | 'flat';

export const LANDFORM_CODES: Landform[] = ['flat', 'slope', 'ridge', 'spur', 'valley', 'reentrant'];

export interface LandformOptions {
  smallRadiusM?: number; // default 150
  largeRadiusM?: number; // default 600
  /** TPI magnitude (m) counted as "high" or "low" at the small scale. */
  smallThresholdM?: number; // default 3
  /** TPI magnitude (m) counted as "high" or "low" at the large scale. */
  largeThresholdM?: number; // default 8
  /** Slopes below this (degrees) are flat if not otherwise high or low. */
  flatSlopeDeg?: number; // default 2
}

/**
 * Classify each cell into a landform using TPI at two scales (after Weiss 2001):
 *  - large-scale high + small-scale high  → ridge (hill tops, main ridgelines)
 *  - large-scale not high + small-scale high → spur (minor high ground)
 *  - large-scale low + small-scale low  → valley
 *  - large-scale not low + small-scale low → re-entrant (minor low ground)
 *  - otherwise: flat or slope by gradient.
 * Returns an index into LANDFORM_CODES per cell.
 */
export function classifyLandforms(g: Grid, opts: LandformOptions = {}): Uint8Array {
  const {
    smallRadiusM = 150,
    largeRadiusM = 600,
    smallThresholdM = 3,
    largeThresholdM = 8,
    flatSlopeDeg = 2,
  } = opts;
  const small = tpi(g, smallRadiusM);
  const large = tpi(g, largeRadiusM);
  const slp = slopeOf(g);
  const code = (l: Landform) => LANDFORM_CODES.indexOf(l);
  const out = new Uint8Array(small.length);
  for (let i = 0; i < out.length; i++) {
    const sHigh = small[i] > smallThresholdM;
    const sLow = small[i] < -smallThresholdM;
    const lHigh = large[i] > largeThresholdM;
    const lLow = large[i] < -largeThresholdM;
    let l: Landform;
    if (sHigh && lHigh) l = 'ridge';
    else if (sHigh) l = 'spur';
    else if (sLow && lLow) l = 'valley';
    else if (sLow) l = 'reentrant';
    else if (lHigh && slp[i] < flatSlopeDeg) l = 'ridge'; // broad flat top
    else if (lLow && slp[i] < flatSlopeDeg) l = 'valley'; // broad valley floor
    else l = slp[i] < flatSlopeDeg ? 'flat' : 'slope';
    out[i] = code(l);
  }
  return out;
}

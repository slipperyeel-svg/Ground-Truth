/**
 * Classify the ground in the working box as flat, rolling, ridge or valley.
 * (Close and urban come later, from OpenStreetMap and land-cover data.)
 *
 * Rules, in order:
 *  1. Relief (98th minus 2nd percentile of height) under 20 m → flat.
 *  2. A connected band of high ground (large-scale TPI) that runs most of the
 *     way across the box → ridge.
 *  3. A connected band of low ground running across the box → valley.
 *     (If both, the larger feature wins.)
 *  4. Otherwise → rolling.
 *
 * The edge of the box is ignored when looking for features, because TPI is
 * unreliable where its window runs off the data.
 */
import { percentile, type Grid } from './grid';
import { slope } from './slope';
import { tpi } from './tpi';

export type GroundClass = 'flat' | 'rolling' | 'ridge' | 'valley';

export interface ClassifyOptions {
  /** Relief below which ground is flat. Default 20 m (from the brief). */
  flatReliefM?: number;
  /** TPI window for the large-scale features. Default 600 m. */
  tpiRadiusM?: number;
  /** A feature "crosses the box" if it spans at least this share of it. Default 0.75. */
  crossingShare?: number;
}

export interface Feature {
  kind: 'high' | 'low';
  cells: number;
  /** Share (0–1) of the analysed area's width or height it spans, whichever is larger. */
  span: number;
}

export interface GroundClassification {
  ground: GroundClass;
  reliefM: number;
  meanSlopeDeg: number;
  /** The largest high and low features found, if any. */
  ridge: Feature | null;
  valley: Feature | null;
  /** Plain-English reasons, suitable for showing to the user. */
  reasons: string[];
}

/** Largest 4-connected component of a mask within [b, size-b), and its span. */
function largestFeature(mask: Uint8Array, w: number, h: number, border: number, kind: Feature['kind']): Feature | null {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  const innerW = w - 2 * border;
  const innerH = h - 2 * border;
  let best: Feature | null = null;

  for (let r0 = border; r0 < h - border; r0++) {
    for (let c0 = border; c0 < w - border; c0++) {
      const start = r0 * w + c0;
      if (!mask[start] || seen[start]) continue;
      let cells = 0;
      let minC = c0, maxC = c0, minR = r0, maxR = r0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        const r = Math.floor(i / w);
        const c = i - r * w;
        cells++;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        const nb = [
          [c + 1, r],
          [c - 1, r],
          [c, r + 1],
          [c, r - 1],
        ];
        for (const [nc, nr] of nb) {
          if (nc < border || nr < border || nc >= w - border || nr >= h - border) continue;
          const j = nr * w + nc;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
      const span = Math.max((maxC - minC + 1) / innerW, (maxR - minR + 1) / innerH);
      if (!best || cells > best.cells) best = { kind, cells, span };
    }
  }
  return best;
}

export function classifyGround(g: Grid, opts: ClassifyOptions = {}): GroundClassification {
  const { flatReliefM = 20, tpiRadiusM = 600, crossingShare = 0.75 } = opts;
  const reliefM = percentile(g.data, 98) - percentile(g.data, 2);
  const slp = slope(g);
  let sum = 0;
  for (let i = 0; i < slp.length; i++) sum += slp[i];
  const meanSlopeDeg = sum / slp.length;
  const reasons: string[] = [
    `Relief ${reliefM.toFixed(0)} m (98th–2nd percentile height); mean slope ${meanSlopeDeg.toFixed(1)}°.`,
  ];

  if (reliefM < flatReliefM) {
    reasons.push(`Relief under ${flatReliefM} m: classed as flat.`);
    return { ground: 'flat', reliefM, meanSlopeDeg, ridge: null, valley: null, reasons };
  }

  const t = tpi(g, tpiRadiusM);
  const threshold = Math.max(5, 0.1 * reliefM);
  const high = new Uint8Array(t.length);
  const low = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) {
    high[i] = t[i] > threshold ? 1 : 0;
    low[i] = t[i] < -threshold ? 1 : 0;
  }
  const border = Math.min(Math.round(tpiRadiusM / g.cellM), Math.floor(g.width / 4));
  const ridge = largestFeature(high, g.width, g.height, border, 'high');
  const valley = largestFeature(low, g.width, g.height, border, 'low');
  const ridgeCrosses = !!ridge && ridge.span >= crossingShare;
  const valleyCrosses = !!valley && valley.span >= crossingShare;

  let ground: GroundClass = 'rolling';
  if (ridgeCrosses && (!valleyCrosses || ridge!.cells >= valley!.cells)) ground = 'ridge';
  else if (valleyCrosses) ground = 'valley';

  if (ground === 'ridge') reasons.push(`A continuous band of high ground crosses ${(ridge!.span * 100).toFixed(0)}% of the box.`);
  else if (ground === 'valley') reasons.push(`A continuous band of low ground crosses ${(valley!.span * 100).toFixed(0)}% of the box.`);
  else reasons.push('No single ridge or valley crosses the box: classed as rolling.');

  return { ground, reliefM, meanSlopeDeg, ridge, valley, reasons };
}

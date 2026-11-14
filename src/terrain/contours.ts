/**
 * Contour lines by "marching squares": for each square of four neighbouring
 * cell centres, find where each contour height crosses its sides and join
 * the crossings with a line. The pieces are then joined into longer lines.
 *
 * Output is in local metres (x east, y north); the map layer converts to
 * latitude/longitude.
 */
import { cellToPoint, percentile, type Grid, type Point } from './grid';

export interface ContourLine {
  heightM: number;
  /** True for index contours (every fifth line), drawn bolder. */
  index: boolean;
  points: Point[];
}

/**
 * A sensible contour interval for the relief in the box: 5 m on gentle ground,
 * 10 m otherwise (like the OS 1:25,000 and 1:50,000 maps respectively).
 */
export function chooseInterval(g: Grid): number {
  const relief = percentile(g.data, 98) - percentile(g.data, 2);
  return relief < 40 ? 5 : 10;
}

export function contours(g: Grid, intervalM = chooseInterval(g)): ContourLine[] {
  const { width: w, height: h, data } = g;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < min) min = data[i];
    if (data[i] > max) max = data[i];
  }
  const out: ContourLine[] = [];
  const first = Math.ceil(min / intervalM) * intervalM;

  for (let level = first; level <= max; level += intervalM) {
    // Nudge the level off exact cell values so no corner sits exactly on it.
    const lv = level + 1e-4;
    const segments: [Point, Point][] = [];

    const cross = (c0: number, r0: number, z0: number, c1: number, r1: number, z1: number): Point => {
      const t = (lv - z0) / (z1 - z0);
      const p0 = cellToPoint(g, c0, r0);
      const p1 = cellToPoint(g, c1, r1);
      return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    };

    for (let r = 0; r < h - 1; r++) {
      for (let c = 0; c < w - 1; c++) {
        const tl = data[r * w + c];
        const tr = data[r * w + c + 1];
        const br = data[(r + 1) * w + c + 1];
        const bl = data[(r + 1) * w + c];
        const code = (tl > lv ? 8 : 0) | (tr > lv ? 4 : 0) | (br > lv ? 2 : 0) | (bl > lv ? 1 : 0);
        if (code === 0 || code === 15) continue;
        const top = () => cross(c, r, tl, c + 1, r, tr);
        const right = () => cross(c + 1, r, tr, c + 1, r + 1, br);
        const bottom = () => cross(c, r + 1, bl, c + 1, r + 1, br);
        const left = () => cross(c, r, tl, c, r + 1, bl);
        switch (code) {
          case 1: case 14: segments.push([left(), bottom()]); break;
          case 2: case 13: segments.push([bottom(), right()]); break;
          case 3: case 12: segments.push([left(), right()]); break;
          case 4: case 11: segments.push([top(), right()]); break;
          case 6: case 9: segments.push([top(), bottom()]); break;
          case 7: case 8: segments.push([left(), top()]); break;
          case 5: case 10: {
            // Saddle: decide by the average of the four corners.
            const centreHigh = (tl + tr + br + bl) / 4 > lv;
            if ((code === 5) === centreHigh) {
              segments.push([left(), top()], [bottom(), right()]);
            } else {
              segments.push([top(), right()], [left(), bottom()]);
            }
            break;
          }
        }
      }
    }
    const index = Math.round(level / intervalM) % 5 === 0;
    for (const points of joinSegments(segments)) out.push({ heightM: level, index, points });
  }
  return out;
}

/** Join line segments that share end points into longer polylines. */
function joinSegments(segments: [Point, Point][]): Point[][] {
  const key = (p: Point) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
  const ends = new Map<string, number[]>();
  segments.forEach(([a, b], i) => {
    for (const k of [key(a), key(b)]) {
      const list = ends.get(k);
      if (list) list.push(i);
      else ends.set(k, [i]);
    }
  });
  const used = new Uint8Array(segments.length);
  const lines: Point[][] = [];

  const extend = (line: Point[]) => {
    for (;;) {
      const tail = line[line.length - 1];
      const next = (ends.get(key(tail)) ?? []).find((j) => !used[j]);
      if (next === undefined) return;
      used[next] = 1;
      const [a, b] = segments[next];
      line.push(key(a) === key(tail) ? b : a);
    }
  };

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const line = [segments[i][0], segments[i][1]];
    extend(line);
    line.reverse();
    extend(line);
    lines.push(line);
  }
  return lines;
}

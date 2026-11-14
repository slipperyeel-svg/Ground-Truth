/**
 * Synthetic test terrains with known answers. Used by the unit tests and
 * handy for demonstrating the engine without network access.
 */
import { cellToPoint, createGrid, type Grid } from './grid';

type HeightFn = (x: number, y: number) => number;

export function fromFunction(sizeM: number, cellM: number, f: HeightFn): Grid {
  const n = Math.round(sizeM / cellM);
  const g = createGrid(n, n, cellM);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const p = cellToPoint(g, col, row);
      g.data[row * n + col] = f(p.x, p.y);
    }
  }
  return g;
}

/** Flat plane at a fixed height. */
export function flatPlane(sizeM = 4000, cellM = 10, heightM = 100): Grid {
  return fromFunction(sizeM, cellM, () => heightM);
}

/** Cone hill centred at (cx, cy): base height, peak height above base, base radius. */
export function coneHill(
  sizeM = 4000,
  cellM = 10,
  opts: { cx?: number; cy?: number; base?: number; peak?: number; radiusM?: number } = {},
): Grid {
  const { cx = 0, cy = 0, base = 100, peak = 100, radiusM = 1000 } = opts;
  return fromFunction(sizeM, cellM, (x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    return base + Math.max(0, peak * (1 - d / radiusM));
  });
}

/**
 * Straight east–west ridge along y = ridgeY. Triangular cross-section:
 * slopes fall linearly to the base at ±halfWidthM.
 */
export function straightRidge(
  sizeM = 4000,
  cellM = 10,
  opts: { ridgeY?: number; base?: number; heightM?: number; halfWidthM?: number } = {},
): Grid {
  const { ridgeY = 0, base = 100, heightM = 80, halfWidthM = 800 } = opts;
  return fromFunction(sizeM, cellM, (_x, y) => {
    const d = Math.abs(y - ridgeY);
    return base + Math.max(0, heightM * (1 - d / halfWidthM));
  });
}

/** V-shaped north–south valley along x = 0, sides rising at a fixed gradient. */
export function vValley(
  sizeM = 4000,
  cellM = 10,
  opts: { floor?: number; gradient?: number } = {},
): Grid {
  const { floor = 100, gradient = 0.05 } = opts;
  return fromFunction(sizeM, cellM, (x) => floor + Math.abs(x) * gradient);
}

/**
 * A rounded (convex) ridge: a smooth hump whose slope steepens away from the
 * crest. Unlike the triangular ridge, the foot of the forward slope cannot
 * be seen from the topographical crest, so it has a distinct military crest.
 */
export function convexRidge(
  sizeM = 4000,
  cellM = 10,
  opts: { base?: number; heightM?: number; widthM?: number } = {},
): Grid {
  const { base = 100, heightM = 60, widthM = 900 } = opts;
  return fromFunction(sizeM, cellM, (_x, y) => {
    const t = Math.min(1, Math.abs(y) / widthM);
    // cos^2 profile: flat on top, steepest mid-slope, flat at foot.
    // Convex near the top, so the crest hides the lower slope.
    return base + heightM * Math.cos((t * Math.PI) / 2) ** 2;
  });
}

/**
 * Rolling ground: an "egg-box" of separate knolls and hollows about 1.1 km
 * apart, with no continuous ridge or valley across the box.
 */
export function rolling(sizeM = 4000, cellM = 10, amplitudeM = 15): Grid {
  return fromFunction(
    sizeM,
    cellM,
    (x, y) => 100 + amplitudeM * Math.sin(x / 350) * Math.sin(y / 350),
  );
}

/**
 * Slope and hillshade, using Horn's method (the standard 3×3 estimate used by
 * GDAL and most GIS packages). Edge cells reuse their nearest neighbour.
 */
import type { Grid } from './grid';

/** Elevation gradient (dz/dx east, dz/dy north) at every cell. */
function gradients(g: Grid): { gx: Float32Array; gy: Float32Array } {
  const { width: w, height: h, cellM, data } = g;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const at = (c: number, r: number) =>
    data[Math.min(h - 1, Math.max(0, r)) * w + Math.min(w - 1, Math.max(0, c))];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const a = at(c - 1, r - 1), b = at(c, r - 1), cc = at(c + 1, r - 1);
      const d = at(c - 1, r), f = at(c + 1, r);
      const gg = at(c - 1, r + 1), hh = at(c, r + 1), i = at(c + 1, r + 1);
      // East is +col. North is -row, so dz/dy(north) = (top - bottom).
      gx[r * w + c] = (cc + 2 * f + i - (a + 2 * d + gg)) / (8 * cellM);
      gy[r * w + c] = (a + 2 * b + cc - (gg + 2 * hh + i)) / (8 * cellM);
    }
  }
  return { gx, gy };
}

/** Slope in degrees (0 = flat, 90 = vertical). */
export function slope(g: Grid): Float32Array {
  const { gx, gy } = gradients(g);
  const out = new Float32Array(gx.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = (Math.atan(Math.hypot(gx[i], gy[i])) * 180) / Math.PI;
  }
  return out;
}

/**
 * Direction the slope faces (downhill), degrees from grid north.
 * NaN on flat ground.
 */
export function aspect(g: Grid): Float32Array {
  const { gx, gy } = gradients(g);
  const out = new Float32Array(gx.length);
  for (let i = 0; i < out.length; i++) {
    if (gx[i] === 0 && gy[i] === 0) {
      out[i] = NaN;
      continue;
    }
    // Downhill direction is the negative gradient.
    const deg = (Math.atan2(-gx[i], -gy[i]) * 180) / Math.PI;
    out[i] = (deg + 360) % 360;
  }
  return out;
}

/**
 * Hillshade for display: 0 (dark) to 255 (bright).
 * Defaults: sun from the north-west (315°) at 45° — the cartographic convention.
 */
export function hillshade(
  g: Grid,
  sunAzimuthDeg = 315,
  sunAltitudeDeg = 45,
  zFactor = 1,
): Uint8ClampedArray {
  const { gx, gy } = gradients(g);
  const out = new Uint8ClampedArray(gx.length);
  const zen = ((90 - sunAltitudeDeg) * Math.PI) / 180;
  const az = (sunAzimuthDeg * Math.PI) / 180;
  // Unit vector pointing towards the sun (east, north, up).
  const sx = Math.sin(zen) * Math.sin(az);
  const sy = Math.sin(zen) * Math.cos(az);
  const sz = Math.cos(zen);
  for (let i = 0; i < out.length; i++) {
    // Surface normal is (-gx, -gy, 1), normalised.
    const nx = -gx[i] * zFactor;
    const ny = -gy[i] * zFactor;
    const len = Math.hypot(nx, ny, 1);
    const v = (nx * sx + ny * sy + sz) / len;
    out[i] = Math.max(0, v) * 255;
  }
  return out;
}

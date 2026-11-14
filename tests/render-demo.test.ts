/**
 * Renders picture(s) of the analysis on synthetic ground for a visual check.
 * Run with:  RENDER=1 npm test   → writes docs/m1-*.png
 */
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { analyse } from '../src/terrain/analyse';
import { pointToCell, type Grid } from '../src/terrain/grid';
import { coneHill, convexRidge, fromFunction } from '../src/terrain/synthetic';
import type { AnalysisResult } from '../src/terrain/analyse';

function render(g: Grid, r: AnalysisResult, file: string) {
  const png = new PNG({ width: g.width, height: g.height });
  for (let i = 0; i < g.width * g.height; i++) {
    let R = r.hillshade[i], G = r.hillshade[i], B = r.hillshade[i];
    if (r.deadGround[i]) { R = R * 0.6 + 255 * 0.4; G *= 0.6; B *= 0.6; } // red tint = dead ground
    png.data.set([R, G, B, 255], i * 4);
  }
  // Crest lines, drawn three pixels thick so they show at this size.
  const paint = (mask: Uint8Array, rgb: number[]) => {
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const row = Math.floor(i / g.width), col = i % g.width;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = row + dr, cc = col + dc;
        if (rr >= 0 && cc >= 0 && rr < g.height && cc < g.width) png.data.set([...rgb, 255], (rr * g.width + cc) * 4);
      }
    }
  };
  paint(r.crest.topographical, [30, 90, 255]); // blue = topographical crest
  paint(r.crest.military, [255, 200, 0]); // yellow = military crest
  for (const ob of r.enemyObservers) {
    const c = pointToCell(g, ob.point);
    for (let dr = -4; dr <= 4; dr++) for (let dc = -4; dc <= 4; dc++) {
      const col = c.col + dc, row = c.row + dr;
      if (col >= 0 && row >= 0 && col < g.width && row < g.height) png.data.set([200, 0, 0, 255], (row * g.width + col) * 4);
    }
  }
  writeFileSync(file, PNG.sync.write(png));
}

describe.skipIf(!process.env.RENDER)('render demo pictures', () => {
  it('writes docs/m1-*.png', () => {
    mkdirSync('docs', { recursive: true });
    // A rounded ridge with a knoll on its forward slope, enemy to the north.
    const ridge = convexRidge(4000, 10, { heightM: 60, widthM: 900 });
    const knoll = coneHill(4000, 10, { cx: 700, cy: 900, radiusM: 350, peak: 25, base: 0 });
    const g = fromFunction(4000, 10, () => 0);
    for (let i = 0; i < g.data.length; i++) g.data[i] = ridge.data[i] + knoll.data[i];
    render(g, analyse({ grid: g, enemyBearingDeg: 0 }), 'docs/m1-ridge-with-knoll.png');

    const hill = coneHill(4000, 10, { radiusM: 900, peak: 70 });
    render(hill, analyse({ grid: hill, enemyBearingDeg: 0 }), 'docs/m1-cone-hill.png');
  });
});

// Real-ground check of the tactical appreciation. Run with  NETWORK=1 npm test
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { loadElevation, TERRARIUM_URL, type TileSource } from '../src/terrain/elevation';
import { slope } from '../src/terrain/slope';
import { findApproach, slopeOnlyGoing, type Side } from '../src/tactics/approach';
import { chooseEnemyOps, type EnemyOP } from '../src/tactics/enemyOps';
import { hillshade } from '../src/terrain/slope';
import { pointToCell, type Grid } from '../src/terrain/grid';
import type { Approach } from '../src/tactics/approach';
import { templateA } from '../src/tactics/templateA';
import { classifyGround } from '../src/terrain/classify';
import { writeFileSync } from 'node:fs';

/** Picture for a visual check: corridor (blue tint), route (yellow), NAI (orange), enemy OPs (red). */
function render(g: Grid, a: Approach, ops: EnemyOP[], file: string) {
  const hs = hillshade(g);
  const png = new PNG({ width: g.width, height: g.height });
  for (let i = 0; i < g.width * g.height; i++) {
    let R = hs[i], G = hs[i], B = hs[i];
    if (a.corridor[i]) { R *= 0.7; G *= 0.8; B = B * 0.6 + 255 * 0.4; }
    if (a.nai.mask[i]) { R = R * 0.4 + 255 * 0.6; G = G * 0.4 + 140 * 0.6; B *= 0.4; }
    png.data.set([R, G, B, 255], i * 4);
  }
  const dot = (p: { x: number; y: number }, rad: number, rgb: number[]) => {
    const c = pointToCell(g, p);
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      const col = c.col + dc, row = c.row + dr;
      if (col >= 0 && row >= 0 && col < g.width && row < g.height) png.data.set([...rgb, 255], (row * g.width + col) * 4);
    }
  };
  for (const p of a.route) dot(p, 1, [255, 230, 0]);
  for (const o of ops) dot(o.point, 5, [210, 0, 0]);
  writeFileSync(file, PNG.sync.write(png));
}

const nodeSource: TileSource = {
  async getTile(z, x, y) {
    const url = TERRARIUM_URL.replace('{z}', `${z}`).replace('{x}', `${x}`).replace('{y}', `${y}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    return { width: png.width, height: png.height, data: png.data };
  },
};

describe.skipIf(!process.env.NETWORK)('appreciation on real ground (network)', () => {
  it('finds an approach and enemy OPs on Salisbury Plain within the time budget', async () => {
    const lat = Number(process.env.LAT ?? 51.2);
    const lon = Number(process.env.LON ?? -1.85);
    const g = await loadElevation(lat, lon, 4000, 10, { source: nodeSource });
    const s = slope(g);
    const going = slopeOnlyGoing(s);
    for (const side of ['N', 'E', 'S', 'W'] as Side[]) {
      const t0 = performance.now();
      const a = findApproach(g, going, s, side, null);
      const t1 = performance.now();
      const ops = chooseEnemyOps(g, a!.enemyBearingDeg, null);
      const t2 = performance.now();
      expect(a).not.toBeNull();
      if (process.env.RENDER) render(g, a!, ops, `${process.env.RENDER}-${side}.png`);
      const t3 = performance.now();
      const ta = templateA({ grid: g, slopeDeg: s, reliefM: classifyGround(g).reliefM, layers: null, approach: a!, enemyOps: ops, requireAccessCheck: false });
      const r = (p: { x: number; y: number } | undefined) => (p ? `(${Math.round(p.x)}, ${Math.round(p.y)})` : '-');
      console.log(
        `  Template A ${ta.passed ? 'PASSED' : 'failed'} in ${Math.round(performance.now() - t3)} ms.`,
        `best OP ${r(ta.bestViewOP?.point)} sees ${Math.round((ta.bestViewOP?.naiShare ?? 0) * 100)}%, seen by ${ta.bestViewOP?.seenBy}, skylined ${ta.bestViewOP?.silhouetted};`,
        `alt OP ${r(ta.alternativeOP?.point)} ${Math.round((ta.alternativeOP?.naiShare ?? 0) * 100)}% seen by ${ta.alternativeOP?.seenBy};`,
        `gun areas ${ta.gunAreas.length} (best ${r(ta.gunAreas[0]?.centre)} ${ta.gunAreas[0]?.areaHa.toFixed(1)} ha);`,
        `LOC ${Math.round(ta.locToBestOP?.lengthM ?? 0)} m, ${Math.round((ta.locToBestOP?.exposedShare ?? 0) * 100)}% exposed`,
        '\n   ' + ta.gate.join('\n   ') + '\n   ' + ta.dilemmas.map((d) => d.text).join('\n   '),
      );
      expect(ops.length).toBeGreaterThan(3);
      console.log(
        `${side}: route ${Math.round(a!.routeLengthM)} m, NAI at (${Math.round(a!.nai.centre.x)}, ${Math.round(a!.nai.centre.y)})`,
        `width ${Math.round(a!.nai.widthM)} m [${a!.nai.channelledBy.join(', ')}];`,
        `best enemy OP sees ${Math.round(ops[0].friendlyViewShare * 100)}%;`,
        `approach ${Math.round(t1 - t0)} ms, OPs ${Math.round(t2 - t1)} ms`,
      );
    }
  }, 60_000);
});

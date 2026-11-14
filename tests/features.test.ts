import { describe, expect, it } from 'vitest';
import { flatPlane, straightRidge } from '../src/terrain/synthetic';
import { pointToCell, type Point } from '../src/terrain/grid';
import { bboxAround, kindsFor, overpassQuery, parseOverpass, type FeatureSet, type MapFeature } from '../src/features/osm';
import { buildLayers, COVER, fillArea, drawLine, ROUTE } from '../src/features/layers';

const square = (cx: number, cy: number, h: number): Point[] => [
  { x: cx - h, y: cy - h },
  { x: cx + h, y: cy - h },
  { x: cx + h, y: cy + h },
  { x: cx - h, y: cy + h },
  { x: cx - h, y: cy - h },
];
const feature = (f: Partial<MapFeature> & Pick<MapFeature, 'kind' | 'shape' | 'rings'>): MapFeature => ({ osmId: 'test', ...f });
const set = (features: MapFeature[]): FeatureSet => ({ features, source: 'test', attribution: '' });
const at = (g: { width: number; height: number; cellM: number }, p: Point) => {
  const c = pointToCell(g as never, p);
  return c.row * g.width + c.col;
};

describe('OSM tags → feature kinds', () => {
  it('classifies roads, paths and areas', () => {
    expect(kindsFor({ highway: 'primary' }, false)).toEqual([{ kind: 'major-road', shape: 'line' }]);
    expect(kindsFor({ highway: 'track' }, false)).toEqual([{ kind: 'track', shape: 'line' }]);
    expect(kindsFor({ highway: 'footway' }, false)).toEqual([{ kind: 'path', shape: 'line' }]);
    expect(kindsFor({ landuse: 'forest' }, true)).toEqual([{ kind: 'wood', shape: 'area' }]);
    expect(kindsFor({ landuse: 'military' }, true)).toEqual([{ kind: 'military', shape: 'area' }]);
    expect(kindsFor({ natural: 'wood' }, false)).toEqual([]); // an unclosed wood outline is not an area
  });

  it('builds a query covering the box', () => {
    const b = bboxAround({ lat: 51.2, lon: -1.85 }, 4000);
    expect(b.north - b.south).toBeCloseTo(4000 / 111_195, 3);
    const q = overpassQuery(b);
    expect(q).toContain('out geom');
    expect(q).toContain('"highway"');
  });
});

describe('parsing Overpass JSON', () => {
  const centre = { lat: 51.2, lon: -1.85 };
  it('turns ways into local-metre features, with public access', () => {
    const fs = parseOverpass(
      {
        elements: [
          {
            type: 'way', id: 1, tags: { highway: 'footway', designation: 'public_footpath' },
            geometry: [{ lat: 51.2, lon: -1.85 }, { lat: 51.201, lon: -1.85 }],
          },
          {
            type: 'way', id: 2, tags: { highway: 'service', access: 'private' },
            geometry: [{ lat: 51.2, lon: -1.85 }, { lat: 51.2, lon: -1.849 }],
          },
        ],
      },
      centre,
    );
    expect(fs.features).toHaveLength(2);
    expect(fs.features[0].kind).toBe('path');
    expect(fs.features[0].publicAccess).toBe(true);
    expect(fs.features[0].rings[0][1].y).toBeCloseTo(111.2, 0);
    expect(fs.features[1].publicAccess).toBe(false);
  });

  it('joins split multipolygon members into one ring', () => {
    const fs = parseOverpass(
      {
        elements: [
          {
            type: 'relation', id: 9, tags: { natural: 'wood', type: 'multipolygon' },
            members: [
              { type: 'way', role: 'outer', geometry: [{ lat: 51.2, lon: -1.85 }, { lat: 51.201, lon: -1.85 }, { lat: 51.201, lon: -1.849 }] },
              { type: 'way', role: 'outer', geometry: [{ lat: 51.2, lon: -1.85 }, { lat: 51.2, lon: -1.849 }, { lat: 51.201, lon: -1.849 }] },
            ],
          },
        ],
      },
      centre,
    );
    expect(fs.features).toHaveLength(1);
    expect(fs.features[0].kind).toBe('wood');
    expect(fs.features[0].rings).toHaveLength(1);
    expect(fs.features[0].rings[0].length).toBe(5);
  });
});

describe('drawing features onto the grid', () => {
  it('fills a square area by cell centres', () => {
    const g = flatPlane(1000, 10);
    let n = 0;
    fillArea(g, [square(0, 0, 100)], () => n++);
    expect(n).toBe(400); // 200 m × 200 m at 10 m cells
  });

  it('respects holes (even–odd rule)', () => {
    const g = flatPlane(1000, 10);
    let n = 0;
    fillArea(g, [square(0, 0, 100), square(0, 0, 50)], () => n++);
    expect(n).toBe(400 - 100);
  });

  it('draws a line with a width', () => {
    const g = flatPlane(1000, 10);
    const seen = new Set<number>();
    drawLine(g, [{ x: -200, y: 0 }, { x: 200, y: 0 }], 10, (i) => seen.add(i));
    // About 40 cells long and 2 cells wide.
    expect(seen.size).toBeGreaterThan(70);
    expect(seen.size).toBeLessThan(140);
  });
});

describe('feature layers', () => {
  const g = flatPlane(2000, 10);
  const fs = set([
    feature({ kind: 'wood', shape: 'area', rings: [square(-500, 500, 200)] }),
    feature({ kind: 'water', shape: 'area', rings: [square(500, 500, 100)] }),
    feature({ kind: 'military', shape: 'area', rings: [square(500, -500, 150)] }),
    feature({ kind: 'river', shape: 'line', rings: [[{ x: -1000, y: 0 }, { x: 1000, y: 0 }]] }),
    feature({ kind: 'minor-road', shape: 'line', rings: [[{ x: 0, y: -1000 }, { x: 0, y: 1000 }]], publicAccess: true, bridge: true }),
    feature({ kind: 'path', shape: 'line', rings: [[{ x: -800, y: -300 }, { x: -200, y: -300 }]], publicAccess: true }),
    feature({ kind: 'path', shape: 'line', rings: [[{ x: -800, y: -600 }, { x: -200, y: -600 }]], publicAccess: false }),
  ]);
  const L = buildLayers(g, fs);

  it('records land cover', () => {
    expect(L.cover[at(g, { x: -500, y: 500 })]).toBe(COVER.wood);
    expect(L.cover[at(g, { x: 500, y: 500 })]).toBe(COVER.water);
    expect(L.cover[at(g, { x: 0, y: -800 })]).toBe(COVER.open);
  });

  it('makes woods slow, water and rivers impassable, roads fast', () => {
    expect(L.going[at(g, { x: -500, y: 500 })]).toBeGreaterThan(3);
    expect(L.going[at(g, { x: 500, y: 500 })]).toBe(Infinity);
    expect(L.going[at(g, { x: -600, y: 0 })]).toBe(Infinity);
    expect(L.going[at(g, { x: 0, y: -700 })]).toBeLessThan(1);
    expect(L.route[at(g, { x: 0, y: -700 })]).toBe(ROUTE.minorRoad);
  });

  it('lets the road cross the river at the bridge', () => {
    const i = at(g, { x: 0, y: 0 });
    expect(L.crossing[i]).toBe(1);
    expect(L.going[i]).toBeLessThan(1);
  });

  it('allows stands only on public paths and roads, never in excluded areas', () => {
    expect(L.standOk[at(g, { x: -500, y: -300 })]).toBe(1);
    expect(L.standOk[at(g, { x: -500, y: -600 })]).toBe(0); // private path
    expect(L.standOk[at(g, { x: -500, y: -450 })]).toBe(0); // open field
    expect(L.excluded[at(g, { x: 500, y: -500 })]).toBe(1); // military
    expect(L.excluded[at(g, { x: 0, y: 0 })]).toBe(1); // river margin
    expect(L.standOk[at(g, { x: 0, y: 0 })]).toBe(0);
  });

  it('makes steep ground impassable to vehicles', () => {
    const steep = straightRidge(2000, 10, { heightM: 400, halfWidthM: 500 });
    const Ls = buildLayers(steep, set([]));
    expect(Ls.going[at(steep, { x: 0, y: 250 })]).toBe(Infinity);
  });
});

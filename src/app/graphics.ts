/**
 * Tactical graphics for the situation map, as GeoJSON: axes of advance
 * (effects arrows), the objective, the task graphics (secure, neutralise,
 * fix, screen) and minefield outlines. Shapes follow the APP-6 control
 * measures and mission-task graphics in simplified form.
 *
 * Built in local metres and converted to longitude/latitude.
 */
import { localToLatLon } from '../terrain/elevation';
import type { Point } from '../terrain/grid';

type LL = { lat: number; lon: number };
type Feature = { type: 'Feature'; properties: Record<string, unknown>; geometry: object };

const toLL = (c: LL, p: Point): [number, number] => {
  const q = localToLatLon(c, p.x, p.y);
  return [q.lon, q.lat];
};
const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const unit = (a: Point, b: Point): Point => {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
};
const perp = (d: Point): Point => ({ x: d.y, y: -d.x });

function line(c: LL, pts: Point[], props: Record<string, unknown>): Feature {
  return { type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: pts.map((p) => toLL(c, p)) } };
}
function polygon(c: LL, pts: Point[], props: Record<string, unknown>): Feature {
  const ring = [...pts, pts[0]].map((p) => toLL(c, p));
  return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
}
function label(c: LL, p: Point, text: string, props: Record<string, unknown>): Feature {
  return { type: 'Feature', properties: { ...props, kind: 'label', text }, geometry: { type: 'Point', coordinates: toLL(c, p) } };
}

/** APP-6 axis of advance: a broad open arrow from `from` to `to`. */
export function axisArrow(c: LL, from: Point, to: Point, side: 'friend' | 'hostile', text: string): Feature[] {
  const d = unit(from, to);
  const n = perp(d);
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const shaft = 35, head = 80, headLen = Math.min(120, len / 3);
  const neck = add(to, d, -headLen);
  const pts = [
    add(from, n, shaft), add(neck, n, shaft), add(neck, n, head), to, add(neck, n, -head), add(neck, n, -shaft), add(from, n, -shaft),
  ];
  return [
    line(c, [...pts, pts[0]], { kind: 'axis', side }),
    label(c, add(add(from, d, len / 2), n, 0), text, { side }),
  ];
}

/** Objective: a rounded outline labelled OBJ (or its name). */
export function objective(c: LL, p: Point, r = 150, name = 'OBJ'): Feature[] {
  const ring: Point[] = [];
  for (let k = 0; k < 36; k++) ring.push({ x: p.x + r * Math.cos((k * Math.PI) / 18), y: p.y + r * Math.sin((k * Math.PI) / 18) });
  return [line(c, [...ring, ring[0]], { kind: 'obj', side: 'friend' }), label(c, add(p, { x: 0, y: r + 40 }), name, { side: 'friend' })];
}

/**
 * Friendly control lines (APP-6): a boundary (solid line with the echelon
 * mark, "I" for company, in the middle and the unit on each side) or a
 * phase line / start line (labelled at both ends).
 */
export function controlLine(c: LL, kind: 'boundary' | 'phaseLine', path: Point[], text: string, sides?: [string, string]): Feature[] {
  const a = path[0], b = path[path.length - 1];
  const d = unit(a, b), n = perp(d);
  const out: Feature[] = [line(c, path, { kind, side: 'friend' })];
  if (kind === 'boundary') {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    out.push(label(c, mid, text, { side: 'friend', big: true }));
    // perp(d) points to the right of the line's direction (which runs forward); sides = [left, right].
    if (sides) {
      out.push(label(c, add(mid, n, -90), sides[0], { side: 'friend' }));
      out.push(label(c, add(mid, n, 90), sides[1], { side: 'friend' }));
    }
  } else {
    out.push(label(c, add(a, d, 120), text, { side: 'friend' }), label(c, add(b, d, -120), text, { side: 'friend' }));
  }
  return out;
}

/** Secure: an arrow curving round the objective, labelled S. */
function secure(c: LL, p: Point, r = 220): Feature[] {
  const arc: Point[] = [];
  for (let a = 200; a >= -60; a -= 10) arc.push({ x: p.x + r * Math.cos((a * Math.PI) / 180), y: p.y + r * Math.sin((a * Math.PI) / 180) });
  const end = arc[arc.length - 1], prev = arc[arc.length - 2];
  const d = unit(prev, end), n = perp(d);
  return [
    line(c, arc, { kind: 'task', side: 'friend' }),
    line(c, [add(add(end, d, -40), n, 25), end, add(add(end, d, -40), n, -25)], { kind: 'task', side: 'friend' }),
    label(c, { x: p.x - r - 40, y: p.y }, 'S', { side: 'friend', big: true }),
  ];
}

/** Neutralise: a cross through the target, labelled N. */
function neutralise(c: LL, p: Point, r = 200): Feature[] {
  return [
    line(c, [{ x: p.x - r, y: p.y - r }, { x: p.x + r, y: p.y + r }], { kind: 'task', side: 'friend' }),
    line(c, [{ x: p.x - r, y: p.y + r }, { x: p.x + r, y: p.y - r }], { kind: 'task', side: 'friend' }),
    label(c, { x: p.x, y: p.y + r + 50 }, 'N', { side: 'friend', big: true }),
  ];
}

/** Fix: a zig-zag arrow towards the target, labelled F. */
function fix(c: LL, from: Point, to: Point): Feature[] {
  const d = unit(from, to), n = perp(d);
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const pts: Point[] = [from];
  const steps = 6;
  for (let k = 1; k < steps; k++) pts.push(add(add(from, d, (len * k) / steps), n, k % 2 ? 40 : -40));
  pts.push(to);
  return [
    line(c, pts, { kind: 'task', side: 'friend' }),
    line(c, [add(add(to, d, -50), n, 30), to, add(add(to, d, -50), n, -30)], { kind: 'task', side: 'friend' }),
    label(c, add(add(from, d, len / 2), n, 90), 'F', { side: 'friend', big: true }),
  ];
}

/** Screen: a line along the flank with open arrowheads at each end, labelled S. */
function screen(c: LL, p: Point, along: Point): Feature[] {
  const a = add(p, along, -400), b = add(p, along, 400);
  const n = perp(along);
  return [
    line(c, [a, b], { kind: 'task', side: 'friend' }),
    line(c, [add(add(a, along, 50), n, 30), a, add(add(a, along, 50), n, -30)], { kind: 'task', side: 'friend' }),
    line(c, [add(add(b, along, -50), n, 30), b, add(add(b, along, -50), n, -30)], { kind: 'task', side: 'friend' }),
    label(c, add(p, n, 60), 'S', { side: 'friend', big: true }),
  ];
}

export function taskGraphic(
  c: LL,
  t: { kind: 'secure' | 'neutralise' | 'findFix' | 'screen'; objective: Point; from: Point; across: Point },
): Feature[] {
  if (t.kind === 'secure') return [...objective(c, t.objective), ...secure(c, t.objective)];
  if (t.kind === 'neutralise') return neutralise(c, t.objective);
  if (t.kind === 'findFix') return fix(c, t.from, t.objective);
  // Screen runs along the line of advance, i.e. perpendicular to "across".
  return screen(c, t.objective, perp(t.across));
}

export type MineType = 'unspecified' | 'ap' | 'mixed';

/**
 * Minefield in APP-6 form: a closed outline (dashed if planned or suspected,
 * solid if known) with mine symbols inside: open circle = mine of unknown
 * type, filled circle = anti-tank, filled circle with two "whiskers" =
 * anti-personnel. A mixed minefield shows both.
 */
export function minefield(c: LL, outline: Point[], type: MineType, side: 'hostile', dashed: boolean): Feature[] {
  if (outline.length < 3) return [];
  const cx = outline.reduce((a, p) => a + p.x, 0) / outline.length;
  const cy = outline.reduce((a, p) => a + p.y, 0) / outline.length;
  // The mine symbols run along the longest side of the outline.
  let along: Point = { x: 1, y: 0 }, longest = 0;
  for (let k = 0; k < outline.length; k++) {
    const a = outline[k], b = outline[(k + 1) % outline.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > longest) { longest = len; along = unit(a, b); }
  }
  const centre = { x: cx, y: cy };
  const icon = (k: number): string =>
    type === 'unspecified' ? 'mine-unk' : type === 'ap' ? 'mine-ap' : k % 2 ? 'mine-ap' : 'mine-at';
  const spots = longest < 200 ? [0] : [-1, 0, 1];
  const step = longest * 0.28;
  const mines: Feature[] = spots.map((k, n) => ({
    type: 'Feature',
    properties: { kind: 'mine', side, icon: icon(n) },
    geometry: { type: 'Point', coordinates: toLL(c, add(centre, along, k * step)) },
  }));
  return [polygon(c, outline, { kind: 'minefield', side, dashed }), ...mines];
}

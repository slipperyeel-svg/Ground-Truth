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

/** Objective: a rounded outline labelled OBJ. */
export function objective(c: LL, p: Point, r = 150): Feature[] {
  const ring: Point[] = [];
  for (let k = 0; k < 36; k++) ring.push({ x: p.x + r * Math.cos((k * Math.PI) / 18), y: p.y + r * Math.sin((k * Math.PI) / 18) });
  return [line(c, [...ring, ring[0]], { kind: 'obj', side: 'friend' }), label(c, add(p, { x: 0, y: r + 40 }), 'OBJ', { side: 'friend' })];
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

/** Minefield outline (APP-6: a closed outline with "M"). */
export function minefield(c: LL, outline: Point[], text: string, side: 'hostile', dashed: boolean): Feature[] {
  if (outline.length < 3) return [];
  const cx = outline.reduce((a, p) => a + p.x, 0) / outline.length;
  const cy = outline.reduce((a, p) => a + p.y, 0) / outline.length;
  return [polygon(c, outline, { kind: 'minefield', side, dashed }), label(c, { x: cx, y: cy }, `M  ${text}`, { side })];
}

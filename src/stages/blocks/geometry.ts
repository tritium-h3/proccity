// Plan geometry for dividing a superblock: its oriented box, chords across it, and splitting a
// piece in two by a road band. Pure; polygons go through grammar/clipper.ts.

import type { MultiPolygon, Point2, Polygon } from '../../doc/types.js';
import { difference, intersect, offsetPolyline, union } from '../../grammar/clipper.js';
import { area } from '../../grammar/polygon.js';

export interface Box { centre: Point2; /** radians, along the long side */ axis: number; long: number; short: number }

function hull(points: Point2[]): Point2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Point2, a: Point2, b: Point2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point2[] = [], upper: Point2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The minimum-area rectangle around the piece (one of its sides lies along a hull edge). */
export function obb(mp: MultiPolygon): Box {
  const h = hull(mp.flatMap(poly => poly[0]));
  let best: Box & { a: number } = { centre: h[0] ?? [0, 0], axis: 0, long: 0, short: 0, a: Infinity };
  for (let i = 0; i < h.length; i++) {
    const [ax, az] = h[i], [bx, bz] = h[(i + 1) % h.length];
    const ang = Math.atan2(bz - az, bx - ax), c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, z] of h) {
      const u = x * c + z * s, v = -x * s + z * c;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const a = (u1 - u0) * (v1 - v0);
    if (a < best.a - 1e-9) {
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      const centre: Point2 = [uc * c - vc * s, uc * s + vc * c];
      best = u1 - u0 >= v1 - v0
        ? { centre, axis: ang, long: u1 - u0, short: v1 - v0, a }
        : { centre, axis: ang + Math.PI / 2, long: v1 - v0, short: u1 - u0, a };
    }
  }
  return { centre: best.centre, axis: best.axis, long: best.long, short: best.short };
}

/** 2 × area / perimeter: the width of a strip with this area and outline. */
export function thickness(mp: MultiPolygon): number {
  let per = 0;
  for (const poly of mp) for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) per += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  return per > 0 ? (2 * area(mp)) / per : 0;
}

/** The straight chord through `origin` along `dir` (unit), from boundary to boundary of the
 *  piece; null if the origin is outside it. */
export function chordThrough(mp: MultiPolygon, origin: Point2, dir: Point2): [Point2, Point2] | null {
  const [ox, oz] = origin, [dx, dz] = dir;
  const ts: number[] = [];
  for (const poly of mp) for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    // v: signed distance across the line; u: along it.
    const va = -(a[0] - ox) * dz + (a[1] - oz) * dx, vb = -(b[0] - ox) * dz + (b[1] - oz) * dx;
    if ((va > 0) === (vb > 0)) continue;
    const t = va / (va - vb);
    const ua = (a[0] - ox) * dx + (a[1] - oz) * dz, ub = (b[0] - ox) * dx + (b[1] - oz) * dz;
    ts.push(ua + (ub - ua) * t);
  }
  ts.sort((a, b) => a - b);
  // Even-odd along the line: the origin is inside when an odd number of crossings lie before it.
  const k = ts.findIndex(t => t > 0);
  if (k <= 0 || k % 2 === 0) return null;
  return [[ox + dx * ts[k - 1], oz + dz * ts[k - 1]], [ox + dx * ts[k], oz + dz * ts[k]]];
}

/** Distance from p to the polyline and the side it's on (+1 left of the direction of travel). */
export function sideOf(line: Point2[], p: Point2): { d: number; side: number } {
  let best = { d: Infinity, side: 0 };
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L2)) : 0;
    const d = Math.hypot(ax + dx * t - p[0], az + dz * t - p[1]);
    if (d < best.d) best = { d, side: Math.sign(dx * (p[1] - az) - dz * (p[0] - ax)) };
  }
  return best;
}

/** Extend a polyline's ends by `by` metres along their own directions. */
export function extend(line: Point2[], by: number): Point2[] {
  if (line.length < 2) return line;
  const out = line.slice();
  const push = (p: Point2, q: Point2): Point2 => {
    const L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
    return [p[0] + ((p[0] - q[0]) / L) * by, p[1] + ((p[1] - q[1]) / L) * by];
  };
  out[0] = push(line[0], line[1]);
  out[out.length - 1] = push(line[line.length - 1], line[line.length - 2]);
  return out;
}

const FRAGMENT = 1; // m²: Clipper leaves crumbs where a band's end meets the boundary at a slant

/** Cut `piece` by a road of `width` along `line` (boundary to boundary). Returns the road strip
 *  and the two sides, or null unless the road divides the piece into exactly two parts. The band
 *  overshoots the ends so its square ends can't leave a neck joining the sides. */
export function splitBy(piece: MultiPolygon, line: Point2[], width: number): [MultiPolygon, MultiPolygon, MultiPolygon] | null {
  if (line.length < 2) return null;
  const band = offsetPolyline(extend(line, width), width / 2, 'butt');
  let strip = intersect(piece, band);
  const rest = difference(piece, band);
  const sides: Polygon[][] = [[], []];
  const crumbs: Polygon[] = [];
  for (const poly of rest) {
    if (area([poly]) < FRAGMENT) { crumbs.push(poly); continue; }
    // The polygon's farthest vertex from the road is safely on its side (a centroid may not be).
    let far = { d: -1, side: 0 };
    for (const p of poly[0]) { const s = sideOf(line, p); if (s.d > far.d) far = s; }
    sides[far.side > 0 ? 0 : 1].push(poly);
  }
  if (sides[0].length !== 1 || sides[1].length !== 1) return null;
  if (crumbs.length) strip = union(strip, crumbs);
  return [strip, sides[0], sides[1]];
}

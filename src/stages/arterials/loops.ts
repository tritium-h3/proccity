// Loops in the arterial network, and road pieces between junctions. The owner wants loops only
// through several districts (2026-11-24: at least 3), so loops taking in fewer are opened by
// removing one piece of road along their edge (stage.ts decides which).

import type { MultiPolygon, Point2, Ring } from '../../doc/types.js';
import { intersect, offsetPolygons, offsetPolyline, union } from '../../grammar/clipper.js';
import { area, bounds, signedArea } from '../../grammar/polygon.js';

/** The holes in the union of the roads' bands: the network's enclosed loops, each as an outer ring. */
export function loopsOf(roads: Point2[][], roadWidth: number): Ring[] {
  const all = union(roads.filter(r => r.length >= 2).flatMap(r => offsetPolyline(r, roadWidth / 2, 'round')), []);
  return all.flatMap(poly => poly.slice(1)).map(h => (signedArea(h) < 0 ? [...h].reverse() : h));
}

/**
 * The districts a loop takes in: those with a usable piece inside it, i.e. something left after
 * an inward offset of half the Usable width. Roads may stray a Usable width outside their
 * district, and the strip a loop gains that way doesn't count.
 */
export function districtsIn(loop: Ring, districts: MultiPolygon[], usableWidth: number): number[] {
  const lb = bounds([[loop]]);
  const out: number[] = [];
  districts.forEach((fp, i) => {
    const b = bounds(fp);
    if (b.minX > lb.maxX || b.maxX < lb.minX || b.minZ > lb.maxZ || b.maxZ < lb.minZ) return;
    const inside = intersect(fp, [[loop]]);
    if (area(inside) > 0 && area(offsetPolygons(inside, -usableWidth / 2)) > 0) out.push(i);
  });
  return out;
}

const cum = (line: Point2[]) => {
  const c = [0];
  for (let i = 1; i < line.length; i++) c.push(c[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  return c;
};

/** Where segment p→q crosses r→s, as the fraction along p→q (null when they don't). */
function crossAt(p: Point2, q: Point2, r: Point2, s: Point2): number | null {
  const dx = q[0] - p[0], dz = q[1] - p[1], ex = s[0] - r[0], ez = s[1] - r[1];
  const den = dx * ez - dz * ex;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((r[0] - p[0]) * ez - (r[1] - p[1]) * ex) / den;
  const u = ((r[0] - p[0]) * dz - (r[1] - p[1]) * dx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Position (m along the line) of the point on it nearest p, and how far p is from it. */
export function project(line: Point2[], p: Point2): { at: number; d: number } {
  const c = cum(line);
  let best = { at: 0, d: Infinity };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0;
    const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
    if (d < best.d) best = { at: c[i] + t * (c[i + 1] - c[i]), d };
  }
  return best;
}

/**
 * Junctions along a road (m from its start, sorted, the ends excluded): where another road
 * crosses it or ends on it (within `tol`), and where it crosses itself.
 */
export function junctions(road: Point2[], others: Point2[][], tol: number): number[] {
  const c = cum(road), L = c[c.length - 1];
  const at: number[] = [];
  for (const o of others) {
    for (let i = 0; i + 1 < road.length; i++) for (let j = 0; j + 1 < o.length; j++) {
      const t = crossAt(road[i], road[i + 1], o[j], o[j + 1]);
      if (t !== null) at.push(c[i] + t * (c[i + 1] - c[i]));
    }
    for (const e of [o[0], o[o.length - 1]]) { const pr = project(road, e); if (pr.d <= tol) at.push(pr.at); }
  }
  for (let i = 0; i + 1 < road.length; i++) for (let j = i + 2; j + 1 < road.length; j++) {
    const t = crossAt(road[i], road[i + 1], road[j], road[j + 1]);
    if (t === null) continue;
    const u = crossAt(road[j], road[j + 1], road[i], road[i + 1])!;
    at.push(c[i] + t * (c[i + 1] - c[i]), c[j] + u * (c[j + 1] - c[j]));
  }
  const sorted = at.filter(x => x > tol && x < L - tol).sort((a, b) => a - b);
  return sorted.filter((x, i) => i === 0 || x - sorted[i - 1] > tol);
}

/** The point `s` metres along a line. */
export function pointAt(line: Point2[], s: number): Point2 {
  const c = cum(line);
  let i = 1;
  while (i < c.length - 1 && c[i] < s) i++;
  const seg = c[i] - c[i - 1], t = seg > 0 ? Math.max(0, Math.min(1, (s - c[i - 1]) / seg)) : 0;
  return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
}

/** The stretch of line from `from` to `to` metres along it. */
export function slice(line: Point2[], from: number, to: number): Point2[] {
  const c = cum(line);
  const out: Point2[] = [pointAt(line, from)];
  for (let i = 0; i < line.length; i++) if (c[i] > from && c[i] < to) out.push(line[i]);
  out.push(pointAt(line, to));
  return out;
}

/** The road without its stretch from `from` to `to` metres: the parts left (zero, one or two). */
export function cutPiece(road: Point2[], from: number, to: number): Point2[][] {
  const L = cum(road)[road.length - 1];
  const parts: Point2[][] = [];
  if (from > 1e-6) parts.push(slice(road, 0, from));
  if (to < L - 1e-6) parts.push(slice(road, to, L));
  return parts;
}

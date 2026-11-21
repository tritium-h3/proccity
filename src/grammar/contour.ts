// Contours and line smoothing.
//
// marchingSquares traces where a grid field crosses `level` into polygons. Each grid cell
// contributes the part of itself above the level (corners above, plus edge crossings by
// linear interpolation); fully-inside cells are merged into row runs; everything is then
// unioned in one Clipper pass, which guarantees valid nesting (holes, islands) for free.
// Values outside the grid count as 0, so shapes touching the edge still close.

import type { MultiPolygon, Point2, Ring } from '../doc/types.js';
import { union } from './clipper.js';

export function marchingSquares(
  mask: Float32Array, cols: number, rows: number, level: number, origin: Point2, cell: number,
): MultiPolygon {
  const v = (i: number, j: number) => (i < 0 || j < 0 || i >= cols || j >= rows ? 0 : mask[j * cols + i]);
  const pt = (i: number, j: number): Point2 => [origin[0] + i * cell, origin[1] + j * cell];
  const pieces: MultiPolygon = [];

  for (let j = -1; j < rows; j++) {
    let runStart = -2; // start column of a run of fully-inside cells, or -2
    const flush = (end: number) => {
      if (runStart > -2) {
        const [x0, z0] = pt(runStart, j), [x1, z1] = pt(end, j + 1);
        pieces.push([[[x0, z0], [x1, z0], [x1, z1], [x0, z1]]]);
        runStart = -2;
      }
    };
    for (let i = -1; i < cols; i++) {
      // Corners in outer-ring order: (i,j) (i+1,j) (i+1,j+1) (i,j+1)
      const c: [number, number, number][] = [[i, j, v(i, j)], [i + 1, j, v(i + 1, j)], [i + 1, j + 1, v(i + 1, j + 1)], [i, j + 1, v(i, j + 1)]];
      const inside = c.map(k => k[2] >= level);
      if (inside.every(Boolean)) { if (runStart === -2) runStart = i; continue; }
      flush(i);
      if (!inside.some(Boolean)) continue;
      const ring: Ring = [];
      for (let k = 0; k < 4; k++) {
        const a = c[k], b = c[(k + 1) % 4];
        const ia = inside[k], ib = inside[(k + 1) % 4];
        if (ia) ring.push(pt(a[0], a[1]));
        if (ia !== ib) {
          const t = (level - a[2]) / (b[2] - a[2]);
          const [ax, az] = pt(a[0], a[1]), [bx, bz] = pt(b[0], b[1]);
          ring.push([ax + (bx - ax) * t, az + (bz - az) * t]);
        }
      }
      if (ring.length >= 3) pieces.push([ring]);
    }
    flush(cols);
  }
  return pieces.length ? union(pieces, []) : [];
}

function perpDistance(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - dz * (a[0] - p[0])) / len;
}

function dp(points: Point2[], tol: number): Point2[] {
  if (points.length < 3) return points;
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistance(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tol) return [points[0], points[points.length - 1]];
  return [...dp(points.slice(0, idx + 1), tol).slice(0, -1), ...dp(points.slice(idx), tol)];
}

/** Douglas–Peucker on a closed ring (first point not repeated). */
export function simplify(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 4) return ring;
  // Anchor on the point farthest from ring[0], so both halves are open polylines.
  let far = 0, farD = -1;
  ring.forEach((p, i) => { const d = Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]); if (d > farD) { farD = d; far = i; } });
  const a = dp(ring.slice(0, far + 1), tolerance);
  const b = dp([...ring.slice(far), ring[0]], tolerance);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

/** Chaikin corner cutting on an open polyline; endpoints are kept. */
export function chaikin(line: Point2[], passes: number): Point2[] {
  let pts = line;
  for (let p = 0; p < passes; p++) {
    if (pts.length < 3) return pts;
    const next: Point2[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      next.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25], [ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

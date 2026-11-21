// Line smoothing.

import type { Point2 } from '../doc/types.js';

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

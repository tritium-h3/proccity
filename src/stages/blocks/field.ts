// Which way a cut should run at a point. Lines have no direction, so angles are taken mod π.
// Dense districts keep the planned direction (a grid off the superblock's long side) and turn
// towards the contours only as far as the local Max grade needs. Sparse ones swing to whichever
// contour family (along the contour, or straight up it) is nearer the plan, more so the steeper the
// ground, and then keep under the grade as well.

import type { Point2 } from '../../doc/types.js';
import type { HeightRaster } from './height.js';
import type { Family } from './rules.js';

export type Field = (p: Point2, planned: number) => number;

/** The undirected difference between two line angles, in (-π/2, π/2]. */
export function lineDiff(a: number, b: number): number {
  let d = (a - b) % Math.PI;
  if (d > Math.PI / 2) d -= Math.PI;
  if (d <= -Math.PI / 2) d += Math.PI;
  return d;
}

// Slope at which sparse districts follow the terrain fully (they start at 1%).
const SPARSE_FULL = 0.04;

export function makeField(h: HeightRaster, family: Family, maxGrade: number): Field {
  return (p, planned) => {
    const [gx, gz] = h.slope(p[0], p[1]);
    const s = Math.hypot(gx, gz);
    if (s < 1e-4) return planned;
    const contour = Math.atan2(gz, gx) + Math.PI / 2;
    let a = planned;
    if (family === 'sparse') {
      // The nearer of the two contour families: along the contour, or square to it.
      const d = lineDiff(planned, contour);
      const target = Math.abs(d) <= Math.PI / 4 ? contour : contour + Math.PI / 2;
      const w = Math.min(1, Math.max(0, (s - 0.01) / (SPARSE_FULL - 0.01)));
      a = planned - lineDiff(planned, target) * w;
    }
    // Grade along a line at angle θ from the contour is s·|sin θ|: keep it under the Max grade.
    const limit = s <= maxGrade ? Math.PI / 2 : Math.asin(maxGrade / s);
    const off = lineDiff(a, contour);
    if (Math.abs(off) > limit) a = contour + Math.sign(off) * limit;
    return a;
  };
}

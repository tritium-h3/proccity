// Queries on regions' triangulated ground surfaces (terrain v2).

import { containsPoint } from '../grammar/polygon.js';
import type { GroundSurface, RegionNode } from './types.js';

export function triangleArea(g: GroundSurface): number {
  let a = 0;
  for (const [i, j, k] of g.triangles) {
    const [ax, az] = g.points[i], [bx, bz] = g.points[j], [cx, cz] = g.points[k];
    a += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
  }
  return a;
}

/** Elevation at (x, z) by barycentric interpolation; null outside every triangle. */
export function heightOnSurface(g: GroundSurface, x: number, z: number): number | null {
  for (const [i, j, k] of g.triangles) {
    const [ax, az, ay] = g.points[i], [bx, bz, by] = g.points[j], [cx, cz, cy] = g.points[k];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (d === 0) continue;
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const w = 1 - u - v;
    const eps = -1e-7;
    if (u >= eps && v >= eps && w >= eps) return u * ay + v * by + w * cy;
  }
  return null;
}

const WATER = new Set(['sea', 'river', 'pond']);

/** Ground elevation at a point: the terrain region containing it (water first), interpolated
 *  on its surface; 0 where there's no ground data (no terrain yet, or an old v1 city). */
export function groundHeightAt(tree: RegionNode, x: number, z: number): number {
  const kids = [...tree.children].sort((a, b) => Number(WATER.has(b.kind)) - Number(WATER.has(a.kind)));
  for (const c of kids) {
    const g = c.data?.ground;
    if (!g || !containsPoint(c.geometry.footprint, [x, z])) continue;
    const h = heightOnSurface(g, x, z);
    if (h !== null) return h;
  }
  return 0;
}

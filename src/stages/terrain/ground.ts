// A region's own triangulated ground: constrained Delaunay over its boundary vertices plus
// interior points (cell centres, cell corners inside the region, river course points), so
// interior shape (summits, river and pond beds) is real geometry, and boundaries are edges.

import Delaunator from 'delaunator';
import Constrainautor from '@kninnug/constrainautor';
import earcut from 'earcut';
import type { GroundSurface, MultiPolygon, Point2 } from '../../doc/types.js';
import { containsPoint } from '../../grammar/polygon.js';
import { vkey } from './cells.js';

export function constrainedSurface(
  footprint: MultiPolygon, elevationOf: (p: Point2) => number, interior: [number, number, number][],
): GroundSurface {
  const points: [number, number, number][] = [];
  const index = new Map<string, number>();
  const add = (x: number, z: number, y: number) => {
    const k = vkey([x, z]);
    const found = index.get(k);
    if (found !== undefined) return found;
    index.set(k, points.length);
    points.push([x, z, y]);
    return points.length - 1;
  };
  const edges: [number, number][] = [];
  for (const poly of footprint) for (const ring of poly) {
    const ids = ring.map(p => add(p[0], p[1], elevationOf(p)));
    for (let i = 0; i < ids.length; i++) {
      const a = ids[i], b = ids[(i + 1) % ids.length];
      if (a !== b) edges.push([a, b]);
    }
  }
  const boundaryCount = points.length;
  // Interior points must sit well inside. One on a boundary edge makes the constrainer reject
  // the edge (losing all interior detail); one just inside it, at a different height, makes a
  // near-vertical sliver (e.g. a river-bed point 0.8 m from the bank).
  const MIN_INSET = 1.5;
  for (const [x, z, y] of interior) {
    if (index.has(vkey([x, z]))) continue;
    if (containsPoint(footprint, [x, z]) && distanceToBoundary(footprint, [x, z]) > MIN_INSET) add(x, z, y);
  }

  const keep = (tri: number[]): boolean => {
    const cx = (points[tri[0]][0] + points[tri[1]][0] + points[tri[2]][0]) / 3;
    const cz = (points[tri[0]][1] + points[tri[1]][1] + points[tri[2]][1]) / 3;
    return containsPoint(footprint, [cx, cz]);
  };

  try {
    const del = new Delaunator(points.flatMap(p => [p[0], p[1]]));
    new Constrainautor(del, edges);
    const triangles: [number, number, number][] = [];
    for (let t = 0; t < del.triangles.length; t += 3) {
      const tri: [number, number, number] = [del.triangles[t], del.triangles[t + 1], del.triangles[t + 2]];
      if (keep(tri)) triangles.push(tri);
    }
    return { points, triangles };
  } catch {
    // Rare shapes the constrainer rejects (e.g. a self-touching boundary): ear-clip the
    // footprint without interior points, so the region still gets a surface.
    const triangles: [number, number, number][] = [];
    for (const poly of footprint) {
      const flat: number[] = [], holes: number[] = [], ids: number[] = [];
      poly.forEach((ring, r) => {
        if (r > 0) holes.push(flat.length / 2);
        for (const p of ring) { flat.push(p[0], p[1]); ids.push(index.get(vkey(p))!); }
      });
      const tri = earcut(flat, holes);
      for (let t = 0; t < tri.length; t += 3) triangles.push([ids[tri[t]], ids[tri[t + 1]], ids[tri[t + 2]]]);
    }
    return { points: points.slice(0, boundaryCount), triangles };
  }
}

function distanceToBoundary(mp: MultiPolygon, p: Point2): number {
  let best = Infinity;
  for (const poly of mp) for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(p[0] - (ax + dx * t), p[1] - (az + dz * t)));
    }
  }
  return best;
}

import type { MultiPolygon, Point2, Ring } from '../doc/types.js';

/** Shoelace area; positive = outer-ring orientation (CCW in x,z). */
export function signedArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  }
  return s / 2;
}

/** Total area with holes subtracted; never negative. */
export function area(mp: MultiPolygon): number {
  let total = 0;
  for (const [outer, ...holes] of mp) {
    if (!outer) continue;
    total += Math.abs(signedArea(outer));
    for (const h of holes) total -= Math.abs(signedArea(h));
  }
  return Math.max(0, total);
}

function onSegment(p: Point2, a: Point2, b: Point2): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > 1e-9 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))) return false;
  return p[0] >= Math.min(a[0], b[0]) - 1e-9 && p[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9;
}

/** 'boundary' | 'inside' | 'outside' for a single ring. */
function ringSide(ring: Ring, p: Point2): 'boundary' | 'inside' | 'outside' {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(p, a, b)) return 'boundary';
    if ((b[1] > p[1]) !== (a[1] > p[1]) && p[0] < ((a[0] - b[0]) * (p[1] - b[1])) / (a[1] - b[1]) + b[0]) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

/** True if `p` lies in the footprint; boundaries count as inside. */
export function containsPoint(mp: MultiPolygon, p: Point2): boolean {
  for (const [outer, ...holes] of mp) {
    if (!outer || ringSide(outer, p) === 'outside') continue;
    if (holes.every(h => ringSide(h, p) !== 'inside')) return true;
  }
  return false;
}

export function bounds(mp: MultiPolygon): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const poly of mp) for (const ring of poly) for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

/** Axis-aligned rectangle, outer ring CCW. */
export function rect(minX: number, minZ: number, maxX: number, maxZ: number): MultiPolygon {
  return [[[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]]]];
}

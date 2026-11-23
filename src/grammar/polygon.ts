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

/** Douglas–Peucker: the fewest points of `line` (ends kept) such that every dropped point
 *  lies within `tolerance` metres of the simplified line. */
export function simplifyLine(line: Point2[], tolerance: number): Point2[] {
  if (line.length <= 2) return line.slice();
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const [ax, az] = line[i], [bx, bz] = line[j];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    let worst = -1, wd = tolerance;
    for (let k = i + 1; k < j; k++) {
      const [px, pz] = line[k];
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
      const d = Math.hypot(ax + dx * t - px, az + dz * t - pz);
      if (d > wd) { wd = d; worst = k; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([i, worst], [worst, j]); }
  }
  return line.filter((_, k) => keep[k]);
}

/** Area-weighted centroid of a footprint (holes subtract). */
export function centroid(mp: MultiPolygon): Point2 {
  let a = 0, cx = 0, cz = 0;
  for (const poly of mp) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cz += (ring[j][1] + ring[i][1]) * f;
    }
  }
  if (Math.abs(a) < 1e-12) { const p = mp[0]?.[0]?.[0]; return p ? [p[0], p[1]] : [0, 0]; }
  return [cx / (3 * a), cz / (3 * a)];
}

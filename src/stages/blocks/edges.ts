// A superblock's outline, sorted by what lies beyond it: an arterial, another developed district
// (where a shared border street goes), or nothing a road may end on (water, the site edge,
// Undeveloped land). Arterials leave about half of a superblock's outline on district borders, so
// without border streets most cuts would end in open land.

import type { MultiPolygon, Point2 } from '../../doc/types.js';

export type EdgeKind = 'A' | 'border' | 'none';
export interface Run { points: Point2[]; kind: EdgeKind }

/** Each ring of the footprint as runs of like edges, classified at each edge's midpoint. */
export function classifyBoundary(sb: MultiPolygon, kindAt: (mid: Point2, outward: Point2) => EdgeKind): Run[][] {
  const out: Run[][] = [];
  for (const poly of sb) for (const ring of poly) {
    const n = ring.length;
    const kinds: EdgeKind[] = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      // Rings keep the interior on their left (outer CCW, holes CW), so outward is to the right.
      kinds.push(kindAt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], [(b[1] - a[1]) / L, -(b[0] - a[0]) / L]));
    }
    // Start at a change of kind, so no run wraps round the ring's first vertex.
    const s = kinds.findIndex((k, i) => k !== kinds[(i + n - 1) % n]);
    if (s < 0) { out.push([{ points: [...ring, ring[0]], kind: kinds[0] }]); continue; }
    const runs: Run[] = [];
    for (let j = 0; j < n; j++) {
      const i = (s + j) % n;
      const last = runs[runs.length - 1];
      if (!last || last.kind !== kinds[i]) runs.push({ points: [ring[i], ring[(i + 1) % n]], kind: kinds[i] });
      else last.points.push(ring[(i + 1) % n]);
    }
    out.push(runs);
  }
  return out;
}

/** The border runs a street may follow: those with an arterial at both ends, so the street never
 *  runs out into land with no road. */
export function borderStreets(rings: Run[][]): Point2[][] {
  const out: Point2[][] = [];
  for (const runs of rings) runs.forEach((r, i) => {
    if (r.kind !== 'border' || runs.length < 2) return;
    const prev = runs[(i + runs.length - 1) % runs.length], next = runs[(i + 1) % runs.length];
    if (prev.kind === 'A' && next.kind === 'A') out.push(r.points);
  });
  return out;
}

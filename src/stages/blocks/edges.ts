// A superblock's outline, sorted by what lies beyond it: an arterial, another developed district
// (where a shared border street goes: every block must face a road, so a district border can't be
// left bare), open land (water, Undeveloped land, the site edge: blocks meet it with a rough edge
// and roads may end on it), or none of these.

import type { MultiPolygon, Point2 } from '../../doc/types.js';

export type EdgeKind = 'A' | 'border' | 'open' | 'none';
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

/** The runs of one kind, as polylines. */
export const runsOf = (rings: Run[][], kind: EdgeKind): Point2[][] => rings.flat().filter(r => r.kind === kind).map(r => r.points);

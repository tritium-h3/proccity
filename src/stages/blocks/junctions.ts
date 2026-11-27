// Junction spacing, the principle behind the road hierarchy (the owner, 2026-11-27): the bigger
// the road, the wider the spacing of the junctions along it. Arterials are met rarely, collectors
// about once a block length, local roads may branch freely. A new junction too close to an
// existing one on the same road costs; landing on one (a crossing) costs nothing, which is what
// turns staggered T-junctions (bricks) into crossroads.

import type { Point2 } from '../../doc/types.js';
import type { RoadIndex, RoadLine } from './roads.js';
import type { Category } from './rules.js';

// Metres of score per metre short of the spacing: a near miss is worse than an open end.
const JUNCTION_COST = 2;
const CROSSING = 1; // m beyond the host's half width: still the same junction

export class Junctions {
  private at = new Map<RoadLine, Point2[]>();
  add(road: RoadLine, p: Point2): void {
    const list = this.at.get(road);
    if (list) list.push(p); else this.at.set(road, [p]);
  }
  /** Distance from p to the nearest junction already on this road (Infinity if none). */
  nearest(road: RoadLine, p: Point2): number {
    let d = Infinity;
    for (const q of this.at.get(road) ?? []) d = Math.min(d, Math.hypot(q[0] - p[0], q[1] - p[1]));
    return d;
  }
}

export function minSpacing(category: Category, t: { depth: number; length: number; collectors: number }): number {
  return category === 'A' ? 0.75 * t.collectors : category === 'C' ? 0.75 * t.length : 0.5 * t.depth;
}

/** What a junction at p (a cut's end on a road's edge) costs. */
export function junctionCost(roads: RoadIndex, js: Junctions, p: Point2, t: { depth: number; length: number; collectors: number }): number {
  const host = roads.at(p);
  if (!host) return 0;
  const d = js.nearest(host, p);
  // Across the road from an existing junction: a crossing, not a new junction.
  if (d <= 2 * host.half + CROSSING) return 0;
  const min = minSpacing(host.category, t);
  return d < min ? (min - d) * JUNCTION_COST : 0;
}

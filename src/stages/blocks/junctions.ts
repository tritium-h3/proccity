// Junction spacing, the principle behind the road hierarchy (the owner, 2026-11-27): the bigger
// the road, the wider the spacing of the junctions along it. Arterials are met rarely, collectors
// about once a block length, local roads may branch freely. Measured here (the stats count
// junctions closer than the spacing, by category); not scored. As a score it was tried and dropped
// (2026-11-27): it added 8% more blocks and left arterial junctions as close as before. What does
// the job is structural: streets carry on across roads (crossroads, not bricks), and local roads
// keep off arterials unless a piece can be cut no other way (divide.ts).

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
  on(road: RoadLine): readonly Point2[] { return this.at.get(road) ?? []; }
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

/** The foot of p on a road's centreline, and which side of it p lies (+1 left, −1 right). */
function foot(road: RoadLine, p: Point2): { f: Point2; side: number } {
  let best = Infinity, f: Point2 = p, side = 0;
  for (let i = 0; i + 1 < road.points.length; i++) {
    const a = road.points[i], b = road.points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)) : 0;
    const q: Point2 = [a[0] + dx * t, a[1] + dz * t], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best) { best = d; f = q; side = Math.sign(dx * (p[1] - a[1]) - dz * (p[0] - a[0])); }
  }
  return { f, side };
}

/** Crossroad favouritism (the owner, 2026-11-27, after jogs where two streets met a road close
 *  together): a cut whose end meets a road just short of a street ending on the far side, within
 *  `maxD`, is moved to line up with it. Returns the moved line, or null if no end moves. Only the
 *  far side: moving onto an end on its own side would lay one road on top of another. */
export function snapEnds(line: Point2[], roads: RoadIndex, js: Junctions, maxD: number): Point2[] | null {
  const out = [...line];
  let moved = false;
  for (const i of [0, line.length - 1]) {
    const e = line[i], host = roads.at(e);
    if (!host) continue;
    const mine = foot(host, e);
    let best: Point2 | null = null, bd = Infinity;
    for (const j of js.on(host)) {
      const theirs = foot(host, j);
      if (theirs.side === mine.side || theirs.side === 0) continue;
      // Its mirror on this side of the road: where a street lining up with it would end.
      const m: Point2 = [2 * theirs.f[0] - j[0], 2 * theirs.f[1] - j[1]];
      const d = Math.hypot(m[0] - e[0], m[1] - e[1]);
      if (d < bd) { bd = d; best = m; }
    }
    if (best && bd > CROSSING && bd <= maxD) { out[i] = best; moved = true; }
  }
  return moved ? out : null;
}

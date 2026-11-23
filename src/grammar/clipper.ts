// The one file that talks to the polygon library. Everything else works in
// metres on MultiPolygons; Clipper works on integers, so coordinates are scaled
// by SCALE (millimetre precision) at this boundary, which is what makes it robust.
//
// Library: clipper2-ts. clipper2-js (the spec's first pick) was rejected after
// testing: its PolyTree output always came back empty and insetting a plain
// rectangle produced garbage.

import {
  Clipper, Clipper64, ClipType, EndType, FillRule, JoinType, PolyTree64,
  type Path64, type Paths64, type PolyPath64,
} from 'clipper2-ts';
import type { MultiPolygon, Point2, Ring } from '../doc/types.js';
import { signedArea } from './polygon.js';

export const SCALE = 1000;

function toPath(ring: Ring): Path64 {
  return ring.map(([x, z]) => ({ x: Math.round(x * SCALE), y: Math.round(z * SCALE) }));
}

function toPaths(mp: MultiPolygon): Paths64 {
  const out: Paths64 = [];
  for (const poly of mp) for (const ring of poly) if (ring.length >= 3) out.push(toPath(ring));
  return out;
}


/** PolyTree → MultiPolygon. Rings are classed by their own orientation (Clipper writes outers
 *  positive, holes negative) and each hole goes under the smallest outer containing it. The
 *  tree's depth isn't trusted: with a cut-out whose corners lie exactly on edges that have no
 *  vertices there, clipper2-ts put the hole ring beside its outer, so it came out as an extra
 *  outer and the "difference" grew by what it should have removed (a river's water overlapped
 *  its bridge). */
function fromTree(tree: PolyPath64): MultiPolygon {
  const rings: Ring[] = [];
  const walk = (node: PolyPath64) => {
    if (node.polygon && node.polygon.length >= 3) rings.push(node.polygon.map(p => [p.x / SCALE, p.y / SCALE] as Point2));
    for (let i = 0; i < node.count; i++) walk(node.child(i));
  };
  for (let i = 0; i < tree.count; i++) walk(tree.child(i));
  const outers = rings.filter(r => signedArea(r) > 0).map(r => ({ ring: r, area: signedArea(r), holes: [] as Ring[] }));
  for (const hole of rings.filter(r => signedArea(r) < 0)) {
    // A point surely inside the hole: its centroid works for the simple rings Clipper returns;
    // fall back to a vertex nudged inward.
    const probe = holeProbe(hole);
    const home = outers.filter(o => inRing(o.ring, probe)).sort((x, y) => x.area - y.area)[0];
    if (home) home.holes.push(hole);
  }
  return outers.map(o => [o.ring, ...o.holes]);
}

function inRing(ring: Ring, p: Point2): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j], [bx, bz] = ring[i];
    if ((bz > p[1]) !== (az > p[1]) && p[0] < ((ax - bx) * (p[1] - bz)) / (az - bz) + bx) inside = !inside;
  }
  return inside;
}

function holeProbe(hole: Ring): Point2 {
  // Midpoint of an edge, nudged a hair to its inner side (left of travel for a CW hole is
  // outside, so step right).
  const [a, b] = [hole[0], hole[1]];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const e = 1e-3;
  return [(a[0] + b[0]) / 2 + ((b[1] - a[1]) / len) * e, (a[1] + b[1]) / 2 - ((b[0] - a[0]) / len) * e];
}

function boolean(type: ClipType, a: Paths64, b: Paths64 | null): MultiPolygon {
  // Keep in-line (collinear) vertices: terrain cells insert cut points into neighbouring
  // outlines so shared edges have matching vertices; dropping them would bring back
  // T-junctions (and cracks) in the merged ground mesh.
  const c = new Clipper64();
  c.preserveCollinear = true;
  c.addSubject(a);
  if (b && b.length) c.addClip(b);
  const tree = new PolyTree64();
  c.execute(type, FillRule.NonZero, tree);
  return fromTree(tree);
}

export const union = (a: MultiPolygon, b: MultiPolygon) => boolean(ClipType.Union, toPaths(a), toPaths(b));
export const intersect = (a: MultiPolygon, b: MultiPolygon) => boolean(ClipType.Intersection, toPaths(a), toPaths(b));
export const difference = (a: MultiPolygon, b: MultiPolygon) => boolean(ClipType.Difference, toPaths(a), toPaths(b));

/** Grow (positive) or shrink (negative) polygons by `delta` metres, mitred corners. */
export function offsetPolygons(a: MultiPolygon, delta: number): MultiPolygon {
  const paths = Clipper.inflatePaths(toPaths(a), delta * SCALE, JoinType.Miter, EndType.Polygon);
  return boolean(ClipType.Union, paths, null);
}

/** Widen an open polyline into a band `2 * halfWidth` wide. Ends are square-cut (butt) by
 *  default; roads use round ends, so bands meeting at a junction always overlap and leave no
 *  notch on the outside of the turn. */
export function offsetPolyline(line: Point2[], halfWidth: number, ends: 'butt' | 'round' = 'butt'): MultiPolygon {
  const paths = Clipper.inflatePaths([toPath(line)], halfWidth * SCALE, JoinType.Miter, ends === 'round' ? EndType.Round : EndType.Butt);
  return boolean(ClipType.Union, paths, null);
}

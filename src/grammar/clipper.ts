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
import type { MultiPolygon, Point2, Polygon, Ring } from '../doc/types.js';
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

/** Rings out of Clipper, re-oriented: outers positive (CCW in x,z), holes negative. */
function fromPath(path: Path64, outer: boolean): Ring {
  const ring: Ring = path.map(p => [p.x / SCALE, p.y / SCALE] as Point2);
  if ((signedArea(ring) > 0) !== outer) ring.reverse();
  return ring;
}

/** PolyTree → MultiPolygon: each outer with its holes; islands inside holes recurse. */
function fromTree(tree: PolyPath64): MultiPolygon {
  const out: MultiPolygon = [];
  const visitOuter = (node: PolyPath64) => {
    if (!node.polygon || node.polygon.length < 3) return;
    const poly: Polygon = [fromPath(node.polygon, true)];
    for (let i = 0; i < node.count; i++) {
      const hole = node.child(i);
      if (hole.polygon && hole.polygon.length >= 3) poly.push(fromPath(hole.polygon, false));
      for (let j = 0; j < hole.count; j++) visitOuter(hole.child(j));
    }
    out.push(poly);
  };
  for (let i = 0; i < tree.count; i++) visitOuter(tree.child(i));
  return out;
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

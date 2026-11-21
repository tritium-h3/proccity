// Water layout (terrain v2): the sea and river carve the site first. Land cells are cut from
// what's left (cells.ts). The coast is gentle: raggedness is the shader's job.
//
// Geometry is built in a local frame where the sea lies towards +v (local "south") and
// rotated into world space, so one code path serves all four shores.

import { createNoise2D } from 'simplex-noise';
import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { chaikin } from '../../grammar/contour.js';
import { difference, intersect, offsetPolygons, offsetPolyline, union } from '../../grammar/clipper.js';
import { area, containsPoint, rect } from '../../grammar/polygon.js';

export type Shore = 'none' | 'north' | 'east' | 'south' | 'west';

export interface WaterInput { size: number; rng: () => number; shore: Shore; river: boolean; riverWidth: number }

export interface Water {
  site: MultiPolygon;
  sea: MultiPolygon | null;
  coastline: Point2[] | null;
  /** course runs source → mouth */
  river: { polygon: MultiPolygon; course: Point2[] } | null;
}

const COAST_WIGGLE = 0.15; // gentle: fraction of the v1 maximum
const MEANDER = 0.5;

const COAST_INSET = 0.2;

/** Rotations (no reflections) from the local frame, sea towards +v, into world (x, z). */
const TO_WORLD: Record<Exclude<Shore, 'none'>, (p: Point2) => Point2> = {
  south: ([u, v]) => [u, v],
  north: ([u, v]) => [-u, -v],
  east: ([u, v]) => [v, -u],
  west: ([u, v]) => [-v, u],
};

function midpointDisplace(a: Point2, b: Point2, depth: number, amp: number, rng: () => number, ok: (p: Point2) => boolean): Point2[] {
  if (depth === 0) return [a, b];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const len = Math.hypot(dx, dz) || 1;
  let off = (rng() - 0.5) * 2 * amp * len;
  let mid: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  for (let t = 0; t < 4; t++, off /= 2) {
    const cand: Point2 = [(a[0] + b[0]) / 2 - (dz / len) * off, (a[1] + b[1]) / 2 + (dx / len) * off];
    if (ok(cand)) { mid = cand; break; }
  }
  return [...midpointDisplace(a, mid, depth - 1, amp, rng, ok).slice(0, -1), ...midpointDisplace(mid, b, depth - 1, amp, rng, ok)];
}

function extend(p: Point2, from: Point2, by: number): Point2 {
  const dx = p[0] - from[0], dz = p[1] - from[1];
  const len = Math.hypot(dx, dz) || 1;
  return [p[0] + (dx / len) * by, p[1] + (dz / len) * by];
}

export function layoutWater(i: WaterInput): Water {
  const { size, rng } = i;
  const h = size / 2;
  const site = rect(-h, -h, h, h);
  const noise = createNoise2D(rng);
  const uniform = (lo: number, hi: number) => lo + rng() * (hi - lo);

  // 1. Sea and coastline
  let sea: MultiPolygon | null = null;
  let coastline: Point2[] | null = null;
  let localCoast: Point2[] = [];
  const toWorld = i.shore === 'none' ? (p: Point2) => p : TO_WORLD[i.shore];
  if (i.shore !== 'none') {
    const amp = COAST_WIGGLE * 0.15 * size;
    const v0 = h - COAST_INSET * size;
    for (let u = -h - 50; u <= h + 50; u += 20) {
      const n = noise(u / (size / 2.5), 0.5) * 0.7 + noise(u / (size / 8), 3.7) * 0.3;
      localCoast.push([u, v0 + n * amp]);
    }
    coastline = localCoast.map(toWorld);
    const corners: Point2[] = [[h + 50, h + 100], [-h - 50, h + 100]];
    const ring: Point2[] = [...localCoast, ...corners].map(toWorld);
    sea = intersect(union([[ring]], []), site);
  }

  // 2. River
  let river: Water['river'] = null;
  if (i.river) {
    let src: Point2, mouth: Point2;
    if (i.shore !== 'none') {
      const fromOpposite = rng() < 0.5;
      const local: Point2 = fromOpposite ? [uniform(-0.6, 0.6) * h, -h] : [rng() < 0.5 ? -h : h, uniform(-0.8, 0) * h];
      const mu = uniform(-0.5, 0.5) * h;
      const coastPt = localCoast.reduce((best, p) => (Math.abs(p[0] - mu) < Math.abs(best[0] - mu) ? p : best));
      src = toWorld(local);
      mouth = toWorld(coastPt);
    } else {
      const edges: [Point2, Point2][] = [[[0, -h], [0, h]], [[0, h], [0, -h]], [[-h, 0], [h, 0]], [[h, 0], [-h, 0]]];
      const [a, b] = edges[Math.floor(rng() * 4)];
      const off = () => uniform(-0.6, 0.6) * h;
      src = a[0] === 0 ? [off(), a[1]] : [a[0], off()];
      mouth = b[0] === 0 ? [off(), b[1]] : [b[0], off()];
    }
    // Stay out of the sea (with a margin) until the mouth.
    const seaMargin = sea ? offsetPolygons(sea, i.riverWidth) : null;
    const onLand = (p: Point2) => !seaMargin || !containsPoint(seaMargin, p);
    const course = chaikin(midpointDisplace(src, mouth, 5, 0.35 * MEANDER, rng, onLand), 3);
    // Extend past both ends so the band reaches the site edge and runs into the sea.
    const banded = [extend(course[0], course[1], i.riverWidth), ...course, extend(course[course.length - 1], course[course.length - 2], i.riverWidth)];
    let polygon = intersect(offsetPolyline(banded, i.riverWidth / 2), site);
    if (sea) polygon = difference(polygon, sea);
    // One river: keep the main piece; stray bits (a mouth extension poking through a coastal
    // bulge, a bend clipped by the sea) are left to the land.
    if (polygon.length > 1) polygon = [polygon.reduce((best, p) => (area([p]) > area([best]) ? p : best))];
    river = { polygon, course };
  }

  return { site, sea, coastline, river };
}

/** River surface per course point: from 0.3 × relief at the source, linear in arc length,
 *  down to 0 at a coastal mouth (or 0.05 × relief where it leaves the site inland). */
export function riverProfile(course: Point2[], relief: number, coastal: boolean): number[] {
  const cum = [0];
  for (let k = 1; k < course.length; k++) cum.push(cum[k - 1] + Math.hypot(course[k][0] - course[k - 1][0], course[k][1] - course[k - 1][1]));
  const L = cum[cum.length - 1] || 1;
  const top = 0.3 * relief, bottom = coastal ? 0 : 0.05 * relief;
  return cum.map(c => Math.round((top + (bottom - top) * (c / L)) * 100) / 100);
}

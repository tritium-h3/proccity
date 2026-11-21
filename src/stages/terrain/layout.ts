// Water-first layout: sea, river, flats and ponds as polygons, before any heights exist.
// The height map is then shaped around these (stage.ts), so every toggle is honoured.
//
// Geometry is built in a local frame where the sea lies towards +v (local "south") and
// rotated into world space, so one code path serves all four shores.

import { createNoise2D } from 'simplex-noise';
import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { chaikin } from '../../grammar/contour.js';
import { difference, intersect, offsetPolygons, offsetPolyline, union } from '../../grammar/clipper.js';
import { area, containsPoint, rect } from '../../grammar/polygon.js';

export type Shore = 'none' | 'north' | 'east' | 'south' | 'west';

export interface LayoutInput {
  size: number; rng: () => number; shore: Shore; coastWiggle: number;
  river: boolean; riverWidth: number; meander: number;
  flats: number; flatSize: number; ponds: number;
}

export interface Layout {
  site: MultiPolygon;
  sea: MultiPolygon | null;
  coastline: Point2[] | null;
  /** course runs source → mouth */
  river: { polygon: MultiPolygon; course: Point2[] } | null;
  flats: MultiPolygon[];
  ponds: MultiPolygon[];
}

const COAST_INSET = 0.2;
const MIN_PIECE = 100; // m²: anything smaller counts as "didn't fit"

/** Rotations (no reflections) from the local frame, sea towards +v, into world (x, z). */
const TO_WORLD: Record<Exclude<Shore, 'none'>, (p: Point2) => Point2> = {
  south: ([u, v]) => [u, v],
  north: ([u, v]) => [-u, -v],
  east: ([u, v]) => [v, -u],
  west: ([u, v]) => [-v, u],
};

/** An irregular closed blob: a radial profile perturbed by a few random sine waves. */
export function blob(centre: Point2, radius: number, rng: () => number, irregularity = 0.25): MultiPolygon {
  const waves = [1, 2, 3, 5].map(k => ({ k, a: (rng() - 0.5) * irregularity / k * 2, ph: rng() * Math.PI * 2 }));
  const ring: Point2[] = [];
  const N = 32;
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2;
    const r = radius * (1 + waves.reduce((s, w) => s + w.a * Math.sin(w.k * t + w.ph), 0));
    ring.push([centre[0] + Math.cos(t) * r, centre[1] + Math.sin(t) * r]);
  }
  return union([[ring]], []); // normalise orientation
}

/** Meander by recursive midpoint displacement. A displaced point that `ok` rejects (e.g. it
 *  would swing the course into the sea before its mouth) is retried with half the offset. */
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

const near = (shape: MultiPolygon, others: MultiPolygon, margin: number) =>
  others.length > 0 && area(intersect(offsetPolygons(shape, margin), others)) > 1;

export function layoutTerrain(i: LayoutInput): Layout {
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
    const amp = i.coastWiggle * 0.15 * size;
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
  let river: Layout['river'] = null;
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
    const course = chaikin(midpointDisplace(src, mouth, 5, 0.35 * i.meander, rng, onLand), 3);
    // Extend past both ends so the band reaches the site edge and runs into the sea.
    const banded = [extend(course[0], course[1], i.riverWidth), ...course, extend(course[course.length - 1], course[course.length - 2], i.riverWidth)];
    let polygon = intersect(offsetPolyline(banded, i.riverWidth / 2), site);
    if (sea) polygon = difference(polygon, sea);
    // One river: keep the main piece; stray bits (a mouth extension poking through a coastal
    // bulge, a bend clipped by the sea) are left to the land.
    if (polygon.length > 1) polygon = [polygon.reduce((best, p) => (area([p]) > area([best]) ? p : best))];
    river = { polygon, course };
  }

  const water = (): MultiPolygon => union(sea ?? [], river?.polygon ?? []);
  const land = difference(site, water());

  // 3. Flats
  const flats: MultiPolygon[] = [];
  const centres: Point2[] = [];
  const r = i.flatSize / 2;
  for (let n = 0; n < i.flats; n++) {
    let centre: Point2;
    if (n === 0 && coastline) {
      // On the coast, away from the river mouth, pushed a little inland so it touches the shore.
      const mouth = river?.course.at(-1);
      const candidates = coastline
        .filter(p => Math.max(Math.abs(p[0]), Math.abs(p[1])) < h - r * 0.5)
        .filter(p => !mouth || Math.hypot(p[0] - mouth[0], p[1] - mouth[1]) > r + i.riverWidth + 30);
      const pool = candidates.length ? candidates : coastline;
      const p = pool[Math.floor(rng() * pool.length)];
      const inland = toWorld([0, -1]);
      centre = [p[0] + inland[0] * r * 0.6, p[1] + inland[1] * r * 0.6];
    } else if (n === 0 && river) {
      const c = river.course;
      const k = Math.floor(c.length * (0.7 + rng() * 0.25));
      const a = c[Math.min(k, c.length - 2)], b = c[Math.min(k + 1, c.length - 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const side = rng() < 0.5 ? 1 : -1;
      const off = i.riverWidth / 2 + r * 0.6;
      centre = [a[0] - ((b[1] - a[1]) / len) * off * side, a[1] + ((b[0] - a[0]) / len) * off * side];
    } else {
      // Spread inland: of 30 candidates on land, the one farthest from existing flats.
      let best: Point2 | null = null, bestD = -1;
      for (let t = 0; t < 30; t++) {
        const p: Point2 = [uniform(-h, h), uniform(-h, h)];
        if (!containsPoint(land, p)) continue;
        const d = centres.length ? Math.min(...centres.map(q => Math.hypot(p[0] - q[0], p[1] - q[1]))) : uniform(0, 1);
        if (d > bestD) { bestD = d; best = p; }
      }
      if (!best) continue;
      centre = best;
    }
    let shape = intersect(blob(centre, r, rng), land);
    if (flats.length) shape = difference(shape, offsetPolygons(union(flats.flat(), []), 20));
    if (n > 0 && river) shape = difference(shape, offsetPolygons(river.polygon, 30));
    if (area(shape) < MIN_PIECE) continue;
    flats.push(shape);
    centres.push(centre);
  }

  // 4. Ponds
  const ponds: MultiPolygon[] = [];
  const flatsAll = union(flats.flat(), []);
  for (let n = 0; n < i.ponds; n++) {
    for (let t = 0; t < 40; t++) {
      const p: Point2 = [uniform(-h, h), uniform(-h, h)];
      if (!containsPoint(land, p)) continue;
      const shape = intersect(blob(p, uniform(20, 80), rng, 0.3), site);
      if (area(shape) < MIN_PIECE) continue;
      if (near(shape, water(), 60) || near(shape, union(ponds.flat(), []), 60) || near(shape, flatsAll, 30)) continue;
      ponds.push(shape);
      break;
    }
  }

  return { site, sea, coastline, river, flats, ponds };
}

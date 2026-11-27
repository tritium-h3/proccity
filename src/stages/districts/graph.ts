// The district graph: which districts touch (a shared boundary of at least TOUCH metres, so a
// corner doesn't count), and travel costs for the fill's expected density. Travel is the
// distance between centroids, dearer on slopes and hills; across water it's possible only
// where the two banks come close, and costs five times as much.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { intersect, offsetPolygons } from '../../grammar/clipper.js';
import { area, bounds } from '../../grammar/polygon.js';
import type { TerrainKind } from './rules.js';

export const TOUCH = 3;
const FACTOR: Record<TerrainKind, number> = { flat: 1, slope: 2, hills: 4 };
const WATER_FACTOR = 5;

export interface DistrictInfo { footprint: MultiPolygon; terrain: TerrainKind; area: number; centroid: Point2 }
export interface DistrictGraph {
  /** touching districts, sorted */
  neighbours: number[][];
  /** neighbours plus water crossings */
  travel: { to: number; cost: number }[][];
}

/** Length of the boundary two footprints share: the overlap of 1 m buffers is a strip 2 m wide. */
export function sharedLength(a: MultiPolygon, b: MultiPolygon): number {
  return area(intersect(offsetPolygons(a, 1), offsetPolygons(b, 1))) / 2;
}

export function buildGraph(ds: DistrictInfo[], crossing: number): DistrictGraph {
  const n = ds.length;
  const box = ds.map(d => bounds(d.footprint));
  const grown = ds.map(d => offsetPolygons(d.footprint, crossing / 2));
  const neighbours: number[][] = ds.map(() => []);
  const travel: { to: number; cost: number }[][] = ds.map(() => []);
  const dist = (i: number, j: number) => Math.hypot(ds[i].centroid[0] - ds[j].centroid[0], ds[i].centroid[1] - ds[j].centroid[1]);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const gap = Math.max(box[i].minX - box[j].maxX, box[j].minX - box[i].maxX, box[i].minZ - box[j].maxZ, box[j].minZ - box[i].maxZ);
    if (gap > crossing) continue;
    const factor = Math.max(FACTOR[ds[i].terrain], FACTOR[ds[j].terrain]);
    if (gap <= 1 && sharedLength(ds[i].footprint, ds[j].footprint) >= TOUCH) {
      neighbours[i].push(j); neighbours[j].push(i);
      const cost = dist(i, j) * factor;
      travel[i].push({ to: j, cost }); travel[j].push({ to: i, cost });
    } else if (area(intersect(grown[i], grown[j])) > 0) {
      const cost = dist(i, j) * factor * WATER_FACTOR;
      travel[i].push({ to: j, cost }); travel[j].push({ to: i, cost });
    }
  }
  return { neighbours, travel };
}

/** Shortest travel distance from the nearest source (Infinity where unreachable). */
export function travelFrom(g: DistrictGraph, sources: number[]): number[] {
  const d = g.travel.map(() => Infinity);
  const done = new Uint8Array(d.length);
  for (const s of sources) d[s] = 0;
  // Graphs are a few hundred districts: a linear scan for the minimum is plenty.
  for (;;) {
    let u = -1;
    for (let i = 0; i < d.length; i++) if (!done[i] && d[i] < Infinity && (u < 0 || d[i] < d[u])) u = i;
    if (u < 0) break;
    done[u] = 1;
    for (const { to, cost } of g.travel[u]) if (d[u] + cost < d[to]) d[to] = d[u] + cost;
  }
  return d;
}

/** Over about 100 m across: a 50 m inward offset leaves something. */
export function isWide(fp: MultiPolygon): boolean {
  return area(offsetPolygons(fp, -50)) > 0;
}

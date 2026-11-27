// A lot's faces: what lies along each side of its outline. A lot faces one or more roads of any
// categories (the owner: a tower facing four collectors gets four-sided architecture; a house
// backing onto an arterial may get a tall fence), so every side is recorded, one character per
// outline edge in ring order: A, C or L (a road), - (another lot) or o (open land: water,
// Undeveloped land, the site edge, the block's open ground). Buildings read the nearest road per face.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import type { RoadIndex } from '../blocks/roads.js';
import type { Category } from '../blocks/rules.js';

const PROBE = 1; // m beyond the edge, to see what's on the other side

export function edgesOf(lot: MultiPolygon, roads: RoadIndex, inBlock: (p: Point2) => 'lot' | 'open' | null): string {
  let out = '';
  for (const poly of lot) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const mid: Point2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const road = roads.at(mid);
    if (road) { out += road.category; continue; }
    // Rings keep the interior on their left, so outward is to the right.
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const beyond: Point2 = [mid[0] + ((b[1] - a[1]) / L) * PROBE, mid[1] - ((b[0] - a[0]) / L) * PROBE];
    out += inBlock(beyond) === 'lot' ? '-' : 'o';
  }
  return out;
}

/** The allowed category the lot fronts on most (by length of side), or null if none. */
export function frontOf(lot: MultiPolygon, edges: string, allowed: Category[]): Category | null {
  const len = new Map<Category, number>();
  let k = 0;
  for (const poly of lot) for (const ring of poly) for (let i = 0; i < ring.length; i++, k++) {
    const c = edges[k] as Category;
    if (!allowed.includes(c)) continue;
    const a = ring[i], b = ring[(i + 1) % ring.length];
    len.set(c, (len.get(c) ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  let best: Category | null = null, bl = 0;
  for (const [c, l] of len) if (l > bl) { bl = l; best = c; }
  return best;
}

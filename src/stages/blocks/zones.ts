// A block's zone: one of its district's zones whose lots may face a road the block borders,
// picked at random weighted by the district's use frequencies. Independent per block: the owner
// prefers mixes, and commercial corridors come from the facing rules, not from clustering.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import type { DistrictType } from '../districts/rules.js';
import type { RoadIndex } from './roads.js';
import { DISTRICT_ZONES, FACES, zoneWeight, type Category, type Developed, type Zone } from './rules.js';

const ORDER: Category[] = ['A', 'C', 'L'];

/** The road categories along the block's outline (sampled every `step` metres). */
export function facesOf(block: MultiPolygon, roads: RoadIndex, step = 5): Category[] {
  const seen = new Set<Category>();
  for (const poly of block) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) {
      const p: Point2 = [a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n];
      const r = roads.at(p);
      if (r) seen.add(r.category);
    }
  }
  return ORDER.filter(c => seen.has(c));
}

/** May a zone go on a block of this district facing these roads? */
export const zoneFits = (t: DistrictType, faces: Category[], z: Zone) =>
  t !== 'undeveloped' && DISTRICT_ZONES[t].includes(z) && FACES[z].some(c => faces.includes(c));

/** Pick with one draw `r` in [0, 1). `restricted`: the facing rules ruled out some district zones. */
export function pickZone(t: Developed, faces: Category[], r: number): { zone: Zone | null; restricted: boolean } {
  const all = DISTRICT_ZONES[t];
  const ok = all.filter(z => zoneFits(t, faces, z));
  const restricted = ok.length < all.length;
  const weights = ok.map(z => zoneWeight(t, z));
  const total = weights.reduce((s, w) => s + w, 0);
  if (!ok.length || total <= 0) return { zone: null, restricted };
  let x = r * total;
  for (let i = 0; i < ok.length; i++) { x -= weights[i]; if (x < 0) return { zone: ok[i], restricted }; }
  return { zone: ok[ok.length - 1], restricted };
}

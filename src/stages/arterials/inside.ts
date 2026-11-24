// Roads inside a district: which of its gateways are joined, and how. Neighbours around the
// perimeter may be joined along the border (a seeded share of the pairs allowed to), the rest
// pair up across the district, as opposite as possible (through roads cross each other and
// make junctions), and an odd one out joins the nearest road at a T. A town centre's roads all
// meet at a central junction instead; so does a lone gateway's.

import type { Point2 } from '../../doc/types.js';

export interface Gate { at: Point2; perim: number }
export interface PairOpts {
  /** share of allowed neighbouring pairs joined along the border */
  borderShare: number;
  /** may gateways i and j be joined along the border between them? */
  eligible(i: number, j: number): boolean;
  rng(): number;
  /** a town centre: every road meets at the centre */
  star: boolean;
}
export interface Pairing { through: [number, number][]; border: [number, number][]; tees: number[]; star: number[] }

export function pairGateways(gs: Gate[], centre: Point2, _perimeter: number, o: PairOpts): Pairing {
  const out: Pairing = { through: [], border: [], tees: [], star: [] };
  if (o.star || gs.length === 1) { out.star = gs.map((_, i) => i); return out; }
  const free = new Set(gs.map((_, i) => i));
  // Neighbours around the perimeter, in order (cyclic when there are more than two).
  const byPerim = gs.map((_, i) => i).sort((a, b) => gs[a].perim - gs[b].perim);
  const m = byPerim.length;
  for (let k = 0; k < (m > 2 ? m : 1); k++) {
    const i = byPerim[k], j = byPerim[(k + 1) % m];
    const roll = o.rng(); // drawn for every neighbouring pair, so one choice doesn't shift the rest
    if (!free.has(i) || !free.has(j) || !o.eligible(i, j) || roll >= o.borderShare) continue;
    out.border.push([i, j]);
    free.delete(i); free.delete(j);
  }
  // The rest pair up across, most opposite first.
  const angle = (i: number) => Math.atan2(gs[i].at[1] - centre[1], gs[i].at[0] - centre[0]);
  const pairs: { i: number; j: number; off: number }[] = [];
  const left = [...free];
  for (let a = 0; a < left.length; a++) for (let b = a + 1; b < left.length; b++) {
    let d = Math.abs(angle(left[a]) - angle(left[b])) % (2 * Math.PI);
    if (d > Math.PI) d = 2 * Math.PI - d;
    pairs.push({ i: left[a], j: left[b], off: Math.PI - d });
  }
  pairs.sort((x, y) => x.off - y.off || x.i - y.i || x.j - y.j);
  for (const { i, j } of pairs) {
    if (!free.has(i) || !free.has(j)) continue;
    out.through.push([i, j]);
    free.delete(i); free.delete(j);
  }
  out.tees = [...free];
  return out;
}

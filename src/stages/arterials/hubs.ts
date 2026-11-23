// Where arterials meet: hubs spaced across the land (the town centres first), and exits where
// the network leaves the site.

import type { Point2 } from '../../doc/types.js';

const MIN_SPACING = 0.85; // sampled hubs keep at least this share of the spacing apart
const TRIES = 30;
const EXIT_GAP = 150;     // m: exits never closer than this along the boundary (default)
const EXIT_SLIDE = 60;    // m: an exit slides this far along the edge to find flatter ground (default)

export function poissonHubs(fixed: Point2[], spacing: number, ok: (p: Point2) => boolean,
  bounds: { minX: number; minZ: number; size: number }, rng: () => number): Point2[] {
  const hubs = [...fixed];
  const min = MIN_SPACING * spacing;
  const target = Math.ceil((bounds.size / spacing) ** 2 * 1.5);
  let misses = 0;
  while (misses < TRIES * target) {
    const p: Point2 = [bounds.minX + rng() * bounds.size, bounds.minZ + rng() * bounds.size];
    if (!ok(p) || hubs.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < min)) { misses++; continue; }
    hubs.push(p);
  }
  return hubs;
}

export interface Exit { at: Point2; inward: Point2 }

/** Up to n exits on the site boundary (a CCW ring), spread apart along it, on allowed edges. */
export function placeExits(n: number, boundary: Point2[], okEdge: (p: Point2) => boolean,
  flatness: (p: Point2) => number, rng: () => number, gapM = EXIT_GAP, slideM = EXIT_SLIDE): Exit[] {
  // Sample the boundary every 10 m: position along the perimeter, point, inward normal.
  const samples: { s: number; at: Point2; inward: Point2 }[] = [];
  let s0 = 0;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-9) continue;
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    const stepM = Math.max(10, slideM / 6);
    for (let t = stepM / 2; t < len; t += stepM) {
      const at: Point2 = [a[0] + ux * t, a[1] + uz * t];
      if (okEdge(at)) samples.push({ s: s0 + t, at, inward: [-uz, ux] });
    }
    s0 += len;
  }
  const perimeter = s0;
  const gap = (x: number, y: number) => { const d = Math.abs(x - y) % perimeter; return Math.min(d, perimeter - d); };
  const chosen: typeof samples = [];
  if (!samples.length) return [];
  let pick = samples[Math.floor(rng() * samples.length)];
  while (chosen.length < n) {
    // Slide to the flattest allowed sample nearby.
    const near = samples.filter(q => gap(q.s, pick.s) <= slideM && chosen.every(c => gap(c.s, q.s) >= gapM));
    if (near.length) pick = near.reduce((a, b) => (flatness(b.at) > flatness(a.at) ? b : a));
    chosen.push(pick);
    let best: (typeof samples)[number] | null = null, bd = -1;
    for (const q of samples) {
      const d = Math.min(...chosen.map(c => gap(c.s, q.s)));
      if (d > bd) { bd = d; best = q; }
    }
    if (!best || bd < gapM) break;
    pick = best;
  }
  return chosen.map(c => ({ at: c.at, inward: c.inward }));
}

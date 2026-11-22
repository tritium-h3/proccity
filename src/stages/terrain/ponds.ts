// Rounded pond outlines. A pond is a union of whole cells, so its shoreline was their
// straight edges and hard corners (seen from above, very polygonal). Every pond shoreline is
// subdivided (each new point goes into both rings sharing the edge), then its vertices are
// moved to a Gaussian-smoothed position along the shoreline. A vertex moves in every ring
// that holds it, so cells keep partitioning the land with no gaps or T-junctions, and a move
// is refused if it would fold or cross any cell.
// Rejected: filleting each corner (Voronoi corners come with metre-long edges after
// snapping, which capped the fillets to a metre, leaving corners sharp from any distance),
// and Clipper offsets (they shift straight edges ~1 mm, leaving slivers against neighbours).
// Design: docs/superpowers/specs/2026-11-22-round-ponds-design.md

import type { Point2 } from '../../doc/types.js';
import { area, containsPoint, signedArea } from '../../grammar/polygon.js';
import { interiorPoint, vkey, type Cell } from './cells.js';

const TAU = Math.PI * 2;

function segmentsCross(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o = (p: Point2, q: Point2, r: Point2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Smooth every pond outline: Gaussian along the shoreline with `sigma` metres. Mutates cell
 *  rings, areas and (if a seed ends up outside its cell) seeds. Neighbour graphs are left
 *  alone: moves are local and never create contact between cells that didn't touch. */
export function roundPonds(cells: Cell[], isPond: (i: number) => boolean, sigma: number): void {
  const ringOf = (ci: number) => cells[ci].poly[0];

  // 1. Shoreline edges: a→b in a pond ring with b→a in a land ring.
  const landEdge = new Map<string, number>(); // "b|a" → land cell
  cells.forEach((c, ci) => {
    if (isPond(ci)) return;
    const r = c.poly[0];
    for (let i = 0; i < r.length; i++) landEdge.set(`${vkey(r[i])}|${vkey(r[(i + 1) % r.length])}`, ci);
  });
  const shore: { pond: number; land: number; a: Point2; b: Point2 }[] = [];
  cells.forEach((c, ci) => {
    if (!isPond(ci)) return;
    const r = c.poly[0];
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const land = landEdge.get(`${vkey(b)}|${vkey(a)}`);
      if (land !== undefined) shore.push({ pond: ci, land, a, b });
    }
  });
  if (!shore.length) return;

  // 2. Subdivide long shoreline edges, in both rings.
  const step = sigma / 2;
  const insertAfter = (ci: number, from: Point2, to: Point2, pts: Point2[]) => {
    const r = ringOf(ci), kf = vkey(from), kt = vkey(to);
    const i = r.findIndex((p, j) => vkey(p) === kf && vkey(r[(j + 1) % r.length]) === kt);
    if (i >= 0) r.splice(i + 1, 0, ...pts);
  };
  const outs = new Map<string, string[]>(), ins = new Map<string, number>(), pos = new Map<string, Point2>();
  for (const e of shore) {
    const L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
    const n = Math.max(1, Math.ceil(L / step));
    const pts: Point2[] = [];
    for (let k = 1; k < n; k++) pts.push([e.a[0] + (e.b[0] - e.a[0]) * k / n, e.a[1] + (e.b[1] - e.a[1]) * k / n]);
    insertAfter(e.pond, e.a, e.b, pts);
    insertAfter(e.land, e.b, e.a, [...pts].reverse());
    const chain = [e.a, ...pts, e.b];
    for (let k = 0; k < chain.length; k++) {
      const kk = vkey(chain[k]);
      pos.set(kk, chain[k]);
      if (k + 1 < chain.length) (outs.get(kk) ?? outs.set(kk, []).get(kk)!).push(vkey(chain[k + 1]));
      if (k > 0) ins.set(kk, (ins.get(kk) ?? 0) + 1);
    }
  }

  // 3. Shoreline paths. A vertex where the pond touches itself (two ways on) stays put and
  //    splits its loop into open chains; every other loop is closed.
  const pinned = (k: string) => (outs.get(k)?.length ?? 0) !== 1 || (ins.get(k) ?? 0) !== 1;
  const paths: { keys: string[]; closed: boolean }[] = [];
  const done = new Set<string>();
  for (const [k0, os] of outs) {
    if (!pinned(k0)) continue;
    for (const o of os) {
      const keys = [k0];
      let k = o;
      while (!pinned(k) && !done.has(k)) { done.add(k); keys.push(k); k = outs.get(k)![0]; }
      keys.push(k);
      if (keys.length >= 3) paths.push({ keys, closed: false });
    }
  }
  for (const k0 of outs.keys()) {
    if (done.has(k0) || pinned(k0)) continue;
    const keys: string[] = [];
    let k = k0;
    while (!done.has(k) && !pinned(k)) { done.add(k); keys.push(k); k = outs.get(k)![0]; }
    if (k === k0 && keys.length >= 3) paths.push({ keys, closed: true });
  }

  // Where each vertex sits in the rings, for moving it everywhere at once.
  const where = new Map<string, number[]>();
  cells.forEach((c, ci) => { for (const p of c.poly[0]) { const k = vkey(p); if (pos.has(k)) (where.get(k) ?? where.set(k, []).get(k)!).push(ci); } });
  const boxes = cells.map(c => {
    const xs = c.poly[0].map(p => p[0]), zs = c.poly[0].map(p => p[1]);
    return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
  });

  /** Move vertex `k` (currently at `from`) to `to` in every ring holding it, if no cell folds. */
  const tryMove = (k: string, from: Point2, to: Point2): boolean => {
    const owners = where.get(k) ?? [];
    const patched = owners.map(ci => {
      const r = ringOf(ci), i = r.findIndex(p => p === from || (p[0] === from[0] && p[1] === from[1]));
      return { ci, i, r };
    });
    if (patched.some(p => p.i < 0)) return false;
    // The cells around the vertex must still fan exactly once around it.
    let turn = 0;
    for (const { r, i } of patched) {
      const P = r[(i + r.length - 1) % r.length], N = r[(i + 1) % r.length];
      const a1 = Math.atan2(N[1] - to[1], N[0] - to[0]), a2 = Math.atan2(P[1] - to[1], P[0] - to[0]);
      turn += ((a2 - a1) % TAU + TAU) % TAU;
    }
    if (Math.abs(turn - TAU) > 1e-6) return false;
    // New edges may not cross any other edge, in any cell nearby.
    const minX = Math.min(from[0], to[0]) - 1e3, maxX = Math.max(from[0], to[0]) + 1e3;
    for (const { r, i } of patched) {
      const P = r[(i + r.length - 1) % r.length], N = r[(i + 1) % r.length];
      for (const [u, v] of [[P, to], [to, N]] as [Point2, Point2][]) {
        const bx0 = Math.min(u[0], v[0]), bx1 = Math.max(u[0], v[0]), bz0 = Math.min(u[1], v[1]), bz1 = Math.max(u[1], v[1]);
        for (let cj = 0; cj < cells.length; cj++) {
          const bb = boxes[cj];
          if (bb[0] > bx1 || bb[2] < bx0 || bb[1] > bz1 || bb[3] < bz0 || bb[0] > maxX || bb[2] < minX) continue;
          const q = ringOf(cj);
          for (let m = 0; m < q.length; m++) {
            const c = q[m], d = q[(m + 1) % q.length];
            if (c === from || d === from || (c[0] === from[0] && c[1] === from[1]) || (d[0] === from[0] && d[1] === from[1])) continue;
            if (segmentsCross(u, v, c, d)) return false;
          }
        }
      }
    }
    for (const { ci, i, r } of patched) {
      r[i] = to;
      const bb = boxes[ci];
      bb[0] = Math.min(bb[0], to[0]); bb[1] = Math.min(bb[1], to[1]); bb[2] = Math.max(bb[2], to[0]); bb[3] = Math.max(bb[3], to[1]);
      if (signedArea(r) <= 0) { for (const p of patched) p.r[p.i] = from; return false; }
    }
    return true;
  };

  // 4. Gaussian-smoothed targets along each path (by arc length, weighted by the length each
  //    vertex stands for, so uneven spacing doesn't bias it), then move, halving on refusal.
  const touched = new Set<number>();
  for (const { keys, closed } of paths) {
    const P = keys.map(k => pos.get(k)!);
    const n = P.length;
    // seg[i]: length from vertex i to the next (the last one wraps only on a closed loop)
    const seg = P.map((p, i) => (closed || i + 1 < n ? Math.hypot(P[(i + 1) % n][0] - p[0], P[(i + 1) % n][1] - p[1]) : 0));
    const total = seg.reduce((a, b) => a + b, 0);
    const reach = Math.min(3 * sigma, closed ? total / 2 : total);
    const idx = (j: number) => (closed ? ((j % n) + n) % n : j);
    const ok = (j: number) => closed || (j >= 0 && j < n);
    const targets = P.map((_, i) => {
      let w = 0, x = 0, z = 0;
      const add = (j: number, d: number) => {
        const jj = idx(j);
        const stand = ((ok(j) ? seg[jj] : 0) + (ok(j - 1) ? seg[idx(j - 1)] : 0)) / 2 || 1e-6;
        const wt = Math.exp(-(d * d) / (2 * sigma * sigma)) * stand;
        w += wt; x += wt * P[jj][0]; z += wt * P[jj][1];
      };
      add(i, 0);
      for (let j = i + 1, d = seg[i]; ok(j) && d <= reach && j < i + n; d += seg[idx(j)], j++) add(j, d);
      for (let j = i - 1, d = seg[idx(i - 1)] ?? 0; ok(j) && d <= reach && j > i - n; j--, d += seg[idx(j)] ?? 0) add(j, d);
      return [x / w, z / w] as Point2;
    });
    keys.forEach((k, i) => {
      if (!closed && (i === 0 || i === n - 1)) return; // chain ends are pinch points
      const from = P[i];
      for (const t of [1, 0.5, 0.25]) {
        const to: Point2 = [from[0] + (targets[i][0] - from[0]) * t, from[1] + (targets[i][1] - from[1]) * t];
        if (tryMove(k, from, to)) { for (const ci of where.get(k) ?? []) touched.add(ci); break; }
      }
    });
  }

  for (const ci of touched) {
    const c = cells[ci];
    c.area = area([c.poly]);
    if (!containsPoint([c.poly], c.seed)) c.seed = interiorPoint(c.poly);
  }
}

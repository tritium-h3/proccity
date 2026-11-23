// Post-compute simplification of a region's ground surface. Interior vertices are removed
// one at a time while the surface stays within `tolerance` metres of the original: each
// removal refills the hole with triangles over the vertex's neighbours, and is accepted
// only if the removed vertex AND every vertex removed earlier under those triangles still
// lie within tolerance (so errors can't pile up). Boundary vertices are never removed, so
// regions still share every vertex along their edges (no T-junctions, no cracks).
// Level flats collapse almost entirely; curved slopes keep what their shape needs.

import type { GroundSurface } from '../../doc/types.js';

type Tri = [number, number, number];
const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Ear clipping that keeps every vertex (earcut drops in-line ones, which here would be
 *  vertices shared with a neighbouring region). Ring is CCW; returns null if stuck. */
function clipEars(ring: number[], P: number[][]): Tri[] | null {
  const r = ring.slice(), out: Tri[] = [];
  let guard = r.length * r.length + 10;
  while (r.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < r.length; i++) {
      const a = r[(i + r.length - 1) % r.length], b = r[i], c = r[(i + 1) % r.length];
      if (cross(P[a], P[b], P[c]) <= 1e-9) continue; // reflex or in-line: not an ear
      // No other ring vertex inside or on the ear (a vertex on a–c would be swallowed).
      const blocked = r.some(q => q !== a && q !== b && q !== c
        && cross(P[a], P[b], P[q]) >= -1e-9 && cross(P[b], P[c], P[q]) >= -1e-9 && cross(P[c], P[a], P[q]) >= -1e-9);
      if (blocked) continue;
      out.push([a, b, c]);
      r.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (r.length === 3) {
    if (cross(P[r[0]], P[r[1]], P[r[2]]) <= 1e-9) return null;
    out.push([r[0], r[1], r[2]]);
  }
  return out;
}

/** Height of triangle t's plane at p, or null if p is outside it. */
function heightIn(t: Tri, P: number[][], x: number, z: number): number | null {
  const [a, b, c] = t.map(i => P[i]);
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) return null;
  const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / d;
  const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / d;
  if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) return null;
  return u * a[2] + v * b[2] + (1 - u - v) * c[2];
}

/** Simplify `g` within `tolerance` metres. `keep` names extra points (as "x,z") never to remove. */
export function decimate(g: GroundSurface, tolerance: number, keep: Set<string> = new Set()): GroundSurface {
  const P = g.points;
  const tris: (Tri | null)[] = g.triangles.map(t => [...t] as Tri);
  const carried: number[][] = tris.map(() => []); // removed points lying in each triangle
  const at: Set<number>[] = P.map(() => new Set());
  tris.forEach((t, ti) => t!.forEach(v => at[v].add(ti)));

  const locked = new Uint8Array(P.length);
  const edges = new Map<string, number>();
  for (const t of g.triangles) for (let k = 0; k < 3; k++) {
    const a = t[k], b = t[(k + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  for (const [key, n] of edges) if (n === 1) for (const v of key.split(',').map(Number)) locked[v] = 1;
  P.forEach((p, i) => { if (keep.has(`${p[0]},${p[1]}`)) locked[i] = 1; });

  const removed = new Uint8Array(P.length);
  const tryRemove = (v: number): boolean => {
    const fan = [...at[v]];
    if (fan.length < 3) return false;
    // Ordered ring of neighbours, anticlockwise around v.
    const next = new Map<number, number>();
    for (const ti of fan) {
      const t = tris[ti]!, k = t.indexOf(v);
      let a = t[(k + 1) % 3], b = t[(k + 2) % 3];
      if (cross(P[v], P[a], P[b]) < 0) [a, b] = [b, a];
      next.set(a, b);
    }
    const ring = [next.keys().next().value!];
    while (ring.length <= fan.length) {
      const n = next.get(ring[ring.length - 1]);
      if (n === undefined) return false;
      if (n === ring[0]) break;
      ring.push(n);
    }
    if (ring.length !== fan.length) return false;
    const fill = clipEars(ring, P);
    if (!fill) return false;
    // Between vertices too: the old and new surfaces can differ most inside a triangle (a
    // fill bridging a valley, e.g. bank to bank over a river bed), so compare them at each new
    // triangle's centre and at the midpoints of its internal edges.
    const ringSet = new Set(ring);
    const oldAt = (x: number, z: number) => {
      for (const ti of fan) { const h = heightIn(tris[ti]!, P, x, z); if (h !== null) return h; }
      return null;
    };
    for (const t of fill) {
      const samples: number[][] = [[(P[t[0]][0] + P[t[1]][0] + P[t[2]][0]) / 3, (P[t[0]][1] + P[t[1]][1] + P[t[2]][1]) / 3]];
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3];
        const ia = ring.indexOf(a), ib = ring.indexOf(b);
        const onRing = ringSet.has(a) && ringSet.has(b) && (Math.abs(ia - ib) === 1 || Math.abs(ia - ib) === ring.length - 1);
        if (!onRing) samples.push([(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2]);
      }
      for (const [x, z] of samples) {
        const hNew = heightIn(t, P, x, z), hOld = oldAt(x, z);
        if (hNew === null || hOld === null || Math.abs(hNew - hOld) > tolerance) return false;
      }
    }
    // Every point this patch now stands for must stay within tolerance.
    const check = [v, ...fan.flatMap(ti => carried[ti])];
    const home: number[] = [];
    for (const q of check) {
      let found = -1;
      for (let f = 0; f < fill.length; f++) {
        const h = heightIn(fill[f], P, P[q][0], P[q][1]);
        if (h !== null) { if (Math.abs(h - P[q][2]) > tolerance) return false; found = f; break; }
      }
      if (found < 0) return false;
      home.push(found);
    }
    for (const ti of fan) { for (const u of tris[ti]!) at[u].delete(ti); tris[ti] = null; }
    const ids = fill.map(t => { tris.push(t); carried.push([]); const id = tris.length - 1; t.forEach(u => at[u].add(id)); return id; });
    check.forEach((q, i) => carried[ids[home[i]]].push(q));
    removed[v] = 1;
    return true;
  };

  for (let pass = 0; pass < 8; pass++) {
    let any = false;
    for (let v = 0; v < P.length; v++) if (!locked[v] && !removed[v] && tryRemove(v)) any = true;
    if (!any) break;
  }

  const live = tris.filter((t): t is Tri => t !== null);
  const remap = new Int32Array(P.length).fill(-1);
  const points: [number, number, number][] = [];
  for (const t of live) for (const v of t) if (remap[v] < 0) { remap[v] = points.length; points.push(P[v]); }
  return { points, triangles: live.map(t => t.map(v => remap[v]) as Tri) };
}

// Which hubs get joined. The Delaunay triangulation gives the candidate links; links over
// water or much longer than the spacing go. A minimum spanning tree (by estimated route cost)
// is what reachability needs; then the cheapest other links are added, up to the Redundancy
// share, unless they'd meet another link at a hub more sharply than the junction angle.

import { Delaunay } from 'd3-delaunay';
import type { Point2 } from '../../doc/types.js';

export interface Link { a: number; b: number; required: boolean }

export function buildMesh(hubs: Point2[], cost: (a: number, b: number) => number,
  o: { redundancy: number; minAngle: number; maxLen: number; blocked: (a: number, b: number) => boolean }): { links: Link[]; sharp: number } {
  const n = hubs.length;
  const pairs = new Set<string>();
  const add = (a: number, b: number) => pairs.add(a < b ? `${a},${b}` : `${b},${a}`);
  if (n === 2) add(0, 1);
  else if (n > 2) {
    const t = Delaunay.from(hubs).triangles;
    for (let i = 0; i < t.length; i += 3) { add(t[i], t[i + 1]); add(t[i + 1], t[i + 2]); add(t[i + 2], t[i]); }
  }
  const len = (a: number, b: number) => Math.hypot(hubs[a][0] - hubs[b][0], hubs[a][1] - hubs[b][1]);
  const candidates = [...pairs].map(k => k.split(',').map(Number) as [number, number])
    .filter(([a, b]) => len(a, b) <= o.maxLen && !o.blocked(a, b))
    .map(([a, b]) => ({ a, b, c: cost(a, b) }))
    .filter(e => Number.isFinite(e.c))
    .sort((x, y) => x.c - y.c || x.a - y.a || x.b - y.b);

  const parent = [...Array(n).keys()];
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const links: Link[] = [];
  const rest: typeof candidates = [];
  for (const e of candidates) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) { parent[ra] = rb; links.push({ a: e.a, b: e.b, required: true }); } else rest.push(e);
  }

  const dir = (from: number, to: number) => Math.atan2(hubs[to][1] - hubs[from][1], hubs[to][0] - hubs[from][0]);
  const angle = (x: number, y: number) => { let d = Math.abs(x - y) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d; };
  const sharpAt = (hub: number, other: number, ls: Link[]) => ls.some(l => {
    const o2 = l.a === hub ? l.b : l.b === hub ? l.a : -1;
    return o2 >= 0 && o2 !== other && angle(dir(hub, other), dir(hub, o2)) < o.minAngle;
  });

  const want = Math.round(o.redundancy * rest.length);
  let added = 0;
  for (const e of rest) {
    if (added >= want) break;
    if (sharpAt(e.a, e.b, links) || sharpAt(e.b, e.a, links)) continue;
    links.push({ a: e.a, b: e.b, required: false });
    added++;
  }

  let sharp = 0;
  for (let h = 0; h < n; h++) {
    const ds = links.filter(l => l.a === h || l.b === h).map(l => dir(h, l.a === h ? l.b : l.a));
    for (let x = 0; x < ds.length; x++) for (let y = x + 1; y < ds.length; y++) if (angle(ds[x], ds[y]) < o.minAngle) sharp++;
  }
  return { links, sharp };
}

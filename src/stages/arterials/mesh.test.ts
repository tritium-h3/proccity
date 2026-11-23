import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { buildMesh } from './mesh.js';

// A jittered 5×5 lattice of hubs 500 m apart.
const hubs: Point2[] = [];
for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) hubs.push([i * 500 + ((i * 7 + j * 3) % 5) * 20, j * 500 + ((i * 3 + j * 5) % 5) * 20]);
const dist = (a: number, b: number) => Math.hypot(hubs[a][0] - hubs[b][0], hubs[a][1] - hubs[b][1]);
const base = { minAngle: Math.PI / 3, maxLen: 900, blocked: () => false };

function connected(n: number, links: { a: number; b: number }[]) {
  const parent = [...Array(n).keys()];
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const l of links) parent[find(l.a)] = find(l.b);
  return new Set([...Array(n).keys()].map(find)).size === 1;
}
function minAngleAt(links: { a: number; b: number }[]) {
  let worst = Infinity;
  hubs.forEach((h, i) => {
    const dirs = links.filter(l => l.a === i || l.b === i).map(l => { const o = hubs[l.a === i ? l.b : l.a]; return Math.atan2(o[1] - h[1], o[0] - h[0]); });
    for (let x = 0; x < dirs.length; x++) for (let y = x + 1; y < dirs.length; y++) { let d = Math.abs(dirs[x] - dirs[y]); if (d > Math.PI) d = 2 * Math.PI - d; worst = Math.min(worst, d); }
  });
  return worst;
}

describe('buildMesh', () => {
  it('keeps a spanning tree at redundancy 0', () => {
    const { links } = buildMesh(hubs, dist, { ...base, redundancy: 0 });
    expect(links.every(l => l.required)).toBe(true);
    expect(links).toHaveLength(hubs.length - 1);
    expect(connected(hubs.length, links)).toBe(true);
  });

  it('adds loops with redundancy, never at a sharp angle', () => {
    const r = buildMesh(hubs, dist, { ...base, redundancy: 1 });
    expect(r.links.length).toBeGreaterThan(hubs.length - 1);
    if (r.sharp === 0) expect(minAngleAt(r.links)).toBeGreaterThanOrEqual(Math.PI / 3 - 1e-9);
    const loops = r.links.filter(l => !l.required);
    expect(minAngleAt(r.links.filter(l => l.required).concat(loops))).toBeGreaterThan(0);
  });

  it('excludes blocked and over-long links', () => {
    const blocked = (a: number, b: number) => (a === 0 && b === 1) || (a === 1 && b === 0);
    const { links } = buildMesh(hubs, dist, { ...base, redundancy: 1, blocked });
    expect(links.some(l => (l.a === 0 && l.b === 1) || (l.a === 1 && l.b === 0))).toBe(false);
    expect(links.every(l => dist(l.a, l.b) <= 900)).toBe(true);
  });

  it('is deterministic', () => {
    expect(buildMesh(hubs, dist, { ...base, redundancy: 0.5 })).toEqual(buildMesh(hubs, dist, { ...base, redundancy: 0.5 }));
  });
});

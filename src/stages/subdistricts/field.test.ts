import { describe, expect, it } from 'vitest';
import { createSite } from '../../doc/create.js';
import type { RegionNode } from '../../doc/types.js';
import { makeSlab } from '../../grammar/slab.js';
import { densityField } from './field.js';

// A 2 km site (−1000…1000) cut into vertical strips: [x0, x1, type | null] (null = water).
function site(strips: [number, number, string | null][]): RegionNode {
  const tree = createSite(2000);
  tree.children = strips.map(([a, b, type], i) => ({
    id: `site/${type ? 'd' : 'w'}:${i}`, name: String(i), kind: type ? 'district' : 'river', stage: 'test',
    geometry: makeSlab([[[[a, -1000], [b, -1000], [b, 1000], [a, 1000]]]]), attrs: type ? { type } : {}, children: [],
  }));
  return tree;
}
const opts = { districtSize: 25, variation: 0, seed: 1 }; // σ = 250 m

describe('implied density field', () => {
  const A = densityField(site([[-1000, 0, 'financial'], [0, 1000, 'suburban']]), opts);
  it('takes each district’s nominal density deep inside it', () => {
    expect(A.at([-900, 0])).toBeCloseTo(8.5, 0);
    expect(A.at([900, 0])).toBeCloseTo(3, 0);
  });
  it('falls gradually across a border', () => {
    let last = Infinity;
    for (let x = -600; x <= 600; x += 100) {
      const v = A.at([x, 0]);
      expect(v).toBeLessThan(last);
      last = v;
    }
    expect(A.at([0, 0])).toBeGreaterThan(4);
    expect(A.at([0, 0])).toBeLessThan(7.5);
  });
  it('ignores water: a shore is as dense as inland', () => {
    const B = densityField(site([[-1000, 0, 'financial'], [0, 700, 'suburban'], [700, 1000, null]]), opts);
    expect(B.at([600, 0])).toBeCloseTo(A.at([600, 0]), 1);
  });
  it('lets Undeveloped districts pull their neighbours down', () => {
    const C = densityField(site([[-1000, 0, 'financial'], [0, 1000, 'undeveloped']]), opts);
    expect(C.at([-100, 0])).toBeLessThan(A.at([-100, 0]) - 0.5);
  });
  it('averages over a footprint', () => {
    expect(A.meanOver([[[[-1000, -1000], [-800, -1000], [-800, 1000], [-1000, 1000]]]])).toBeCloseTo(8.5, 0);
  });
  it('adds seeded noise within ±variation', () => {
    const tree = site([[-1000, 0, 'financial'], [0, 1000, 'suburban']]);
    const n1 = densityField(tree, { ...opts, variation: 1 }), n2 = densityField(tree, { ...opts, variation: 1 });
    let moved = 0;
    for (let x = -950; x < 1000; x += 50) {
      const d = n1.at([x, 300]) - A.at([x, 300]);
      expect(Math.abs(d)).toBeLessThanOrEqual(1.0001);
      expect(n2.at([x, 300])).toBe(n1.at([x, 300]));
      if (Math.abs(d) > 0.1) moved++;
    }
    expect(moved).toBeGreaterThan(5);
  });
});

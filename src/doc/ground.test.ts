import { describe, it, expect } from 'vitest';
import { createSite } from './create.js';
import { groundHeightAt, heightOnSurface, triangleArea } from './ground.js';
import { makeSlab } from '../grammar/slab.js';
import { rect } from '../grammar/polygon.js';
import type { GroundSurface, RegionNode } from './types.js';

const square: GroundSurface = {
  points: [[0, 0, 0], [10, 0, 10], [10, 10, 20], [0, 10, 30]],
  triangles: [[0, 1, 2], [0, 2, 3]],
};

describe('ground surfaces', () => {
  it('interpolates inside triangles and matches vertices', () => {
    expect(heightOnSurface(square, 0, 0)).toBeCloseTo(0);
    expect(heightOnSurface(square, 10, 10)).toBeCloseTo(20);
    expect(heightOnSurface(square, 20 / 3, 10 / 3)).toBeCloseTo(10); // centroid of tri 0
  });
  it('returns null outside', () => {
    expect(heightOnSurface(square, 20, 5)).toBeNull();
  });
  it('measures plan-view area', () => {
    expect(triangleArea(square)).toBeCloseTo(100);
  });
  it('finds the terrain region containing a point', () => {
    const site = createSite(100);
    const child: RegionNode = {
      id: 'site/flat:0', name: 'flat:0', kind: 'flat', stage: 'terrain', attrs: {}, children: [],
      geometry: makeSlab(rect(0, 0, 10, 10)), data: { ground: square },
    };
    site.children.push(child);
    expect(groundHeightAt(site, 10, 10)).toBeCloseTo(20);
    expect(groundHeightAt(site, -30, -30)).toBe(0);
  });
  it('returns 0 for old v1 cities without ground data', () => {
    const site = createSite(100);
    site.data = { heightfield: { origin: [0, 0], cell: 8, cols: 1, rows: 1, heights: 'AAAAAA==' } };
    site.children.push({ id: 'site/flat:0', name: 'flat:0', kind: 'flat', stage: 'terrain', attrs: {}, children: [], geometry: makeSlab(rect(-50, -50, 50, 50)) });
    expect(groundHeightAt(site, 0, 0)).toBe(0);
  });
});

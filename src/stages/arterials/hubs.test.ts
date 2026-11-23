import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { createRng } from '../../pipeline/seeds.js';
import { placeExits, poissonHubs } from './hubs.js';

const bounds = { minX: 0, minZ: 0, size: 2000 };
const square: Point2[] = [[0, 0], [2000, 0], [2000, 2000], [0, 2000]];

describe('poissonHubs', () => {
  it('spaces hubs out, keeps the fixed ones first, and respects ok', () => {
    const fixed: Point2[] = [[1000, 1000], [400, 1500]];
    const ok = (p: Point2) => p[1] > 300; // nothing in the south strip
    const hubs = poissonHubs(fixed, 500, ok, bounds, createRng(1));
    expect(hubs.slice(0, 2)).toEqual(fixed);
    expect(hubs.length).toBeGreaterThan(6);
    for (let i = 2; i < hubs.length; i++) {
      expect(ok(hubs[i])).toBe(true);
      for (let j = 0; j < hubs.length; j++) if (j !== i) expect(Math.hypot(hubs[i][0] - hubs[j][0], hubs[i][1] - hubs[j][1])).toBeGreaterThanOrEqual(0.7 * 500);
    }
    expect(poissonHubs(fixed, 500, ok, bounds, createRng(1))).toEqual(hubs);
  });
});

describe('placeExits', () => {
  it('spreads exits over the allowed edges, pointing inward', () => {
    const okEdge = (p: Point2) => p[1] > 1 ; // the south edge (z = 0) is sea
    const exits = placeExits(3, square, okEdge, () => 1, createRng(2));
    expect(exits).toHaveLength(3);
    for (const e of exits) {
      expect(okEdge(e.at)).toBe(true);
      expect(Math.hypot(...e.inward)).toBeCloseTo(1);
      // Inward really points into the square.
      expect(e.at[0] + 10 * e.inward[0]).toBeGreaterThan(0);
      expect(e.at[0] + 10 * e.inward[0]).toBeLessThan(2000);
      expect(e.at[1] + 10 * e.inward[1]).toBeGreaterThan(0);
      expect(e.at[1] + 10 * e.inward[1]).toBeLessThan(2000);
    }
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(Math.hypot(exits[i].at[0] - exits[j].at[0], exits[i].at[1] - exits[j].at[1])).toBeGreaterThan(500);
  });

  it('places fewer when there is little land edge', () => {
    const okEdge = (p: Point2) => p[1] > 1900 && p[0] > 900 && p[0] < 1000; // a 100 m strip
    expect(placeExits(8, square, okEdge, () => 1, createRng(3)).length).toBeLessThan(8);
  });
});

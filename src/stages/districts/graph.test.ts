import { describe, it, expect } from 'vitest';
import type { MultiPolygon } from '../../doc/types.js';
import { area, centroid, rect } from '../../grammar/polygon.js';
import { buildGraph, isWide, travelFrom, type DistrictInfo } from './graph.js';
import type { TerrainKind } from './rules.js';

const info = (footprint: MultiPolygon, terrain: TerrainKind = 'flat'): DistrictInfo => ({ footprint, terrain, area: area(footprint), centroid: centroid(footprint) });

// 3×3 grid of 100 m squares (ids y*3+x), plus a square 40 m beyond the right edge of id 5.
function grid(slope: number[] = []): DistrictInfo[] {
  const ds: DistrictInfo[] = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) ds.push(info(rect(x * 100, y * 100, x * 100 + 100, y * 100 + 100), slope.includes(y * 3 + x) ? 'slope' : 'flat'));
  ds.push(info(rect(340, 100, 440, 200)));
  return ds;
}

describe('buildGraph', () => {
  it('links districts sharing an edge, not a corner', () => {
    const g = buildGraph(grid(), 60);
    expect(g.neighbours[4]).toEqual([1, 3, 5, 7]);
    expect(g.neighbours[0]).toEqual([1, 3]);
    expect(g.neighbours[9]).toEqual([]);
  });

  it('costs travel by distance and terrain', () => {
    const g = buildGraph(grid([1]), 60);
    expect(g.travel[0].find(e => e.to === 3)!.cost).toBeCloseTo(100);
    expect(g.travel[0].find(e => e.to === 1)!.cost).toBeCloseTo(200);
  });

  it('crosses water only within the crossing distance, at five times the cost', () => {
    const near = buildGraph(grid(), 60);
    // Squares 2 and 8 are 40 m away corner to corner, so they're reachable too.
    expect(near.travel[9].map(e => e.to).sort()).toEqual([2, 5, 8]);
    expect(near.travel[9].find(e => e.to === 5)!.cost).toBeCloseTo(5 * 140);
    expect(buildGraph(grid(), 20).travel[9]).toEqual([]);
  });

  it('finds shortest travel distances', () => {
    const d = travelFrom(buildGraph(grid(), 60), [0]);
    expect(d[8]).toBeCloseTo(400);
    expect(d[9]).toBeCloseTo(300 + 700);
  });
});

describe('isWide', () => {
  it('tells a park from a sliver', () => {
    expect(isWide(rect(0, 0, 200, 200))).toBe(true);
    expect(isWide(rect(0, 0, 60, 400))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import type { MultiPolygon } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { BLOCKED, buildGrid, cellOf, LAND, markRoad, RIVER, stepCost, type GridInput } from './grid.js';

const P = { maxGrade: 0.08, roadWidth: 25, usableWidth: 60 };
const E = 0, N = Math.PI / 2; // headings: +x, +z

function grid(over: Partial<GridInput> = {}) {
  return buildGrid({ bounds: { minX: 0, minZ: 0, size: 400 }, elevAt: () => 0, kindAt: () => LAND, districts: [], ...over }, 10);
}
const step = (g: ReturnType<typeof grid>, x: number, z: number, h: number) => {
  const a = cellOf(g, x, z), b = cellOf(g, x + 10 * Math.round(Math.cos(h)), z + 10 * Math.round(Math.sin(h)));
  return stepCost(g, a, b, h, P);
};

describe('stepCost', () => {
  it('costs a flat step its length', () => {
    expect(step(grid(), 105, 105, E)).toBeCloseTo(10);
  });

  it('measures grade along the heading', () => {
    const g = grid({ elevAt: (_x, z) => 0.2 * z });
    const up = step(g, 105, 105, N), along = step(g, 105, 105, E);
    expect(up).toBeGreaterThan(along);
    expect(Number.isFinite(up)).toBe(true);
  });

  it('rises gently below Max grade and steeply above it, but never infinitely', () => {
    const at = (grade: number) => step(grid({ elevAt: x => grade * x }), 105, 105, E);
    expect(at(0.04)).toBeLessThan(2 * at(0));
    expect(at(0.16)).toBeGreaterThan(5 * at(0));
    expect(Number.isFinite(at(1))).toBe(true);
  });

  it('blocks the sea and charges for the river, most when not crossing straight', () => {
    expect(step(grid({ kindAt: x => (x > 200 ? BLOCKED : LAND) }), 205, 105, E)).toBe(Infinity);
    const river: MultiPolygon = rect(180, 0, 220, 400); // runs along z, so crossing is along x
    const g = grid({ kindAt: x => (x > 180 && x < 220 ? RIVER : LAND), river });
    expect(step(g, 195, 105, E)).toBeGreaterThanOrEqual(20 * 10);
    expect(step(g, 195, 105, N)).toBeGreaterThan(step(g, 195, 105, E));
  });

  it('makes district borders corridors: on them or clear of them', () => {
    const g = grid({ districts: [rect(0, 0, 200, 400), rect(200, 0, 400, 400)] });
    const along = step(g, 195, 105, N), inside = step(g, 85, 105, N);
    const parallelNear = step(g, 175, 105, N), crossing = step(g, 175, 105, E);
    expect(along).toBeLessThanOrEqual(0.7 * inside);
    expect(parallelNear).toBeGreaterThan(along);
    expect(parallelNear).toBeGreaterThan(crossing);
  });

  it('keeps new roads from running alongside placed ones', () => {
    const g = grid();
    const before = step(g, 135, 105, N);
    markRoad(g, [[100, 0], [100, 400]]);
    expect(step(g, 135, 105, N)).toBeGreaterThan(before);
    expect(step(g, 135, 105, E)).toBeCloseTo(before, 5); // crossing towards it is fine
  });
});

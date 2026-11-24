import { describe, it, expect } from 'vitest';
import type { MultiPolygon } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { BLOCKED, buildGrid, cellOf, LAND, markRoad, RIVER, stepCost, WILD, type GridInput } from './grid.js';

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
  it('charges more to cross Undeveloped land', () => {
    expect(step(grid({ kindAt: () => WILD }), 105, 105, E)).toBeGreaterThan(2 * step(grid(), 105, 105, E));
  });

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
    expect(along).toBeLessThanOrEqual(0.9 * inside);
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

describe('grid fixes', () => {
  it('ignores border segments it is told to skip (the site edge)', () => {
    const g = grid({ districts: [rect(0, 0, 400, 400)], skipSegment: (a, b) => a[0] === b[0] || a[1] === b[1] });
    expect(g.border[cellOf(g, 5, 200)]).toBe(Infinity);
  });

  it('makes running along a water bank cost, but not crossing it', () => {
    const river: MultiPolygon = rect(180, 0, 220, 400);
    const g = grid({ kindAt: x => (x > 180 && x < 220 ? RIVER : LAND), river, water: river });
    const along = step(g, 165, 105, N), across = step(g, 165, 105, E), inland = step(g, 85, 105, N);
    expect(along).toBeGreaterThan(1.5 * inland);
    expect(across).toBeLessThan(along);
  });

  it('rasterises kinds and surfaces to the same answers as point lookups', () => {
    const kinds = [{ footprint: rect(0, 0, 400, 400), kind: LAND }, { footprint: rect(100, 100, 200, 300), kind: BLOCKED }];
    const ground = { points: [[0, 0, 0], [400, 0, 40], [400, 400, 40], [0, 400, 0]] as [number, number, number][], triangles: [[0, 1, 2], [0, 2, 3]] as [number, number, number][] };
    const fast = grid({ kinds, surfaces: [ground] });
    const slow = grid({ kindAt: (x, z) => (x > 100 && x < 200 && z > 100 && z < 300 ? BLOCKED : LAND), elevAt: x => 0.1 * x });
    for (const [x, z] of [[55, 55], [155, 205], [305, 15], [395, 395]] as [number, number][]) {
      const c = cellOf(fast, x, z);
      expect(fast.kind[c], `${x},${z}`).toBe(slow.kind[c]);
      expect(fast.elev[c]).toBeCloseTo(slow.elev[c], 4);
    }
  });
});

describe('buildGrid', () => {
  it('records where the nearest district border is, so a road can move onto it', () => {
    const g = grid({ districts: [rect(0, 0, 200, 400), rect(200, 0, 400, 400)] });
    const c = cellOf(g, 175, 105);
    expect(g.borderFootX[c]).toBeCloseTo(200);
    expect(g.borderFootZ[c]).toBeCloseTo(105);
  });

  it('measures the distance to Undeveloped land, zero inside it', () => {
    const g = buildGrid({ bounds: { minX: 0, minZ: 0, size: 400 }, elevAt: () => 0, kindAt: () => LAND, districts: [], wild: [rect(200, 0, 400, 400)] }, 10, { wildReach: 100 });
    expect(g.wild[cellOf(g, 255, 105)]).toBe(0);
    expect(g.wild[cellOf(g, 155, 105)]).toBeCloseTo(45);
    expect(g.wild[cellOf(g, 55, 105)]).toBe(Infinity);
  });
});

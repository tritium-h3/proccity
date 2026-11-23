import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { BLOCKED, buildGrid, cellOf, LAND, RIVER, type GridInput } from './grid.js';
import { route } from './route.js';

const params = { maxGrade: 0.08, roadWidth: 25, usableWidth: 60 };
const grid = (over: Partial<GridInput> = {}) => buildGrid({ bounds: { minX: 0, minZ: 0, size: 400 }, elevAt: () => 0, kindAt: () => LAND, districts: [], ...over }, 10);
const length = (p: Point2[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);

describe('route', () => {
  it('goes nearly straight on flat ground', () => {
    const g = grid();
    const p = route(g, [25, 25], { params, goal: { cell: cellOf(g, 375, 305) } })!;
    expect(length(p)).toBeLessThanOrEqual(1.08 * Math.hypot(350, 280));
  });

  it('goes round a steep ridge through its gap', () => {
    const g = grid({ elevAt: (x, z) => (z < 300 ? 0.3 * Math.max(0, 100 - Math.abs(x - 200)) : 0) });
    const p = route(g, [50, 100], { params, goal: { cell: cellOf(g, 350, 100) } })!;
    expect(Math.max(...p.map(q => q[1]))).toBeGreaterThanOrEqual(300);
  });

  it('gives up at an unbroken wall', () => {
    const g = grid({ kindAt: x => (x > 190 && x < 210 ? BLOCKED : LAND) });
    expect(route(g, [50, 100], { params, goal: { cell: cellOf(g, 350, 100) } })).toBeNull();
  });

  it('crosses a river once, short and square', () => {
    const g = grid({ kindAt: x => (x > 180 && x < 220 ? RIVER : LAND), river: rect(180, 0, 220, 400) });
    const p = route(g, [50, 105], { params, goal: { cell: cellOf(g, 350, 305) } })!;
    let wet = 0, entries = 0, was = false;
    for (let i = 0; i + 1 < p.length; i++) for (let t = 0; t < 1; t += 0.01) {
      const x = p[i][0] + (p[i + 1][0] - p[i][0]) * t;
      const inside = x > 180 && x < 220;
      if (inside) wet += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) * 0.01;
      if (inside && !was) entries++;
      was = inside;
    }
    expect(entries).toBe(1);
    expect(wet).toBeLessThanOrEqual(1.3 * 40);
  });

  it('stops at the first cell that touches the goal', () => {
    const g = grid();
    const p = route(g, [50, 200], { params, goal: { touches: c => c % g.w >= 30 } })!;
    expect(p[p.length - 1][0]).toBeGreaterThanOrEqual(300);
    expect(p[p.length - 1][0]).toBeLessThan(320);
  });

  it('never turns more than 45° at once', () => {
    const g = grid({ elevAt: (x, z) => 0.05 * Math.hypot(x - 200, z - 200) });
    const p = route(g, [20, 20], { params, goal: { cell: cellOf(g, 380, 380) } })!;
    for (let i = 1; i + 1 < p.length; i++) {
      const a = Math.atan2(p[i][1] - p[i - 1][1], p[i][0] - p[i - 1][0]), b = Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]);
      let d = Math.abs(b - a); if (d > Math.PI) d = 2 * Math.PI - d;
      expect(d).toBeLessThanOrEqual(Math.PI / 4 + 1e-6);
    }
  });

  it('is deterministic', () => {
    const g = grid({ elevAt: (x, z) => 0.1 * Math.sin(x / 40) * z });
    const go = () => route(g, [20, 20], { params, goal: { cell: cellOf(g, 380, 200) } });
    expect(go()).toEqual(go());
  });
});

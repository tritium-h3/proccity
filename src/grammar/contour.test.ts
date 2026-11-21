import { describe, it, expect } from 'vitest';
import type { Point2, Ring } from '../doc/types.js';
import { chaikin, marchingSquares, simplify } from './contour.js';
import { area } from './polygon.js';

const grid = (cols: number, rows: number, f: (i: number, j: number) => number) => {
  const m = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) m[j * cols + i] = f(i, j);
  return m;
};

describe('marchingSquares', () => {
  it('traces a solid block as one polygon of about its area', () => {
    const m = grid(5, 5, (i, j) => (i >= 1 && i <= 3 && j >= 1 && j <= 3 ? 1 : 0));
    const mp = marchingSquares(m, 5, 5, 0.5, [0, 0], 1);
    expect(mp).toHaveLength(1);
    expect(area(mp)).toBeGreaterThan(9 * 0.8 - 1); // iso-line sits half a cell outside the 2x2-cell core
    expect(area(mp)).toBeLessThan(9 * 1.2);
  });

  it('traces a ring as one polygon with one hole', () => {
    const m = grid(9, 9, (i, j) => { const d = Math.max(Math.abs(i - 4), Math.abs(j - 4)); return d >= 2 && d <= 3 ? 1 : 0; });
    const mp = marchingSquares(m, 9, 9, 0.5, [0, 0], 1);
    expect(mp).toHaveLength(1);
    expect(mp[0]).toHaveLength(2);
  });

  it('closes shapes touching the grid edge', () => {
    const m = grid(4, 4, () => 1);
    const mp = marchingSquares(m, 4, 4, 0.5, [10, 20], 2);
    expect(mp).toHaveLength(1);
    expect(area(mp)).toBeGreaterThan(6 * 6 - 0.1);
  });
});

describe('simplify', () => {
  it('drops near-collinear points', () => {
    const ring: Ring = [];
    for (let i = 0; i < 25; i++) ring.push([i * 4, (i % 2) * 0.3]);
    for (let i = 0; i < 25; i++) ring.push([100, i * 4]);
    for (let i = 0; i < 25; i++) ring.push([100 - i * 4, 100]);
    for (let i = 0; i < 25; i++) ring.push([0, 100 - i * 4]);
    const s = simplify(ring, 2);
    expect(s.length).toBeLessThanOrEqual(8);
    expect(area([[s]])).toBeCloseTo(10000, -2);
  });
});

describe('chaikin', () => {
  it('keeps endpoints and roughly doubles the points per pass', () => {
    const line: Point2[] = [[0, 0], [10, 0], [10, 10]];
    const once = chaikin(line, 1);
    expect(once[0]).toEqual([0, 0]);
    expect(once.at(-1)).toEqual([10, 10]);
    expect(once).toHaveLength(2 * 2 + 2);
    expect(chaikin(line, 3).length).toBeGreaterThan(once.length * 3);
  });
});

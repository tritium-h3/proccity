import { describe, it, expect } from 'vitest';
import type { GroundSurface } from '../../doc/types.js';
import { triangleArea } from '../../doc/ground.js';
import { decimate } from './decimate.js';

/** An n×n grid of points over a square of side `s`, heights from `h`, split into triangles. */
function grid(n: number, s: number, h: (x: number, z: number) => number): GroundSurface {
  const points: [number, number, number][] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { const x = i * s / n, z = j * s / n; points.push([x, z, h(x, z)]); }
  const triangles: [number, number, number][] = [];
  const id = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    triangles.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)], [id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
  }
  return { points, triangles };
}

/** Height of a surface at (x, z), or null outside it. */
function heightAt(g: GroundSurface, x: number, z: number): number | null {
  for (const [a, b, c] of g.triangles) {
    const [ax, az, ay] = g.points[a], [bx, bz, by] = g.points[b], [cx, cz, cy] = g.points[c];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) return u * ay + v * by + (1 - u - v) * cy;
  }
  return null;
}

const boundaryKeys = (g: GroundSurface) => {
  const count = new Map<string, number>();
  for (const t of g.triangles) for (let k = 0; k < 3; k++) {
    const a = t[k], b = t[(k + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
    count.set(key, (count.get(key) ?? 0) + 1);
  }
  const keys = new Set<string>();
  for (const [key, c] of count) if (c === 1) for (const i of key.split(',').map(Number)) keys.add(`${g.points[i][0]},${g.points[i][1]}`);
  return keys;
};

describe('decimate', () => {
  it('reduces a level surface to its boundary, exactly', () => {
    const g = grid(8, 80, () => 12);
    const d = decimate(g, 0.01);
    expect(d.points.length).toBe(32); // the boundary ring only
    expect(triangleArea(d)).toBeCloseTo(6400, 6);
    for (const p of d.points) expect(p[2]).toBe(12);
  });

  it('also removes points on a sloping plane', () => {
    const d = decimate(grid(8, 80, (x, z) => 0.1 * x + 0.05 * z), 0.01);
    expect(d.points.length).toBe(32);
  });

  it('never moves the surface by more than the tolerance, even after many removals', () => {
    const h = (x: number, z: number) => 3 * Math.sin(x / 25) * Math.cos(z / 30);
    const g = grid(16, 160, h);
    const d = decimate(g, 0.2);
    expect(d.triangles.length).toBeLessThan(g.triangles.length);
    for (const p of g.points) expect(Math.abs(heightAt(d, p[0], p[1])! - p[2])).toBeLessThanOrEqual(0.2 + 1e-9);
    expect(triangleArea(d)).toBeCloseTo(160 * 160, 6);
  });

  it('keeps every boundary vertex, so neighbouring regions still meet exactly', () => {
    const g = grid(8, 80, (x, z) => (x * z) / 100);
    const d = decimate(g, 0.5);
    const before = boundaryKeys(g), after = new Set(d.points.map(p => `${p[0]},${p[1]}`));
    for (const k of before) expect(after.has(k), k).toBe(true);
  });

  it('keeps the points it is told to keep', () => {
    const g = grid(4, 40, () => 5);
    const d = decimate(g, 0.01, new Set(['20,20']));
    expect(d.points.some(p => p[0] === 20 && p[1] === 20)).toBe(true);
  });
});

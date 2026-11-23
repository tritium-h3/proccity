import { describe, it, expect } from 'vitest';
import type { MultiPolygon } from '../doc/types.js';
import { area, bounds, containsPoint, rect, simplifyLine } from './polygon.js';

const withHole: MultiPolygon = [[
  [[0, 0], [10, 0], [10, 10], [0, 10]],
  [[4, 4], [4, 6], [6, 6], [6, 4]],
]];

describe('polygon helpers', () => {
  it('measures area', () => {
    expect(area(rect(0, 0, 10, 20))).toBe(200);
  });
  it('subtracts holes from area', () => {
    expect(area(withHole)).toBe(96);
  });
  it('treats points in holes as outside', () => {
    expect(containsPoint(withHole, [2, 2])).toBe(true);
    expect(containsPoint(withHole, [5, 5])).toBe(false);
    expect(containsPoint(withHole, [20, 5])).toBe(false);
  });
  it('computes bounds', () => {
    expect(bounds(rect(-1, -2, 3, 4))).toEqual({ minX: -1, minZ: -2, maxX: 3, maxZ: 4 });
  });
});

describe('simplifyLine (Douglas–Peucker)', () => {
  it('drops points within the tolerance and keeps the ends', () => {
    const line: [number, number][] = [[0, 0], [10, 0.2], [20, -0.3], [30, 0], [30, 10]];
    expect(simplifyLine(line, 0.5)).toEqual([[0, 0], [30, 0], [30, 10]]);
  });

  it('keeps points beyond the tolerance', () => {
    const line: [number, number][] = [[0, 0], [10, 2], [20, 0]];
    expect(simplifyLine(line, 0.5)).toEqual(line);
  });

  it('keeps a smooth curve within the tolerance everywhere', () => {
    const arc: [number, number][] = Array.from({ length: 200 }, (_, i) => [100 * Math.cos(i / 199 * Math.PI), 100 * Math.sin(i / 199 * Math.PI)]);
    const s = simplifyLine(arc, 0.5);
    expect(s.length).toBeLessThan(40);
    const dist = (p: [number, number]) => Math.min(...s.slice(1).map((b, k) => {
      const a = s[k], dx = b[0] - a[0], dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]);
    }));
    for (const p of arc) expect(dist(p)).toBeLessThanOrEqual(0.5 + 1e-9);
  });
});

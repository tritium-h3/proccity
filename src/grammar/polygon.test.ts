import { describe, it, expect } from 'vitest';
import type { MultiPolygon } from '../doc/types.js';
import { area, bounds, containsPoint, rect } from './polygon.js';

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

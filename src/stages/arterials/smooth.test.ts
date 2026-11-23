import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { smoothRoad, tightBends } from './smooth.js';

describe('smoothRoad', () => {
  it('rounds a corner to the curve radius, keeping the ends', () => {
    const line: Point2[] = [[-200, 0], [0, 0], [0, 200]];
    const s = smoothRoad(line, 60);
    expect(s[0]).toEqual([-200, 0]);
    expect(s[s.length - 1]).toEqual([0, 200]);
    expect(tightBends(s, 60)).toBe(0);
    expect(s.length).toBeGreaterThan(3);
  });

  it('drops jitter', () => {
    const zig: Point2[] = Array.from({ length: 21 }, (_, i) => [i * 20, i % 2 ? 1 : -1] as Point2);
    expect(smoothRoad(zig, 60).length).toBeLessThan(zig.length);
  });

  it('shrinks the arc where the legs are too short, and that shows as a tight bend', () => {
    const s = smoothRoad([[-15, 0], [0, 0], [0, 15]], 60);
    expect(tightBends(s, 60)).toBeGreaterThan(0);
  });
});

describe('tightBends', () => {
  it('counts sharp corners', () => {
    expect(tightBends([[-10, 0], [0, 0], [0, 10]], 60)).toBe(1);
    expect(tightBends([[0, 0], [100, 0], [200, 0]], 60)).toBe(0);
  });
});

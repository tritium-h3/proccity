import { describe, it, expect } from 'vitest';
import type { Point2 } from '../doc/types.js';
import { chaikin } from './contour.js';

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

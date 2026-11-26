import { describe, expect, it } from 'vitest';
import { area, rect } from '../../grammar/polygon.js';
import { chordThrough, obb, splitBy, thickness } from './geometry.js';

describe('block geometry', () => {
  it('finds the oriented bounding box', () => {
    const b = obb(rect(0, 0, 200, 50));
    expect(b.long).toBeCloseTo(200, 3);
    expect(b.short).toBeCloseTo(50, 3);
    expect(Math.abs(Math.sin(b.axis))).toBeLessThan(1e-6);
    expect(b.centre[0]).toBeCloseTo(100, 3);
    const t = obb([[[[0, 0], [100, 100], [80, 120], [-20, 20]]]]);
    expect(t.long).toBeCloseTo(Math.hypot(100, 100), 3);
    expect(t.short).toBeCloseTo(Math.hypot(20, 20), 3);
  });

  it('measures thickness', () => {
    expect(thickness(rect(0, 0, 100, 100))).toBeCloseTo(50, 6);
  });

  it('finds the chord through a point', () => {
    const c = chordThrough(rect(0, 0, 200, 100), [50, 50], [0, 1])!;
    expect(c.map(p => p[1]).sort((a, b) => a - b)).toEqual([0, 100]);
    expect(chordThrough(rect(0, 0, 200, 100), [500, 50], [0, 1])).toBeNull();
    // A U shape: the chord through one arm stops at the gap.
    const u: [number, number][] = [[0, 0], [300, 0], [300, 100], [200, 100], [200, 50], [100, 50], [100, 100], [0, 100]];
    const cu = chordThrough([[u]], [50, 75], [1, 0])!;
    expect(cu.map(p => p[0]).sort((a, b) => a - b)).toEqual([0, 100]);
  });

  it('splits a piece by a road band', () => {
    const r = splitBy(rect(0, 0, 200, 100), [[100, 0], [100, 100]], 12)!;
    expect(r).not.toBeNull();
    const [strip, a, b] = r;
    expect(area(strip)).toBeCloseTo(1200, 0);
    expect(area(a)).toBeCloseTo(9400, 0);
    expect(area(b)).toBeCloseTo(9400, 0);
  });

  it('refuses a line that does not cross the piece', () => {
    expect(splitBy(rect(0, 0, 200, 100), [[300, 0], [300, 100]], 12)).toBeNull();
    expect(splitBy(rect(0, 0, 200, 100), [[100, 0], [100, 50]], 12)).toBeNull();
  });
});

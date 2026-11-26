import { describe, expect, it } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { lineDiff, makeField } from './field.js';
import type { HeightRaster } from './height.js';
import { traceCut } from './trace.js';

/** Ground rising along z at `s` (rise per metre). */
const plane = (s: number): HeightRaster => ({ at: (_x, z) => z * s, smoothAt: (_x, z) => z * s, slope: () => [0, s] });
const deg = (r: number) => (r * 180) / Math.PI;

describe('direction field', () => {
  it('keeps the planned direction on flat ground', () => {
    expect(makeField(plane(0), 'dense', 0.1)([0, 0], 0.3)).toBeCloseTo(0.3, 9);
  });

  it('bends a dense cut a little to keep under the grade, else snaps to the contour grid', () => {
    const f = makeField(plane(0.15), 'dense', 0.1);
    // 50° off the contour needs an 8° turn: bent to exactly the limit.
    const a = f([0, 0], (50 * Math.PI) / 180);
    expect(0.15 * Math.abs(Math.sin(a))).toBeCloseTo(0.1, 6);
    // Straight up the slope would need 48°: it stays on the fall line (square blocks, steep street).
    expect(Math.abs(deg(lineDiff(f([0, 0], Math.PI / 2), Math.PI / 2)))).toBeLessThan(1e-6);
    // 80° off (a 38° turn) snaps to the fall line too; 30° off is already gentle and unchanged.
    expect(Math.abs(deg(lineDiff(f([0, 0], (80 * Math.PI) / 180), Math.PI / 2)))).toBeLessThan(1e-6);
    expect(f([0, 0], 0.1)).toBeCloseTo(0.1, 9);
  });

  it('swings a sparse cut onto the nearer contour family', () => {
    const f = makeField(plane(0.05), 'sparse', 0.1);
    expect(Math.abs(deg(lineDiff(f([0, 0], 0.5), 0)))).toBeLessThan(5); // to the contour
    expect(Math.abs(deg(lineDiff(f([0, 0], 1.2), Math.PI / 2)))).toBeLessThan(5); // straight up, gentle enough
  });
});

describe('traced cuts', () => {
  it('runs straight across a piece in a uniform field, ending on the outline', () => {
    const line = traceCut(rect(0, 0, 400, 200), () => Math.PI / 2, [200, 100], Math.PI / 2, 10, 1000)!;
    expect(line).not.toBeNull();
    const zs = line.map(p => p[1]);
    expect(Math.min(...zs)).toBeCloseTo(0, 3);
    expect(Math.max(...zs)).toBeCloseTo(200, 3);
    expect(line.every((p: Point2) => Math.abs(p[0] - 200) < 1e-6)).toBe(true);
  });

  it('refuses a streamline that circles', () => {
    const swirl = (p: Point2) => Math.atan2(p[1] - 500, p[0] - 500) + Math.PI / 2;
    expect(traceCut(rect(0, 0, 1000, 1000), swirl, [700, 500], Math.PI / 2, 10, 10000)).toBeNull();
  });
});

describe('very steep ground', () => {
  it('runs a line up a slope steeper than the hard limit on the diagonal at that limit', () => {
    const f = makeField(plane(0.35), 'dense', 0.1, 0.3);
    const a = f([0, 0], Math.PI / 2);
    expect(0.35 * Math.abs(Math.sin(a))).toBeCloseTo(0.3, 6);
  });
});

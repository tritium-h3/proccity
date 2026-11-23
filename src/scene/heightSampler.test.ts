import { describe, it, expect } from 'vitest';
import { heightSampler } from './heightSampler.js';

describe('heightSampler', () => {
  it('matches a plane exactly', () => {
    // Two triangles over 0..400 (x, y, z in three.js order), height = 0.1x + 0.05z.
    const h = (x: number, z: number) => 0.1 * x + 0.05 * z;
    const pos = [0, h(0, 0), 0, 400, h(400, 0), 0, 400, h(400, 400), 400, 0, h(0, 400), 400];
    const at = heightSampler(pos, [0, 1, 2, 0, 2, 3], { minX: 0, minZ: 0, size: 400 }, 10);
    for (const [x, z] of [[17, 33], [200, 200], [391, 5], [5, 391]]) expect(at(x, z)).toBeCloseTo(h(x, z), 6);
  });

  it('clamps outside the covered area', () => {
    const pos = [0, 5, 0, 100, 5, 0, 100, 5, 100, 0, 5, 100];
    const at = heightSampler(pos, [0, 1, 2, 0, 2, 3], { minX: 0, minZ: 0, size: 100 }, 10);
    expect(at(-50, 50)).toBeCloseTo(5);
  });
});

import { describe, expect, it } from 'vitest';
import { createSite } from '../../doc/create.js';
import type { RegionNode } from '../../doc/types.js';
import { makeSlab } from '../../grammar/slab.js';
import { rect } from '../../grammar/polygon.js';
import { heightRaster } from './height.js';

describe('height raster', () => {
  it('fills from the terrain triangles: a plane rising 10% along z', () => {
    const site = createSite(2000);
    const pts: [number, number, number][] = [[-1000, -1000, -100], [1000, -1000, -100], [1000, 1000, 100], [-1000, 1000, 100]];
    const flat: RegionNode = { id: 'site/flat:0', name: 'flat:0', kind: 'flat', stage: 'terrain', geometry: makeSlab(rect(-1000, -1000, 1000, 1000)), attrs: {}, children: [], data: { ground: { points: pts, triangles: [[0, 1, 2], [0, 2, 3]] } } };
    const h = heightRaster({ ...site, children: [flat] }, 20);
    expect(h.at(123, 456)).toBeCloseTo(45.6, 1);
    const [gx, gz] = h.slope(-300, 200);
    expect(gx).toBeCloseTo(0, 6);
    expect(gz).toBeCloseTo(0.1, 6);
  });
});

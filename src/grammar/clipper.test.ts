import { describe, it, expect } from 'vitest';
import type { MultiPolygon } from '../doc/types.js';
import { difference, intersect, union } from './clipper.js';
import { area } from './polygon.js';

describe('ring nesting', () => {
  it('keeps a cut-out a hole of the right outer (corners on edges without vertices)', () => {
    // A long river with vertices only at its ends, minus a crossing whose corners sit exactly on
    // its banks: the PolyTree once placed the cut-out ring beside the river, not under it.
    const river: MultiPolygon = [[[[0, 0], [4000, 0], [4000, 150], [0, 150]]]];
    const bridge: MultiPolygon = [[[[1990, 0], [2015, 0], [2015, 150], [1990, 150]]]];
    const water = difference(river, bridge);
    expect(area(water)).toBeCloseTo(area(river) - area(bridge), 3);
    expect(area(intersect(water, bridge))).toBeLessThan(1e-6);
  });

  it('nests islands inside holes as their own outers', () => {
    const outer: MultiPolygon = [[[[0, 0], [100, 0], [100, 100], [0, 100]], [[20, 20], [20, 80], [80, 80], [80, 20]]]];
    const island: MultiPolygon = [[[[40, 40], [60, 40], [60, 60], [40, 60]]]];
    const u = union(outer, island);
    expect(area(u)).toBeCloseTo(10000 - 3600 + 400, 6);
    expect(u).toHaveLength(2);
  });
});

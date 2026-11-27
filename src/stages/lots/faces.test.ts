import { describe, expect, it } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { RoadIndex } from '../blocks/roads.js';
import { edgesOf, frontOf } from './faces.js';

// A block [0,100] × [0,50] with an arterial (25 m) to the south and a local road (12 m) to the east;
// the lot is its eastern half; the western half is another lot; north of the block is open land.
const roads = new RoadIndex();
roads.add({ points: [[-50, -12.5], [150, -12.5]], category: 'A', half: 12.5 });
roads.add({ points: [[106, -50], [106, 100]], category: 'L', half: 6 });
const lot = rect(50, 0, 100, 50);
const inBlock = (p: Point2) => (p[0] >= 0 && p[0] < 50 && p[1] >= 0 && p[1] <= 50 ? 'lot' as const : null);

describe('lot faces', () => {
  it('records each side’s road category, a neighbour lot, or open land, in ring order', () => {
    // rect() runs (50,0) → (100,0) → (100,50) → (50,50): south, east, north, west.
    expect(edgesOf(lot, roads, inBlock)).toBe('ALo-');
  });
  it('fronts on the allowed road it runs along furthest', () => {
    expect(frontOf(lot, roads, ['L', 'C'])).toBe('L');
    expect(frontOf(lot, roads, ['C', 'A'])).toBe('A');
    expect(frontOf(lot, roads, ['C'])).toBeNull();
  });
  it('finds a short allowed stretch on a side that is mostly another road', () => {
    // One side, mostly along the arterial, ends with 10 m along a collector.
    const r = new RoadIndex();
    r.add({ points: [[-50, -12.5], [80, -12.5]], category: 'A', half: 12.5 });
    r.add({ points: [[80, -9], [150, -9]], category: 'C', half: 9 });
    expect(frontOf(rect(0, 0, 90, 40), r, ['C', 'L'])).toBe('C');
  });
});

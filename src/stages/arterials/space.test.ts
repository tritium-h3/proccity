import { describe, it, expect } from 'vitest';
import { offsetPolyline } from '../../grammar/clipper.js';
import { rect } from '../../grammar/polygon.js';
import { slivers } from './space.js';

const district = rect(0, 0, 250, 250);

describe('slivers', () => {
  it('passes a road through the middle', () => {
    expect(slivers(district, offsetPolyline([[125, -10], [125, 260]], 12.5), 60)).toEqual([]);
  });

  it('flags a road that leaves a strip by the edge', () => {
    expect(slivers(district, offsetPolyline([[42, -10], [42, 260]], 12.5), 60)).toHaveLength(1);
  });

  it('ignores a road along the outside edge', () => {
    expect(slivers(district, offsetPolyline([[-12.5, -10], [-12.5, 260]], 12.5), 60)).toEqual([]);
  });
});

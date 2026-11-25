import { describe, it, expect } from 'vitest';
import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { cutPiece, districtsIn, junctions, loopsOf } from './loops.js';

const W = 25, USABLE = 300;
// A 2×2 grid of 2 km districts around the origin.
const grid: MultiPolygon[] = [rect(-2000, -2000, 0, 0), rect(0, -2000, 2000, 0), rect(-2000, 0, 0, 2000), rect(0, 0, 2000, 2000)];
const square = (x0: number, z0: number, x1: number, z1: number): Point2[][] => [
  [[x0 - 100, z0], [x1 + 100, z0]], [[x1, z0 - 100], [x1, z1 + 100]],
  [[x1 + 100, z1], [x0 - 100, z1]], [[x0, z1 + 100], [x0, z0 - 100]],
];

describe('loops', () => {
  it('finds the hole a square of roads closes', () => {
    const holes = loopsOf(square(500, 500, 1500, 1500), W);
    expect(holes).toHaveLength(1);
  });

  it('a loop inside one district spans one; one round the grid\'s middle corner spans four', () => {
    expect(districtsIn(loopsOf(square(500, 500, 1500, 1500), W)[0], grid, USABLE)).toEqual([3]);
    expect(districtsIn(loopsOf(square(-1000, -1000, 1000, 1000), W)[0], grid, USABLE)).toEqual([0, 1, 2, 3]);
  });

  it('a strip a road strays into is not counted', () => {
    // 100 m over the border into district 2 (x < 0): less than half the Usable width deep.
    expect(districtsIn(loopsOf(square(-100, 500, 1500, 1500), W)[0], grid, USABLE)).toEqual([3]);
  });

  it('finds crossings, tees and self-crossings along a road', () => {
    const road: Point2[] = [[0, 0], [1000, 0]];
    expect(junctions(road, [[[300, -100], [300, 100]], [[700, 10], [700, 300]]], W).map(Math.round)).toEqual([300, 700]);
    // A road crossing itself: the junction is at both passes.
    const knot: Point2[] = [[0, 0], [1000, 0], [1000, 500], [500, 500], [500, -500]];
    expect(junctions(knot, [], W).map(Math.round)).toEqual([500, 2500]);
  });

  it('cuts a piece out of a road', () => {
    const road: Point2[] = [[0, 0], [1000, 0]];
    expect(cutPiece(road, 300, 700)).toEqual([[[0, 0], [300, 0]], [[700, 0], [1000, 0]]]);
    expect(cutPiece(road, 0, 300)).toEqual([[[300, 0], [1000, 0]]]);
  });
});

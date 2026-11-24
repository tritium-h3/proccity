import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { placeOnBorder, sharedBorder } from './gateways.js';

const len = (l: Point2[]) => l.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - l[i][0], q[1] - l[i][1]), 0);
const flat = () => 0;

describe('sharedBorder', () => {
  it('finds the common edge of two adjacent squares', () => {
    const lines = sharedBorder(rect(0, 0, 100, 100), rect(100, 0, 200, 100), 1);
    expect(lines).toHaveLength(1);
    expect(len(lines[0])).toBeCloseTo(100);
    for (const p of lines[0]) expect(p[0]).toBeCloseTo(100);
  });

  it('finds the part they share when one is longer', () => {
    const lines = sharedBorder(rect(0, 0, 100, 300), rect(100, 100, 200, 200), 1);
    expect(lines).toHaveLength(1);
    // a's edge x = 100 runs 0..300 as one segment; only the shared stretch counts.
    expect(len(lines[0])).toBeCloseTo(100);
  });

  it('finds nothing for squares that only meet at a corner', () => {
    expect(sharedBorder(rect(0, 0, 100, 100), rect(100, 100, 200, 200), 1)).toEqual([]);
  });
});

describe('placeOnBorder', () => {
  const line: Point2[] = [[0, 0], [1000, 0]];
  it('keeps the margin from both ends and gives the normal', () => {
    const g = placeOnBorder(line, { margin: 300, score: p => -Math.abs(p[0] - 500), avoid: [], minGap: 0 })!;
    expect(g.at[0]).toBeGreaterThanOrEqual(300);
    expect(g.at[0]).toBeLessThanOrEqual(700);
    expect(Math.abs(g.normal[1])).toBeCloseTo(1);
    expect(g.crowded).toBe(false);
  });

  it('prefers the lowest score', () => {
    const g = placeOnBorder(line, { margin: 100, score: p => Math.abs(p[0] - 640), avoid: [], minGap: 0 })!;
    expect(Math.abs(g.at[0] - 640)).toBeLessThanOrEqual(25); // sampled every margin/4
  });

  it('keeps the gap from gateways already placed', () => {
    const g = placeOnBorder(line, { margin: 100, score: flat, avoid: [[300, 0]], minGap: 500 })!;
    expect(g.at[0]).toBeGreaterThanOrEqual(800);
    expect(g.crowded).toBe(false);
  });

  it('says so when there is no room for the gap', () => {
    const g = placeOnBorder(line, { margin: 100, score: flat, avoid: [[500, 0]], minGap: 2000 })!;
    expect(g.crowded).toBe(true);
  });

  it('stays off bends', () => {
    const bent: Point2[] = [[0, 0], [500, 0], [1000, 400]];
    const g = placeOnBorder(bent, { margin: 100, score: p => Math.abs(p[0] - 500), avoid: [], minGap: 0, straight: 100 })!;
    expect(Math.hypot(g.at[0] - 500, g.at[1])).toBeGreaterThanOrEqual(99);
  });

  it('gives up on a border too short for its margins', () => {
    expect(placeOnBorder([[0, 0], [150, 0]], { margin: 100, score: flat, avoid: [], minGap: 0 })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { checkPartition } from '../../grammar/partition.js';
import { area, rect } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import { obb } from '../blocks/geometry.js';
import { cutBlock } from './cut.js';

// Allowed roads along chosen sides of the box [0, w] × [0, h]: points within 0.5 m of that side.
const sides = (w: number, h: number, which: ('S' | 'N' | 'W' | 'E')[]) => (p: Point2) =>
  (which.includes('S') && Math.abs(p[1]) < 0.5) || (which.includes('N') && Math.abs(p[1] - h) < 0.5)
  || (which.includes('W') && Math.abs(p[0]) < 0.5) || (which.includes('E') && Math.abs(p[0] - w) < 0.5);

/** Does the lot's outline touch an allowed road (sampled every metre)? */
function fronts(lot: MultiPolygon, allowed: (p: Point2) => boolean): boolean {
  for (const poly of lot) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    for (let k = 0; k < n; k++) if (allowed([a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n])) return true;
  }
  return false;
}
function partitions(block: MultiPolygon, out: { lots: MultiPolygon[]; open: MultiPolygon | null }) {
  const kids = [...out.lots, ...(out.open ? [out.open] : [])];
  expect(checkPartition(makeSlab(block), kids.map(k => makeSlab(k)), 1e-4).problems).toEqual([]);
}

describe('cutting a block into lots', () => {
  it('makes two rows of lots in a block with roads on both long sides', () => {
    const block = rect(0, 0, 100, 50), allowed = sides(100, 50, ['S', 'N']);
    const out = cutBlock(block, { target: { frontage: 12, depth: 24 }, allowed });
    partitions(block, out);
    expect(out.lots.length).toBeGreaterThanOrEqual(12);
    expect(out.lots.length).toBeLessThanOrEqual(20);
    for (const l of out.lots) {
      expect(fronts(l, allowed)).toBe(true);
      expect(obb(l).short).toBeLessThan(30); // a row, not the whole depth
    }
  });
  it('keeps one row where only one side has a road', () => {
    const block = rect(0, 0, 200, 50), allowed = sides(200, 50, ['S']);
    const out = cutBlock(block, { target: { frontage: 7, depth: 20 }, allowed });
    partitions(block, out);
    for (const l of out.lots) expect(fronts(l, allowed)).toBe(true);
    expect(out.lots.length).toBeGreaterThan(20);
  });
  it('leaves open ground in the middle of a very deep block', () => {
    const block = rect(0, 0, 300, 300), allowed = sides(300, 300, ['S', 'N', 'W', 'E']);
    const out = cutBlock(block, { target: { frontage: 12, depth: 24 }, allowed });
    partitions(block, out);
    expect(out.open).not.toBeNull();
    for (const l of out.lots) expect(fronts(l, allowed)).toBe(true);
  });
  it('keeps a big-lot block of ordinary size whole', () => {
    const block = rect(0, 0, 150, 70);
    const out = cutBlock(block, { target: { frontage: 160, depth: 70 }, allowed: sides(150, 70, ['S', 'N', 'W', 'E']) });
    expect(out.lots).toHaveLength(1);
  });
  it('keeps a lot with no other frontage whole rather than strand part of it', () => {
    // A road along a short stub of the west side only.
    const block = rect(0, 0, 100, 100);
    const allowed = (p: Point2) => Math.abs(p[0]) < 0.5 && p[1] < 15;
    const out = cutBlock(block, { target: { frontage: 12, depth: 24 }, allowed });
    for (const l of out.lots) expect(fronts(l, allowed)).toBe(true);
  });
  it('cuts an L-shaped block into single-polygon lots', () => {
    const block: MultiPolygon = [[[[0, 0], [120, 0], [120, 50], [50, 50], [50, 120], [0, 120]]]];
    const allowed = (p: Point2) => p[0] < 0.5 || p[1] < 0.5 || Math.abs(p[0] - 120) < 0.5 || Math.abs(p[1] - 120) < 0.5;
    const out = cutBlock(block, { target: { frontage: 12, depth: 24 }, allowed });
    partitions(block, out);
    for (const l of out.lots) { expect(l).toHaveLength(1); expect(area(l)).toBeGreaterThan(100); }
    expect(out.lots.length).toBeGreaterThan(10);
  });
});

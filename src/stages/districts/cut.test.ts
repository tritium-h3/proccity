import { describe, it, expect } from 'vitest';
import type { MultiPolygon } from '../../doc/types.js';
import { checkPartition } from '../../grammar/partition.js';
import { area, rect } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import { createRng } from '../../pipeline/seeds.js';
import { cutRegion } from './cut.js';

const L: MultiPolygon = [[[[0, 0], [400, 0], [400, 100], [100, 100], [100, 400], [0, 400]]]];

function expectGoodCut(fp: MultiPolygon, pieces: MultiPolygon[], k: number) {
  expect(pieces).toHaveLength(k);
  expect(checkPartition(makeSlab(fp), pieces.map(p => makeSlab(p))).problems).toEqual([]);
  const total = area(fp);
  expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(total, 0);
  for (const p of pieces) {
    expect(p).toHaveLength(1);
    expect(area(p)).toBeGreaterThanOrEqual(0.4 * total / k);
  }
}

describe('cutRegion', () => {
  it('returns the region whole for k = 1', () => {
    const fp = rect(0, 0, 100, 100);
    expect(cutRegion(fp, 1, createRng(1))).toEqual([fp]);
  });

  it('cuts a rectangle into k compact pieces', () => {
    const fp = rect(0, 0, 400, 200);
    expectGoodCut(fp, cutRegion(fp, 4, createRng(1)), 4);
  });

  it('keeps every piece of a concave region in one part', () => {
    for (const seed of [1, 2, 3, 4, 5]) expectGoodCut(L, cutRegion(L, 3, createRng(seed)), 3);
  });

  it('is deterministic', () => {
    expect(cutRegion(L, 3, createRng(7))).toEqual(cutRegion(L, 3, createRng(7)));
  });
});

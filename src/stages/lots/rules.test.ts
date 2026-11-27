import { describe, expect, it } from 'vitest';
import { ZONES } from '../blocks/rules.js';
import { BIG_LOT, lotTarget, minLot } from './rules.js';

describe('lot sizes', () => {
  it('scales a zone’s lot with the density step, both sides', () => {
    expect(lotTarget('LR', 9)).toEqual({ frontage: 12, depth: 24 });
    const r = lotTarget('LR', 1);
    expect(r.frontage).toBeCloseTo(24);
    expect(r.depth).toBeCloseTo(48);
  });
  it('gives big-lot zones a block-sized lot', () => {
    expect(lotTarget('UO', 9)).toEqual({ frontage: 160, depth: 70 });
    expect(BIG_LOT.has('MC')).toBe(true);
  });
  it('scales by the Lot size setting', () => {
    expect(lotTarget('HR', 9, 2)).toEqual({ frontage: 20, depth: 50 });
  });
  it('has a target for every zone, and a modest minimum even for big lots', () => {
    for (const z of ZONES) expect(lotTarget(z, 5).frontage, z).toBeGreaterThan(0);
    expect(minLot('UO', 9)).toEqual({ frontage: 30, depth: 30 });
    expect(minLot('LR', 9)).toEqual({ frontage: 12, depth: 24 });
  });
});

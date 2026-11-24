import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { createRng } from '../../pipeline/seeds.js';
import { pairGateways } from './inside.js';

// Gateways on a 400 m square's sides, centred on the origin; perimeter position measured
// anticlockwise from the east side's middle.
const at = (deg: number): { at: Point2; perim: number } => ({ at: [200 * Math.cos((deg * Math.PI) / 180), 200 * Math.sin((deg * Math.PI) / 180)], perim: (deg / 360) * 1600 });
const base = { borderShare: 0, eligible: () => true, rng: createRng(1), star: false };
const key = (p: [number, number]) => [...p].sort().join('-');

describe('pairGateways', () => {
  it('pairs two gateways', () => {
    expect(pairGateways([at(0), at(180)], [0, 0], 1600, base).through.map(key)).toEqual(['0-1']);
  });

  it('pairs opposite gateways across, so four make a crossing', () => {
    const r = pairGateways([at(0), at(90), at(180), at(270)], [0, 0], 1600, base);
    expect(r.through.map(key).sort()).toEqual(['0-2', '1-3']);
    expect(r.tees).toEqual([]);
  });

  it('leaves an odd one out to join a road', () => {
    const r = pairGateways([at(0), at(120), at(240)], [0, 0], 1600, base);
    expect(r.through).toHaveLength(1);
    expect(r.tees).toHaveLength(1);
  });

  it('joins neighbours along the border when asked', () => {
    const r = pairGateways([at(0), at(90), at(180), at(270)], [0, 0], 1600, { ...base, borderShare: 1 });
    expect(r.border).toHaveLength(2);
    for (const [i, j] of r.border) expect(Math.abs(i - j) === 1 || Math.abs(i - j) === 3).toBe(true);
  });

  it('only along borders it is allowed to follow', () => {
    const r = pairGateways([at(0), at(90), at(180), at(270)], [0, 0], 1600, { ...base, borderShare: 1, eligible: () => false });
    expect(r.border).toEqual([]);
    expect(r.through).toHaveLength(2);
  });

  it('sends every gateway to the centre for a town centre, or a lone gateway', () => {
    expect(pairGateways([at(0), at(90), at(200)], [0, 0], 1600, { ...base, star: true }).star.sort()).toEqual([0, 1, 2]);
    expect(pairGateways([at(0)], [0, 0], 1600, base).star).toEqual([0]);
  });
});

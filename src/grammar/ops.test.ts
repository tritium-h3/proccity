import { describe, it, expect } from 'vitest';
import type { MultiPolygon } from '../doc/types.js';
import { area, bounds, rect } from './polygon.js';
import { isEmpty, makeSlab } from './slab.js';
import { band, cut, inset, split } from './ops.js';

const A = () => makeSlab(rect(0, 0, 100, 50));
const width = (fp: MultiPolygon) => { const b = bounds(fp); return b.maxX - b.minX; };

describe('split', () => {
  it('splits across x by absolute and relative sizes', () => {
    const parts = split(A(), 'x', [30, '1r', '1r']);
    expect(parts.map(p => width(p.footprint))).toEqual([30, 35, 35]);
    expect(parts.reduce((s, p) => s + area(p.footprint), 0)).toBeCloseTo(5000, 6);
  });

  it('refuses absolute sizes larger than the extent', () => {
    expect(() => split(A(), 'x', [60, 60])).toThrow();
  });

  it('splits an open slab vertically, leaving the top open', () => {
    const [low, top] = split(makeSlab(rect(0, 0, 10, 10), 0, null), 'y', [40, '1r']);
    expect(low.height).toEqual({ ref: 'ground', low: 0, high: 40 });
    expect(top.height).toEqual({ ref: 'ground', low: 40, high: null });
  });

  it('only lets a final relative size be open', () => {
    expect(() => split(makeSlab(rect(0, 0, 10, 10)), 'y', ['1r', 40])).toThrow(/open slab/);
  });

  it('returns an empty piece rather than throwing when a strip is outside the footprint', () => {
    const L = makeSlab([[[[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]]]]);
    const strips = split(L, 'x', [50, '1r']);
    const rightStripTop = split(strips[1], 'z', [50, '1r']);
    expect(rightStripTop).toHaveLength(2);
    expect(isEmpty(rightStripTop[1])).toBe(true);
    expect(rightStripTop.reduce((s, p) => s + area(p.footprint), 0)).toBeCloseTo(area(strips[1].footprint), 6);
  });
});

describe('cut', () => {
  it('cuts a band out of a slab', () => {
    const { inside, outside } = cut(A(), rect(40, 0, 60, 50));
    expect(area(inside.footprint)).toBeCloseTo(1000, 6);
    expect(area(outside.footprint)).toBeCloseTo(4000, 6);
    expect(outside.footprint).toHaveLength(2);
  });

  it('handles a cutter that misses or swallows the slab', () => {
    const miss = cut(A(), rect(500, 500, 600, 600));
    expect(isEmpty(miss.inside)).toBe(true);
    expect(area(miss.outside.footprint)).toBeCloseTo(5000, 6);
    const all = cut(A(), rect(-10, -10, 200, 200));
    expect(isEmpty(all.outside)).toBe(true);
  });
});

describe('inset and band', () => {
  it('insets into an inner slab and a border ring that partition it', () => {
    const { inner, border } = inset(A(), 5);
    expect(area(inner.footprint)).toBeCloseTo(90 * 40, 6);
    expect(area(border.footprint)).toBeCloseTo(5000 - 3600, 6);
  });

  it('widens a centreline into a band', () => {
    expect(area(band([[0, 0], [100, 0]], 10))).toBeCloseTo(1000, 2);
  });
});

import { describe, it, expect } from 'vitest';
import { rect } from './polygon.js';
import { makeSlab } from './slab.js';
import { split } from './ops.js';
import { checkPartition } from './partition.js';

const A = () => makeSlab(rect(0, 0, 100, 50));

describe('checkPartition', () => {
  it('accepts a footprint split', () => {
    expect(checkPartition(A(), split(A(), 'x', [30, '1r'])).ok).toBe(true);
  });

  it('accepts a vertical split of an open slab', () => {
    const parent = makeSlab(rect(0, 0, 10, 10));
    expect(checkPartition(parent, split(parent, 'y', [40, '1r']))).toEqual({ ok: true, problems: [] });
  });

  it('accepts a mixed partition', () => {
    const [left, right] = split(A(), 'x', ['1r', '1r']);
    const [low, top] = split(right, 'y', [40, '1r']);
    expect(checkPartition(A(), [left, low, top]).ok).toBe(true);
  });

  it('reports a gap', () => {
    const [left] = split(A(), 'x', ['1r', '1r']);
    const r = checkPartition(A(), [left]);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/gap/);
  });

  it('reports an overlap', () => {
    const [left, right] = split(A(), 'x', ['1r', '1r']);
    expect(checkPartition(A(), [left, right, right]).problems.join(' ')).toMatch(/overlap/);
  });

  it('reports a spill outside the parent', () => {
    const [left, right] = split(A(), 'x', ['1r', '1r']);
    const fat = makeSlab(rect(50, 0, 120, 50));
    expect(checkPartition(A(), [left, right, fat]).problems.join(' ')).toMatch(/spill/);
  });

  it('reports a child taller than a capped parent', () => {
    const parent = makeSlab(rect(0, 0, 10, 10), 0, 50);
    const child = makeSlab(rect(0, 0, 10, 10), 0, 80);
    expect(checkPartition(parent, [child]).problems.join(' ')).toMatch(/height/);
  });
});

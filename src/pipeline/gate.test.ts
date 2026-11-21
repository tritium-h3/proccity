import { describe, it, expect } from 'vitest';
import { createLatestGate } from './gate.js';

describe('createLatestGate', () => {
  it('issues increasing tickets and only the newest is latest', () => {
    const g = createLatestGate();
    const a = g.next();
    const b = g.next();
    expect(b).toBeGreaterThan(a);
    expect(g.isLatest(a)).toBe(false);
    expect(g.isLatest(b)).toBe(true);
  });

  it('ignores completion order: a stale ticket finishing last still is not latest', () => {
    const g = createLatestGate();
    const first = g.next();
    const second = g.next();
    const applied: number[] = [];
    for (const t of [second, first]) if (g.isLatest(t)) applied.push(t);
    expect(applied).toEqual([second]);
  });
});

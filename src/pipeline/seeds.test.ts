import { describe, it, expect } from 'vitest';
import { createRng, stageSeed } from './seeds.js';

describe('seeds', () => {
  it('differs per stage and per offset, and is stable', () => {
    expect(stageSeed(1, 'a', 0)).not.toBe(stageSeed(1, 'b', 0));
    expect(stageSeed(1, 'a', 0)).not.toBe(stageSeed(1, 'a', 1));
    expect(stageSeed(1, 'a', 0)).toBe(stageSeed(1, 'a', 0));
    expect(stageSeed(1, 'a', 0)).not.toBe(stageSeed(2, 'a', 0));
  });

  it('produces a reproducible stream in [0, 1)', () => {
    const a = createRng(5), b = createRng(5);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true);
  });
});

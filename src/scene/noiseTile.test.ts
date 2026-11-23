import { describe, it, expect } from 'vitest';
import { noiseTile } from './noiseTile.js';

describe('noiseTile', () => {
  const size = 64, tile = noiseTile(size, 4);
  const at = (x: number, y: number, c: number) => tile[((y % size) * size + (x % size)) * 4 + c];

  it('fills four channels across most of the byte range', () => {
    expect(tile.length).toBe(size * size * 4);
    for (let c = 0; c < 4; c++) {
      const vals = Array.from({ length: size * size }, (_, i) => tile[i * 4 + c]);
      expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(150);
    }
  });

  it('tiles seamlessly: across the wrap it changes no more than between neighbours inside', () => {
    for (let c = 0; c < 4; c++) {
      let inside = 0, wrap = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size - 1; x++) inside = Math.max(inside, Math.abs(at(x + 1, y, c) - at(x, y, c)));
        wrap = Math.max(wrap, Math.abs(at(0, y, c) - at(size - 1, y, c)), Math.abs(at(y, 0, c) - at(y, size - 1, c)));
      }
      expect(wrap).toBeLessThanOrEqual(inside);
    }
  });

  it('gives independent channels', () => {
    let same = 0;
    for (let i = 0; i < size * size; i++) if (Math.abs(tile[i * 4] - tile[i * 4 + 1]) < 4) same++;
    expect(same / (size * size)).toBeLessThan(0.2);
  });
});

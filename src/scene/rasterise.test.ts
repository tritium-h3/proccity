import { describe, it, expect } from 'vitest';
import { rect } from '../grammar/polygon.js';
import { rasterise } from './rasterise.js';

describe('rasterise', () => {
  it('fills footprints into an rgba grid', () => {
    // A 400 m area from (0, 0) at 40 px (10 m per px); a 100 m square in the middle.
    const px = rasterise([{ footprint: rect(150, 150, 250, 250), rgba: [10, 20, 30, 200] }], 0, 0, 400, 40);
    const at = (x: number, z: number) => [...px.slice((z * 40 + x) * 4, (z * 40 + x) * 4 + 4)];
    expect(px.length).toBe(40 * 40 * 4);
    expect(at(20, 20)).toEqual([10, 20, 30, 200]);
    expect(at(2, 2)).toEqual([0, 0, 0, 0]);
    expect(at(14, 20)[3]).toBe(0);
    expect(at(15, 20)[3]).toBe(200);
  });

  it('leaves holes empty', () => {
    const ring = rect(0, 0, 400, 400)[0][0], hole = [...rect(100, 100, 300, 300)[0][0]].reverse();
    const px = rasterise([{ footprint: [[ring, hole]], rgba: [1, 2, 3, 4] }], 0, 0, 400, 40);
    expect(px[(20 * 40 + 20) * 4 + 3]).toBe(0);
    expect(px[(5 * 40 + 5) * 4 + 3]).toBe(4);
  });
});

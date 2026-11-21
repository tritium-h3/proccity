import { describe, it, expect } from 'vitest';
import { decodeHeights, encodeHeights, makeHeightfield, sampleHeight } from './heightfield.js';

describe('heightfield', () => {
  it('round-trips heights through base64', () => {
    const a = new Float32Array([0, 1.5, -15, 400]);
    expect([...decodeHeights(encodeHeights(a))]).toEqual([...a]);
  });

  it('samples bilinearly and clamps outside the grid', () => {
    const h = new Float32Array([0, 10, 20, 30]); // row z=0: 0,10; row z=8: 20,30
    const hf = makeHeightfield([0, 0], 8, 2, 2, h);
    expect(sampleHeight(hf, h, 4, 4)).toBeCloseTo(15);
    expect(sampleHeight(hf, h, 0, 0)).toBe(0);
    expect(sampleHeight(hf, h, -5, 100)).toBe(20);
  });
});

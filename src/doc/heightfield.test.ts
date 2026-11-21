import { describe, it, expect } from 'vitest';
import { decodeHeights } from './heightfield.js';

describe('decodeHeights (old v1 saves)', () => {
  it('decodes little-endian float32 base64', () => {
    // [1.5, -15] as little-endian float32
    expect([...decodeHeights('AADAPwAAcME=')]).toEqual([1.5, -15]);
  });
  it('rejects a byte length that is not a multiple of 4', () => {
    expect(() => decodeHeights('AAA=')).toThrow();
  });
});

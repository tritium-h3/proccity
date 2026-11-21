import { describe, it, expect } from 'vitest';
import { generateCity, DEFAULT_OPTIONS, type Building, type Rect } from './generate.js';

const inside = (b: Building, r: Rect) =>
  b.x - b.width / 2 >= r.x - r.width / 2 - 1e-9 &&
  b.x + b.width / 2 <= r.x + r.width / 2 + 1e-9 &&
  b.z - b.depth / 2 >= r.z - r.depth / 2 - 1e-9 &&
  b.z + b.depth / 2 <= r.z + r.depth / 2 + 1e-9;

describe('generateCity', () => {
  it('lays out one block per grid cell and lotsPerSide² buildings per block', () => {
    const city = generateCity({ ...DEFAULT_OPTIONS, blocksX: 5, blocksZ: 3, lotsPerSide: 2 });
    expect(city.blocks).toHaveLength(15);
    expect(city.buildings).toHaveLength(60);
  });

  it('keeps every building inside its block (never on a street)', () => {
    const city = generateCity(DEFAULT_OPTIONS);
    for (const b of city.buildings) {
      expect(inside(b, city.blocks[b.block])).toBe(true);
    }
  });

  it('centres the city on the origin', () => {
    const city = generateCity(DEFAULT_OPTIONS);
    const xs = city.blocks.map(b => b.x);
    const zs = city.blocks.map(b => b.z);
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(0);
    expect(Math.min(...zs) + Math.max(...zs)).toBeCloseTo(0);
  });

  it('builds taller downtown than at the edges', () => {
    const city = generateCity({ ...DEFAULT_OPTIONS, blocksX: 12, blocksZ: 12 });
    const r = city.width / 2;
    const mean = (bs: Building[]) => bs.reduce((s, b) => s + b.height, 0) / bs.length;
    const centre = city.buildings.filter(b => Math.hypot(b.x, b.z) < r * 0.25);
    const edge = city.buildings.filter(b => Math.hypot(b.x, b.z) > r * 0.8);
    expect(mean(centre)).toBeGreaterThan(mean(edge) * 2);
  });

  it('gives every building positive dimensions', () => {
    for (const b of generateCity(DEFAULT_OPTIONS).buildings) {
      expect(b.width).toBeGreaterThan(0);
      expect(b.depth).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
    }
  });

  it('is reproducible from its seed', () => {
    expect(generateCity({ ...DEFAULT_OPTIONS, seed: 7 })).toEqual(generateCity({ ...DEFAULT_OPTIONS, seed: 7 }));
    expect(generateCity({ ...DEFAULT_OPTIONS, seed: 7 })).not.toEqual(generateCity({ ...DEFAULT_OPTIONS, seed: 8 }));
  });
});

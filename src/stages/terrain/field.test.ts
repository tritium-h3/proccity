import { describe, it, expect } from 'vitest';
import { rect } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { distanceTo, fbm, gridFor, rasterize, solveHarmonic, steepness } from './field.js';

describe('grid field maths', () => {
  it('sizes the grid at 8 m with the origin on the site corner', () => {
    expect(gridFor(2000)).toEqual({ cols: 251, rows: 251, cell: 8, origin: [-1000, -1000] });
  });

  it('rasterises a polygon onto grid points', () => {
    const g = gridFor(80); // 11×11 points, -40..40
    const m = rasterize(g, rect(-20, -20, 20, 20)); // grid points -16, -8, 0, 8, 16 on each axis
    expect(m.reduce((s, v) => s + v, 0)).toBe(25);
  });

  it('measures distance to the nearest source point', () => {
    const g = gridFor(80);
    const src = new Uint8Array(g.cols * g.rows);
    src[5 * g.cols + 5] = 1; // centre
    const d = distanceTo(g, src);
    expect(d[5 * g.cols + 5]).toBe(0);
    expect(d[0]).toBeGreaterThan(Math.hypot(40, 40) * 0.97);
    expect(d[0]).toBeLessThan(Math.hypot(40, 40) * 1.07);
  });

  it('solves the smoothest surface through pinned points', () => {
    const g = gridFor(160); // 21×21
    const pinned = new Uint8Array(g.cols * g.rows);
    const values = new Float32Array(g.cols * g.rows);
    for (let j = 0; j < g.rows; j++) {
      pinned[j * g.cols] = 1; values[j * g.cols] = 0;
      pinned[j * g.cols + g.cols - 1] = 1; values[j * g.cols + g.cols - 1] = 100;
    }
    const h = solveHarmonic(g, pinned, values);
    expect(h[10 * g.cols + 10]).toBeCloseTo(50, 0);
    expect(h[10 * g.cols]).toBe(0);
    expect(h[10 * g.cols + 20]).toBe(100);
  });

  it('solves a full-size grid quickly', () => {
    const g = gridFor(2000);
    const pinned = new Uint8Array(g.cols * g.rows);
    const values = new Float32Array(g.cols * g.rows);
    for (let i = 0; i < g.cols; i++) { pinned[i] = 1; values[i] = 0; pinned[(g.rows - 1) * g.cols + i] = 1; values[(g.rows - 1) * g.cols + i] = 150; }
    const t = performance.now();
    const h = solveHarmonic(g, pinned, values);
    const ms = performance.now() - t;
    console.log(`harmonic 251² solve: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1000);
    expect(h[125 * g.cols + 125]).toBeCloseTo(75, -1);
  });

  it('makes deterministic noise with real variation', () => {
    const g = gridFor(800);
    const a = fbm(g, createRng(1), 300, 4), b = fbm(g, createRng(1), 300, 4);
    expect([...a]).toEqual([...b]);
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    const std = Math.sqrt(a.reduce((s, v) => s + (v - mean) ** 2, 0) / a.length);
    expect(std).toBeGreaterThan(0.1);
  });

  it('measures steepness in degrees', () => {
    const g = gridFor(80);
    const h = new Float32Array(g.cols * g.rows);
    for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) h[j * g.cols + i] = i * g.cell; // h = x
    expect(steepness(g, h)[5 * g.cols + 5]).toBeCloseTo(45, 1);
  });
});

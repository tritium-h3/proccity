import { describe, it, expect } from 'vitest';
import { faceNormals, phongSubdivide, smoothNormals } from './smoothMesh.js';

// A 3×3-vertex grid (2×2 cells, 8 triangles), x/z spacing 10, heights from f.
function grid(f: (x: number, z: number) => number) {
  const pos: number[] = [], weights: number[] = [], tris: number[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) { pos.push(i * 10, f(i * 10, j * 10), j * 10); weights.push(0, 1, 0, 0); }
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
    const a = j * 3 + i, b = a + 1, c = a + 3, d = c + 1;
    tris.push(a, c, b, b, c, d);
  }
  return { pos, weights, tris };
}

describe('smoothMesh', () => {
  it('gives unit normals that point up on a plane', () => {
    const g = grid(() => 5);
    const n = smoothNormals(g.pos, g.tris, faceNormals(g.pos, g.tris), 2);
    for (let i = 0; i < n.length; i += 3) {
      expect(Math.hypot(n[i], n[i + 1], n[i + 2])).toBeCloseTo(1, 6);
      expect(n[i + 1]).toBeCloseTo(1, 6);
    }
  });

  it('quadruples the triangles and keeps a plane flat', () => {
    const g = grid((x, z) => 0.3 * x + 0.1 * z);
    const n = smoothNormals(g.pos, g.tris, faceNormals(g.pos, g.tris), 0);
    const s = phongSubdivide(g.pos, g.weights, g.tris, n, { maxDy: 2 });
    expect(s.tris.length).toBe(g.tris.length * 4);
    for (let i = 0; i < s.pos.length; i += 3) expect(s.pos[i + 1]).toBeCloseTo(0.3 * s.pos[i] + 0.1 * s.pos[i + 2], 6);
  });

  it('curves midpoints on a bend, but never more than maxDy', () => {
    const g = grid((x, z) => (x === 10 && z === 10 ? 40 : 0)); // a sharp peak
    const n = smoothNormals(g.pos, g.tris, faceNormals(g.pos, g.tris), 2);
    const s = phongSubdivide(g.pos, g.weights, g.tris, n, { maxDy: 2 });
    let moved = 0;
    const original = g.pos.length / 3;
    for (let v = original; v < s.pos.length / 3; v++) {
      const dy = Math.abs(s.pos[v * 3 + 1] - s.linearY[v - original]);
      expect(dy).toBeLessThanOrEqual(2 + 1e-9);
      if (dy > 0.01) moved++;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('keeps midpoints straight on edges touching water', () => {
    const g = grid((x, z) => (x === 10 && z === 10 ? 40 : 0));
    g.weights.splice(0, 4, 0, 0, 0, 1); // vertex 0 shares a water region
    const n = smoothNormals(g.pos, g.tris, faceNormals(g.pos, g.tris), 2);
    const s = phongSubdivide(g.pos, g.weights, g.tris, n, { maxDy: 2 });
    const original = g.pos.length / 3;
    for (let v = original; v < s.pos.length / 3; v++) {
      const [a, b] = s.parents[v - original];
      if (a === 0 || b === 0) expect(s.pos[v * 3 + 1]).toBeCloseTo(s.linearY[v - original], 9);
    }
  });
});

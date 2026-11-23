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

describe('adaptive subdivision (minDy)', () => {
  /** Every edge used by exactly one or two triangles, and no vertex inside another
   *  triangle's edge: a crack-free mesh. */
  function watertight(pos: number[], tris: number[]) {
    const count = new Map<string, number>();
    for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = tris[t + k], b = tris[t + (k + 1) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
    const used = new Set(tris);
    for (const [key, n] of count) {
      if (n > 2) return false;
      const [a, b] = key.split(',').map(Number);
      for (const v of used) {
        if (v === a || v === b) continue;
        const ax = pos[a * 3], az = pos[a * 3 + 2], bx = pos[b * 3], bz = pos[b * 3 + 2], vx = pos[v * 3], vz = pos[v * 3 + 2];
        const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, t = ((vx - ax) * dx + (vz - az) * dz) / L2;
        if (t > 1e-6 && t < 1 - 1e-6 && Math.hypot(ax + dx * t - vx, az + dz * t - vz) < 1e-6) return false;
      }
    }
    return true;
  }

  it('adds nothing on a plane', () => {
    const { pos, weights, tris } = grid((x, z) => 0.2 * x + 0.1 * z);
    const n = smoothNormals(pos, tris, faceNormals(pos, tris), 2);
    const s = phongSubdivide(pos, weights, tris, n, { maxDy: 1.25, minDy: 0.3 });
    expect(s.tris.length).toBe(tris.length);
    expect(s.pos.length).toBe(pos.length);
  });

  it('splits only the curved part, and stays crack-free', () => {
    // A plateau with a sharp bend down at x = 10: only edges near the bend curve much.
    const { pos, weights, tris } = grid((x) => (x < 10 ? 0 : -(x - 10) * 0.8));
    const n = smoothNormals(pos, tris, faceNormals(pos, tris), 2);
    const all = phongSubdivide(pos, weights, tris, n, { maxDy: 1.25 });
    const some = phongSubdivide(pos, weights, tris, n, { maxDy: 1.25, minDy: 0.3 });
    expect(some.tris.length).toBeGreaterThan(tris.length);
    expect(some.tris.length).toBeLessThan(all.tris.length);
    expect(watertight(some.pos, some.tris)).toBe(true);
  });
});

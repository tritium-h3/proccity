// The ground as a regular raster, filled once per run from the terrain regions' own triangles.
// groundHeightAt scans every region for every query, far too slow for thousands of traced cuts.

import { walk } from '../../doc/tree.js';
import type { Point2, RegionNode } from '../../doc/types.js';
import { bounds } from '../../grammar/polygon.js';

export interface HeightRaster {
  at(x: number, z: number): number;
  /** the height smoothed as `slope` is: what roads are graded against */
  smoothAt(x: number, z: number): number;
  /** the ground's gradient (rise per metre along x and z), smoothed over about `SMOOTH` metres:
   *  the terrain is big flat triangles, and the raw gradient jumps at every edge, which kinked
   *  every streamline crossing one and bunched them where facets fold */
  slope(x: number, z: number): Point2;
}

const SMOOTH = 200; // m

function boxBlur(a: Float32Array, cols: number, rows: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < cols) { s += a[y * cols + xx]; n++; } }
    tmp[y * cols + x] = s / n;
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    let s = 0, n = 0;
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < rows) { s += tmp[yy * cols + x]; n++; } }
    out[y * cols + x] = s / n;
  }
  return out;
}

export function heightRaster(tree: RegionNode, cell: number): HeightRaster {
  const b = bounds(tree.geometry.footprint);
  const cols = Math.ceil((b.maxX - b.minX) / cell) + 1, rows = Math.ceil((b.maxZ - b.minZ) / cell) + 1;
  const h = new Float32Array(cols * rows).fill(NaN);
  walk(tree, n => {
    const g = n.data?.ground;
    if (!g || n.stage !== 'terrain') return;
    for (const [i, j, k] of g.triangles) {
      const [ax, az, ah] = g.points[i], [bx, bz, bh] = g.points[j], [cx, cz, ch] = g.points[k];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue;
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - b.minX) / cell)), c1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx, cx) - b.minX) / cell));
      const r0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - b.minZ) / cell)), r1 = Math.min(rows - 1, Math.ceil((Math.max(az, bz, cz) - b.minZ) / cell));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const x = b.minX + c * cell, z = b.minZ + r * cell;
        const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
        const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        h[r * cols + c] = l1 * ah + l2 * bh + l3 * ch;
      }
    }
  });
  // Grid points no triangle covered (slivers between regions) take a neighbour's height.
  for (let pass = 0; pass < 4; pass++) for (let i = 0; i < h.length; i++) {
    if (!Number.isNaN(h[i])) continue;
    const r = Math.floor(i / cols), c = i % cols;
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && !Number.isNaN(h[rr * cols + cc])) { h[i] = h[rr * cols + cc]; break; }
    }
  }
  for (let i = 0; i < h.length; i++) if (Number.isNaN(h[i])) h[i] = 0;
  // Three box blurs ≈ a Gaussian.
  const radius = Math.max(1, Math.round(SMOOTH / cell / 2));
  let sm: Float32Array = h.slice();
  for (let pass = 0; pass < 3; pass++) sm = boxBlur(sm, cols, rows, radius);
  const sample = (a: Float32Array, x: number, z: number) => {
    const fx = Math.min(cols - 1.001, Math.max(0, (x - b.minX) / cell)), fz = Math.min(rows - 1.001, Math.max(0, (z - b.minZ) / cell));
    const c = Math.floor(fx), r = Math.floor(fz), tx = fx - c, tz = fz - r;
    const g = (cc: number, rr: number) => a[rr * cols + cc];
    return (g(c, r) * (1 - tx) + g(c + 1, r) * tx) * (1 - tz) + (g(c, r + 1) * (1 - tx) + g(c + 1, r + 1) * tx) * tz;
  };
  return {
    at: (x, z) => sample(h, x, z),
    smoothAt: (x, z) => sample(sm, x, z),
    slope: (x, z) => [(sample(sm, x + cell, z) - sample(sm, x - cell, z)) / (2 * cell), (sample(sm, x, z + cell) - sample(sm, x, z - cell)) / (2 * cell)],
  };
}

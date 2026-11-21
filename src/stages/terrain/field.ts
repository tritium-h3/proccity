// Grid maths for the height map. A Grid is a regular lattice of points (not cells):
// point (i, j) sits at origin + (i·cell, j·cell); arrays are row-major (j, then i).

import { createNoise2D } from 'simplex-noise';
import type { MultiPolygon, Point2 } from '../../doc/types.js';

export interface Grid { cols: number; rows: number; cell: number; origin: Point2 }

export function gridFor(size: number, cell = 8): Grid {
  const n = Math.round(size / cell) + 1;
  return { cols: n, rows: n, cell, origin: [-size / 2, -size / 2] };
}

/** 1 for grid points inside the footprint (even-odd over every ring, so holes work). */
export function rasterize(g: Grid, mp: MultiPolygon): Uint8Array {
  const out = new Uint8Array(g.cols * g.rows);
  const rings = mp.flat();
  for (let j = 0; j < g.rows; j++) {
    const z = g.origin[1] + j * g.cell;
    const xs: number[] = [];
    for (const ring of rings) {
      for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
        const [ax, az] = ring[m], [bx, bz] = ring[k];
        if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.origin[0]) / g.cell - 1e-9));
      const i1 = Math.min(g.cols - 1, Math.floor((xs[k + 1] - g.origin[0]) / g.cell + 1e-9));
      for (let i = i0; i <= i1; i++) out[j * g.cols + i] = 1;
    }
  }
  return out;
}

/** Approximate Euclidean distance (metres) to the nearest source point. Two-pass chamfer with
 *  weights 1 and √2: exact along axes and diagonals, within ~8 % in between. */
export function distanceTo(g: Grid, sources: Uint8Array): Float32Array {
  const { cols, rows } = g;
  const INF = 1e9;
  const d = new Float32Array(cols * rows);
  for (let k = 0; k < d.length; k++) d[k] = sources[k] ? 0 : INF;
  const relax = (k: number, n: number, w: number) => { if (d[n] + w < d[k]) d[k] = d[n] + w; };
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    if (i > 0) relax(k, k - 1, 1);
    if (j > 0) {
      relax(k, k - cols, 1);
      if (i > 0) relax(k, k - cols - 1, Math.SQRT2);
      if (i < cols - 1) relax(k, k - cols + 1, Math.SQRT2);
    }
  }
  for (let j = rows - 1; j >= 0; j--) for (let i = cols - 1; i >= 0; i--) {
    const k = j * cols + i;
    if (i < cols - 1) relax(k, k + 1, 1);
    if (j < rows - 1) {
      relax(k, k + cols, 1);
      if (i < cols - 1) relax(k, k + cols + 1, Math.SQRT2);
      if (i > 0) relax(k, k + cols - 1, Math.SQRT2);
    }
  }
  for (let k = 0; k < d.length; k++) d[k] = d[k] >= INF ? Infinity : d[k] * g.cell;
  return d;
}

/** One SOR sweep set: free points move towards the mean of their in-grid neighbours. */
function sor(cols: number, rows: number, pinned: Uint8Array, h: Float32Array, iterations: number, omega: number) {
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      if (pinned[k]) continue;
      let s = 0, n = 0;
      if (i > 0) { s += h[k - 1]; n++; }
      if (i < cols - 1) { s += h[k + 1]; n++; }
      if (j > 0) { s += h[k - cols]; n++; }
      if (j < rows - 1) { s += h[k + cols]; n++; }
      h[k] += omega * (s / n - h[k]);
    }
  }
}

/** The smoothest (harmonic) surface through the pinned points. Coarse-to-fine: solve a
 *  half-resolution problem for the initial guess, then refine with SOR. Unpinned edges
 *  are free (zero-gradient), so only pins shape the surface. */
export function solveHarmonic(
  g: Grid, pinned: Uint8Array, values: Float32Array, opts: { iterations?: number; omega?: number } = {},
): Float32Array {
  return solveLevel(g.cols, g.rows, pinned, values, opts.iterations ?? 60, opts.omega ?? 1.85);
}

function solveLevel(cols: number, rows: number, pinned: Uint8Array, values: Float32Array, iterations: number, omega: number): Float32Array {
  const h = new Float32Array(cols * rows);
  if (cols <= 33 || rows <= 33) {
    let mean = 0, n = 0;
    for (let k = 0; k < h.length; k++) if (pinned[k]) { mean += values[k]; n++; }
    mean = n ? mean / n : 0;
    for (let k = 0; k < h.length; k++) h[k] = pinned[k] ? values[k] : mean;
    sor(cols, rows, pinned, h, 400, 1.9);
    return h;
  }
  // Coarse problem: a coarse point is pinned if any fine pin falls in its 2×2 block (mean value).
  const cc = Math.ceil(cols / 2), cr = Math.ceil(rows / 2);
  const cp = new Uint8Array(cc * cr), cv = new Float32Array(cc * cr), cn = new Uint16Array(cc * cr);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    if (!pinned[k]) continue;
    const ck = (j >> 1) * cc + (i >> 1);
    cp[ck] = 1; cv[ck] += values[k]; cn[ck]++;
  }
  for (let k = 0; k < cv.length; k++) if (cn[k]) cv[k] /= cn[k];
  const coarse = solveLevel(cc, cr, cp, cv, iterations, omega);
  // Bilinear upsample as the initial guess.
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    if (pinned[k]) { h[k] = values[k]; continue; }
    const x = Math.min(i / 2, cc - 1), z = Math.min(j / 2, cr - 1);
    const x0 = Math.floor(x), z0 = Math.floor(z), x1 = Math.min(x0 + 1, cc - 1), z1 = Math.min(z0 + 1, cr - 1);
    const tx = x - x0, tz = z - z0;
    h[k] = (coarse[z0 * cc + x0] * (1 - tx) + coarse[z0 * cc + x1] * tx) * (1 - tz)
      + (coarse[z1 * cc + x0] * (1 - tx) + coarse[z1 * cc + x1] * tx) * tz;
  }
  sor(cols, rows, pinned, h, iterations, omega);
  return h;
}

/** Fractal (fBm) simplex noise, roughly in [-1, 1]. */
export function fbm(g: Grid, rng: () => number, wavelength: number, octaves: number): Float32Array {
  const noise = createNoise2D(rng);
  const out = new Float32Array(g.cols * g.rows);
  let norm = 0;
  for (let o = 0; o < octaves; o++) norm += 0.5 ** o;
  for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) {
    const x = g.origin[0] + i * g.cell, z = g.origin[1] + j * g.cell;
    let s = 0;
    for (let o = 0; o < octaves; o++) {
      const f = 2 ** o / wavelength;
      s += noise(x * f + o * 17.3, z * f - o * 9.1) * 0.5 ** o;
    }
    out[j * g.cols + i] = s / norm;
  }
  return out;
}

/** Slope angle at each point, degrees (central differences; one-sided at edges). */
export function steepness(g: Grid, h: Float32Array): Float32Array {
  const { cols, rows, cell } = g;
  const out = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i;
    const il = Math.max(i - 1, 0), ir = Math.min(i + 1, cols - 1);
    const jd = Math.max(j - 1, 0), ju = Math.min(j + 1, rows - 1);
    const dx = (h[j * cols + ir] - h[j * cols + il]) / ((ir - il) * cell);
    const dz = (h[ju * cols + i] - h[jd * cols + i]) / ((ju - jd) * cell);
    out[k] = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
  }
  return out;
}

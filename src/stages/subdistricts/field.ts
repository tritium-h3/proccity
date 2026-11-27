// The implied density field: each district's nominal density (the middle of its type's range on
// the ladder; Undeveloped districts 0), blurred over about half a district's width so a district
// is denser on the side of a denser neighbour and thins towards wild land, plus smooth noise so
// same-type surroundings don't all come out level. Water and the site edge carry no weight (the
// blur is normalised over land), so shores and the map edge aren't thinned: that would sneak in
// the core-to-edge ring the owner doesn't want.

import { walk } from '../../doc/tree.js';
import type { MultiPolygon, Point2, RegionNode } from '../../doc/types.js';
import { bounds, containsPoint } from '../../grammar/polygon.js';
import type { DistrictType } from '../districts/rules.js';
import { nominal } from './rules.js';

const CELLS = 200;

export interface DensityField { at(p: Point2): number; meanOver(fp: MultiPolygon): number }

function blur(src: Float64Array, n: number, sigma: number): Float64Array {
  const r = Math.ceil(3 * sigma);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const tmp = new Float64Array(n * n), out = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0;
    for (let i = Math.max(0, x - r); i <= Math.min(n - 1, x + r); i++) s += src[y * n + i] * k[i - x + r];
    tmp[y * n + x] = s;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0;
    for (let j = Math.max(0, y - r); j <= Math.min(n - 1, y + r); j++) s += tmp[j * n + x] * k[j - y + r];
    out[y * n + x] = s;
  }
  return out;
}

/** A lattice value in [−1, 1], from a hash of the corner and the seed. */
function lattice(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function noise(x: number, y: number, seed: number): number {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = lattice(i, j, seed) + (lattice(i + 1, j, seed) - lattice(i, j, seed)) * sx;
  const b = lattice(i, j + 1, seed) + (lattice(i + 1, j + 1, seed) - lattice(i, j + 1, seed)) * sx;
  return a + (b - a) * sy;
}

export function densityField(tree: RegionNode, o: { districtSize: number; variation: number; seed: number }): DensityField {
  const sb = bounds(tree.geometry.footprint);
  const size = Math.max(sb.maxX - sb.minX, sb.maxZ - sb.minZ), cell = size / CELLS, n = CELLS;
  const width = Math.sqrt(o.districtSize * 1e4);
  const ds: { fp: MultiPolygon; b: ReturnType<typeof bounds>; v: number }[] = [];
  walk(tree, d => { if (d.kind === 'district') ds.push({ fp: d.geometry.footprint, b: bounds(d.geometry.footprint), v: nominal(d.attrs.type as DistrictType) }); });

  const value = new Float64Array(n * n), weight = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const p: Point2 = [sb.minX + (x + 0.5) * cell, sb.minZ + (y + 0.5) * cell];
    const d = ds.find(q => p[0] >= q.b.minX && p[0] <= q.b.maxX && p[1] >= q.b.minZ && p[1] <= q.b.maxZ && containsPoint(q.fp, p));
    if (d) { value[y * n + x] = d.v; weight[y * n + x] = 1; }
  }
  const sigma = (0.5 * width) / cell;
  const bv = blur(value, n, sigma), bw = blur(weight, n, sigma);
  const field = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const x = i % n, y = Math.floor(i / n);
    const base = bw[i] > 1e-9 ? bv[i] / bw[i] : 0;
    const wx = (sb.minX + (x + 0.5) * cell) / width, wy = (sb.minZ + (y + 0.5) * cell) / width;
    field[i] = base + o.variation * noise(wx, wy, o.seed);
  }

  const at = (p: Point2) => {
    const fx = Math.min(n - 1, Math.max(0, (p[0] - sb.minX) / cell - 0.5)), fy = Math.min(n - 1, Math.max(0, (p[1] - sb.minZ) / cell - 0.5));
    const x0 = Math.min(n - 2, Math.floor(fx)), y0 = Math.min(n - 2, Math.floor(fy)), tx = fx - x0, ty = fy - y0;
    const v = (x: number, y: number) => field[y * n + x];
    return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
  };
  const meanOver = (fp: MultiPolygon) => {
    const b = bounds(fp);
    let s = 0, k = 0;
    for (let y = Math.max(0, Math.floor((b.minZ - sb.minZ) / cell)); y <= Math.min(n - 1, Math.floor((b.maxZ - sb.minZ) / cell)); y++)
      for (let x = Math.max(0, Math.floor((b.minX - sb.minX) / cell)); x <= Math.min(n - 1, Math.floor((b.maxX - sb.minX) / cell)); x++) {
        const p: Point2 = [sb.minX + (x + 0.5) * cell, sb.minZ + (y + 0.5) * cell];
        if (containsPoint(fp, p)) { s += field[y * n + x]; k++; }
      }
    if (k) return s / k;
    return at([(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2]);
  };
  return { at, meanOver };
}

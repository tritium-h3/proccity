import type { Heightfield, Point2 } from './types.js';

// Heights travel as base64 Float32 (little-endian) so a 251×251 map is ~330 KB of JSON
// rather than megabytes of number text.

export function encodeHeights(a: Float32Array): string {
  const bytes = new Uint8Array(a.length * 4);
  const view = new DataView(bytes.buffer);
  a.forEach((v, i) => view.setFloat32(i * 4, v, true));
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function decodeHeights(s: string): Float32Array {
  const bin = atob(s);
  if (bin.length % 4 !== 0) throw new Error('heights: byte length is not a multiple of 4');
  const view = new DataView(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) view.setUint8(i, bin.charCodeAt(i));
  const out = new Float32Array(bin.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function makeHeightfield(origin: Point2, cell: number, cols: number, rows: number, h: Float32Array): Heightfield {
  return { origin, cell, cols, rows, heights: encodeHeights(h) };
}

/** Bilinear height at (x, z); clamped to the grid edge outside it. `decoded` = decodeHeights(hf.heights). */
export function sampleHeight(hf: Heightfield, decoded: Float32Array, x: number, z: number): number {
  const gx = Math.min(Math.max((x - hf.origin[0]) / hf.cell, 0), hf.cols - 1);
  const gz = Math.min(Math.max((z - hf.origin[1]) / hf.cell, 0), hf.rows - 1);
  const x0 = Math.min(Math.floor(gx), hf.cols - 2 < 0 ? 0 : hf.cols - 2), z0 = Math.min(Math.floor(gz), hf.rows - 2 < 0 ? 0 : hf.rows - 2);
  const x1 = Math.min(x0 + 1, hf.cols - 1), z1 = Math.min(z0 + 1, hf.rows - 1);
  const tx = gx - x0, tz = gz - z0;
  const at = (i: number, j: number) => decoded[j * hf.cols + i];
  const top = at(x0, z0) * (1 - tx) + at(x1, z0) * tx;
  const bottom = at(x0, z1) * (1 - tx) + at(x1, z1) * tx;
  return top * (1 - tz) + bottom * tz;
}

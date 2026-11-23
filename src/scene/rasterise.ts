// Fills footprints into an RGBA pixel grid (row-major, rows along z), sampling at pixel
// centres with the even-odd rule so holes stay empty. Used to bake a stage's regions into a
// texture the ground shader reads (district colours), so they cost no triangles.

import type { MultiPolygon } from '../doc/types.js';

export function rasterise(polys: { footprint: MultiPolygon; rgba: [number, number, number, number] }[],
  minX: number, minZ: number, size: number, px: number): Uint8Array {
  const out = new Uint8Array(px * px * 4);
  const cell = size / px;
  for (const { footprint, rgba } of polys) {
    const rings = footprint.flat();
    for (let row = 0; row < px; row++) {
      const z = minZ + (row + 0.5) * cell;
      const xs: number[] = [];
      for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, az] = ring[j], [bx, bz] = ring[i];
        if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - minX) / cell - 0.5)), c1 = Math.min(px - 1, Math.ceil((xs[k + 1] - minX) / cell - 0.5) - 1);
        for (let c = c0; c <= c1; c++) out.set(rgba, (row * px + c) * 4);
      }
    }
  }
  return out;
}

// Ground height lookups for things draped on the drawn terrain (arterial ribbons). Heights come
// from the mesh as drawn (after smoothing), rasterised at grid nodes and read bilinearly, so a
// ribbon sits on the curved surface instead of the stored one: at 30 km the curve lifts the
// ground several metres.

export function heightSampler(pos: ArrayLike<number>, tris: ArrayLike<number>,
  bounds: { minX: number; minZ: number; size: number }, cell: number): (x: number, z: number) => number {
  const n = Math.ceil(bounds.size / cell) + 1;
  const h = new Float32Array(n * n).fill(NaN);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2], bx = pos[b], by = pos[b + 1], bz = pos[b + 2], cx = pos[c], cy = pos[c + 1], cz = pos[c + 2];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - bounds.minX) / cell)), i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx, cx) - bounds.minX) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - bounds.minZ) / cell)), j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz, cz) - bounds.minZ) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = bounds.minX + i * cell, z = bounds.minZ + j * cell;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
      h[j * n + i] = u * ay + v * by + (1 - u - v) * cy;
    }
  }
  // Nodes no triangle covered (outside the ground) take a covered neighbour's height.
  for (let pass = 0; pass < n && h.some(Number.isNaN); pass++) {
    for (let k = 0; k < h.length; k++) {
      if (!Number.isNaN(h[k])) continue;
      const i = k % n, j = Math.floor(k / n);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni >= 0 && nj >= 0 && ni < n && nj < n && !Number.isNaN(h[nj * n + ni])) { h[k] = h[nj * n + ni]; break; }
      }
    }
  }
  return (x, z) => {
    const fx = Math.min(n - 1, Math.max(0, (x - bounds.minX) / cell)), fz = Math.min(n - 1, Math.max(0, (z - bounds.minZ) / cell));
    const i = Math.min(n - 2, Math.floor(fx)), j = Math.min(n - 2, Math.floor(fz));
    const tx = fx - i, tz = fz - j;
    const v00 = h[j * n + i], v10 = h[j * n + i + 1], v01 = h[(j + 1) * n + i], v11 = h[(j + 1) * n + i + 1];
    return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz;
  };
}

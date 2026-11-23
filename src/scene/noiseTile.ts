// A seamless tile of noise for the ground shader: four independent channels (RGBA bytes,
// 128 = zero), `cycles` noise features across the tile. Sampling this a few times per pixel
// replaced about a dozen procedural 3D noise evaluations, the main per-pixel cost of the
// terrain material. Seamless because each channel is 4D simplex noise sampled on a torus:
// x and y each go once round a circle, so the right edge meets the left (and top bottom).
// Pure (no Three.js), so it's testable.

import { createNoise4D } from 'simplex-noise';

/** Deterministic, so the ground looks the same on every load. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function noiseTile(size: number, cycles: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const noise = [0, 1, 2, 3].map(c => createNoise4D(seeded(1013 + 7919 * c)));
  const r = cycles / (2 * Math.PI); // circumference = cycles noise units
  for (let y = 0; y < size; y++) {
    const b = (y / size) * 2 * Math.PI, cb = Math.cos(b) * r, sb = Math.sin(b) * r;
    for (let x = 0; x < size; x++) {
      const a = (x / size) * 2 * Math.PI, ca = Math.cos(a) * r, sa = Math.sin(a) * r;
      for (let c = 0; c < 4; c++) {
        const v = noise[c](ca, sa, cb, sb); // about -1..1
        out[(y * size + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(128 + 127 * v)));
      }
    }
  }
  return out;
}

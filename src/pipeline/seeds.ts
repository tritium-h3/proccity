// Per-stage seeding: re-running a stage with the same input and settings
// reproduces it exactly, so undo is exact and regenerating stage k leaves
// stages before k untouched.

/** mulberry32: small, fast, seeded. Floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a of the stage id, mixed with the city seed and the stage's reroll offset. */
export function stageSeed(citySeed: number, stageId: string, offset: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < stageId.length; i++) {
    h ^= stageId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= citySeed >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= Math.imul(offset + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

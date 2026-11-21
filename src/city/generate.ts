// City layout generation. Pure data, no Three.js: the scene layer turns this
// into meshes. Units are metres; the ground is the XZ plane, Y is up, and the
// city is centred on the origin.
//
// Proof-of-concept model: a regular street grid of square blocks, each split
// into lotsPerSide × lotsPerSide lots with one box building per lot. Height
// follows a downtown falloff from the centre plus noise and the odd tower.

import { createRng } from './rng.js';

/** Axis-aligned rectangle on the ground, by centre and size. */
export interface Rect { x: number; z: number; width: number; depth: number }

export interface Building extends Rect {
  height: number;
  /** index into City.blocks */
  block: number;
  /** 0..1, for per-building colour variation */
  tint: number;
}

export interface City {
  /** overall extent, streets included */
  width: number;
  depth: number;
  blocks: Rect[];
  buildings: Building[];
}

export interface CityOptions {
  seed: number;
  blocksX: number;
  blocksZ: number;
  /** side of a block (pavement included), metres */
  blockSize: number;
  streetWidth: number;
  lotsPerSide: number;
  /** pavement margin inside each block edge */
  pavement: number;
}

export const DEFAULT_OPTIONS: CityOptions = {
  seed: 1,
  blocksX: 10,
  blocksZ: 10,
  blockSize: 60,
  streetWidth: 14,
  lotsPerSide: 2,
  pavement: 3,
};

export function generateCity(options: CityOptions): City {
  const { seed, blocksX, blocksZ, blockSize, streetWidth, lotsPerSide, pavement } = options;
  const rand = createRng(seed);
  const pitch = blockSize + streetWidth;
  const width = blocksX * pitch + streetWidth;
  const depth = blocksZ * pitch + streetWidth;
  const radius = Math.min(width, depth) / 2;

  const blocks: Rect[] = [];
  const buildings: Building[] = [];

  for (let i = 0; i < blocksX; i++) {
    for (let j = 0; j < blocksZ; j++) {
      const block: Rect = {
        x: -width / 2 + streetWidth + i * pitch + blockSize / 2,
        z: -depth / 2 + streetWidth + j * pitch + blockSize / 2,
        width: blockSize,
        depth: blockSize,
      };
      const blockIndex = blocks.push(block) - 1;

      const inner = blockSize - 2 * pavement;
      const lot = inner / lotsPerSide;
      for (let u = 0; u < lotsPerSide; u++) {
        for (let v = 0; v < lotsPerSide; v++) {
          const cx = block.x - inner / 2 + (u + 0.5) * lot;
          const cz = block.z - inner / 2 + (v + 0.5) * lot;
          // Setback 4–18% of the lot each way, so neighbours don't fuse.
          const w = lot * (0.82 + rand() * 0.14);
          const d = lot * (0.82 + rand() * 0.14);

          const r = Math.hypot(cx, cz) / radius;
          const downtown = Math.exp(-((r / 0.38) ** 2));
          let height = 8 + rand() * 14 + downtown * (40 + rand() * 90);
          if (rand() < 0.04 + downtown * 0.12) height *= 1.6 + rand() * 0.8; // occasional tower

          buildings.push({ x: cx, z: cz, width: w, depth: d, height, block: blockIndex, tint: rand() });
        }
      }
    }
  }

  return { width, depth, blocks, buildings };
}

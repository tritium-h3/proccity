// Lot sizes: a target frontage × depth per zone at density step 9, scaled on both sides as the
// step falls (the owner: a sparser step means wider frontage and deeper lots, same buildings) and
// by the Lot size setting. Big-lot zones (towers, strip malls, office parks) take a block-sized
// target, so most of their blocks stay one lot. Starting values: Claude's, for the owner's eyes.
// Design: docs/superpowers/specs/2026-11-27-lots-design.md

import type { Zone } from '../blocks/rules.js';
import { lotFactor } from '../subdistricts/rules.js';

type Size = { frontage: number; depth: number };

export const BIG_LOT = new Set<Zone>(['MC', 'MO', 'UO', 'UCO', 'UCOR']);

// At step 9. Big lots: the blocks stage's densest default block (another stage's settings aren't
// visible here).
const AT_9: Record<Zone, Size> = {
  LR: { frontage: 12, depth: 24 }, LC: { frontage: 20, depth: 30 }, LO: { frontage: 20, depth: 30 },
  HR: { frontage: 10, depth: 25 }, HC: { frontage: 10, depth: 25 }, HO: { frontage: 10, depth: 25 }, HCR: { frontage: 10, depth: 25 }, HCO: { frontage: 10, depth: 25 },
  MR: { frontage: 25, depth: 30 }, MCR: { frontage: 25, depth: 30 },
  UR: { frontage: 30, depth: 30 }, UCR: { frontage: 30, depth: 30 },
  MC: { frontage: 160, depth: 70 }, MO: { frontage: 160, depth: 70 }, UO: { frontage: 160, depth: 70 }, UCO: { frontage: 160, depth: 70 }, UCOR: { frontage: 160, depth: 70 },
};
// The least a block must hold of a big-lot zone: an urban-core lot, not a whole block.
const BIG_MIN: Size = { frontage: 30, depth: 30 };

const scaled = (s: Size, step: number, scale: number): Size => {
  const k = lotFactor(step) * scale;
  return { frontage: s.frontage * k, depth: s.depth * k };
};

export const lotTarget = (zone: Zone, step: number, scale = 1): Size => scaled(AT_9[zone], step, scale);

/** The smallest lot a block of this zone must hold. */
export const minLot = (zone: Zone, step: number, scale = 1): Size => scaled(BIG_LOT.has(zone) ? BIG_MIN : AT_9[zone], step, scale);

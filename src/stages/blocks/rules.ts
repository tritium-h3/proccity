// What a block may be. Copied from the owner's notes (docs/notes/zoningBlocks.md), which are the
// source of truth: the zones, which zones each district type allows, and which road categories a
// zone's lots may face. Residential never faces an arterial: a deliberate rule, not realism.

import type { DistrictType } from '../districts/rules.js';

export const ZONES = ['LR', 'LC', 'LO', 'HR', 'HC', 'HO', 'HCR', 'HCO', 'MR', 'MC', 'MO', 'MCR', 'UR', 'UO', 'UCR', 'UCO', 'UCOR'] as const;
export type Zone = typeof ZONES[number];

/** Road categories: Arterial, Collector, Local. */
export type Category = 'A' | 'C' | 'L';

export const FACES: Record<Zone, Category[]> = {
  LR: ['L'], LC: ['L', 'C'], LO: ['L', 'C'],
  HR: ['L'], HC: ['C'], HO: ['L', 'C'], HCR: ['L', 'C'], HCO: ['L', 'C'],
  MR: ['L'], MC: ['C', 'A'], MO: ['C', 'A'], MCR: ['C'],
  UR: ['L'], UO: ['L', 'C'], UCR: ['L', 'C'], UCO: ['L', 'C'], UCOR: ['L', 'C'],
};

export type Developed = Exclude<DistrictType, 'undeveloped'>;

export const DISTRICT_ZONES: Record<Developed, Zone[]> = {
  rural: ['LR', 'LC', 'LO', 'MC', 'MO'],
  suburban: ['LR', 'LC', 'LO'],
  'town-core': ['LR', 'HR', 'HC', 'HO', 'HCR', 'HCO'],
  'town-business': ['HR', 'HC', 'HO', 'HCR', 'HCO', 'MR', 'MC', 'MO', 'MCR'],
  'low-urban': ['MR', 'MC', 'MCR'],
  urban: ['MR', 'MC', 'MCR', 'UR', 'UCR', 'UCO'],
  financial: ['UO', 'UCO', 'UCOR'],
};

export type Use = 'R' | 'C' | 'O';

/** A zone's uses, read from its letters after the density (UCOR: commercial, office, residential). */
export const USES = Object.fromEntries(ZONES.map(z => [z, [...z.slice(1)] as Use[]])) as Record<Zone, Use[]>;

// How often each use turns up, per district type (the spec's table; the owner tunes these).
const SPARSE = { R: 6, C: 1, O: 1 }, MIXED = { R: 3, C: 3, O: 1 };
export const USE_WEIGHTS: Record<DistrictType, Record<Use, number>> = {
  undeveloped: { R: 0, C: 0, O: 0 },
  rural: SPARSE, suburban: SPARSE,
  'town-core': { R: 1, C: 4, O: 1 },
  'town-business': { R: 1, C: 1, O: 4 },
  'low-urban': MIXED, urban: MIXED,
  financial: { R: 0.5, C: 1, O: 4 },
};

/** A mixed zone weighs the mean of its uses, so it neither dominates nor vanishes. */
export function zoneWeight(t: DistrictType, z: Zone): number {
  const u = USES[z];
  return u.reduce((s, x) => s + USE_WEIGHTS[t][x], 0) / u.length;
}

export type Family = 'sparse' | 'dense';
export const familyOf = (t: DistrictType): Family => (t === 'suburban' || t === 'rural' ? 'sparse' : 'dense');

/** Provisional smallest lots per density (metres); the lots stage will own the real ones. A
 *  block must hold at least one lot of its smallest zone. */
export const MIN_LOT: Record<'L' | 'H' | 'M' | 'U', { frontage: number; depth: number }> = {
  L: { frontage: 20, depth: 35 }, H: { frontage: 8, depth: 25 }, M: { frontage: 30, depth: 40 }, U: { frontage: 30, depth: 30 },
};
export const densityOf = (z: Zone) => z[0] as keyof typeof MIN_LOT;

/** The smallest lot any of a district's zones allows (area and depth). */
export function smallestLot(t: Developed): { area: number; depth: number } {
  const lots = DISTRICT_ZONES[t].map(z => MIN_LOT[densityOf(z)]);
  return { area: Math.min(...lots.map(l => l.frontage * l.depth)), depth: Math.min(...lots.map(l => l.depth)) };
}

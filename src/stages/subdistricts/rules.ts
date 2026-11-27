// The density ladder: one scale of steps, 1 (sparsest) to 9 (densest), shared by every district
// type. Each type covers a few steps (its levels, level 1 the densest), and types next in rank
// overlap or touch, so a district border is a partial step. A sub-district's code is its type's
// letter and its step (F9); 0 is Undeveloped (U0). Its name is the type and a level word.
// Design: docs/superpowers/specs/2026-11-27-subdistricts-design.md

import { TYPE_LABEL, type DistrictType } from '../districts/rules.js';
import type { Developed } from '../blocks/rules.js';

export const STEPS: Record<Developed, number[]> = {
  rural: [1], suburban: [4, 3, 2], 'town-core': [5, 4], 'town-business': [6, 5],
  'low-urban': [7, 6, 5], urban: [8, 7, 6], financial: [9, 8],
};

export const LETTER: Record<Developed, string> = {
  rural: 'R', suburban: 'S', 'town-core': 'T', 'town-business': 'B', 'low-urban': 'L', urban: 'U', financial: 'F',
};

const WORDS: Record<number, string[]> = { 1: [''], 2: ['High', 'Low'], 3: ['High', 'Mid', 'Low'] };

/** Chance weight of an Undeveloped sub-district, before the field and the Open land setting. */
export const OPEN: Record<Developed, number> = {
  rural: 0.5, suburban: 0.35, 'town-core': 0.15, 'town-business': 0.1, 'low-urban': 0.1, urban: 0.08, financial: 0,
};

/** A type's density in the implied field: the middle of its range. Undeveloped land is 0. */
export function nominal(t: DistrictType): number {
  if (t === 'undeveloped') return 0;
  const r = STEPS[t];
  return (r[0] + r[r.length - 1]) / 2;
}

export const codeOf = (t: Developed, step: number) => `${LETTER[t]}${step}`;

export function labelOf(t: Developed, step: number): string {
  if (step === 0) return 'Undeveloped';
  const r = STEPS[t];
  const word = WORDS[r.length][r.indexOf(step)];
  return word ? `${TYPE_LABEL[t]} ${word}` : TYPE_LABEL[t];
}

export const allowed = (t: Developed, step: number) => step === 0 || STEPS[t].includes(step);

export function clampStep(t: Developed, f: number): number {
  const r = STEPS[t];
  return Math.min(r[0], Math.max(r[r.length - 1], Math.round(f)));
}

export interface SpacingSettings {
  densestDepth: number; densestLength: number; densestCollectors: number;
  sparsestDepth: number; sparsestLength: number; sparsestCollectors: number;
}

// Geometric between the ends: each step is the same ratio, as sizes are felt.
const between = (dense: number, sparse: number, step: number) => dense * (sparse / dense) ** ((9 - step) / 8);

/** Block depth, block length and collector spacing at a step. */
export const spacing = (step: number, s: SpacingSettings) => ({
  depth: between(s.densestDepth, s.sparsestDepth, step),
  length: between(s.densestLength, s.sparsestLength, step),
  collectors: between(s.densestCollectors, s.sparsestCollectors, step),
});

/** Interim: how much bigger the smallest lot is (each side) at a step. The lots stage will define
 *  lot size from zone and density together. */
export const lotFactor = (step: number) => 2 ** ((9 - step) / 8);

import { describe, expect, it } from 'vitest';
import { TYPES } from '../districts/rules.js';
import type { Developed } from '../blocks/rules.js';
import { allowed, clampStep, codeOf, labelOf, lotFactor, nominal, spacing, STEPS } from './rules.js';

const S = { densestDepth: 70, densestLength: 160, densestCollectors: 400, sparsestDepth: 150, sparsestLength: 500, sparsestCollectors: 900 };
const DEV = TYPES.filter(t => t !== 'undeveloped') as Developed[];

describe('density ladder', () => {
  it('codes a sub-district by type letter and step', () => {
    expect(codeOf('financial', 9)).toBe('F9');
    expect(codeOf('urban', 0)).toBe('U0');
    expect(codeOf('town-business', 6)).toBe('B6');
  });
  it('names it by type and level word', () => {
    expect(labelOf('financial', 9)).toBe('Financial High');
    expect(labelOf('financial', 8)).toBe('Financial Low');
    expect(labelOf('urban', 7)).toBe('Urban Mid');
    expect(labelOf('rural', 1)).toBe('Rural');
    expect(labelOf('urban', 0)).toBe('Undeveloped');
  });
  it('allows only the type’s own steps, and 0 always', () => {
    expect(allowed('suburban', 5)).toBe(false);
    expect(allowed('suburban', 4)).toBe(true);
    expect(allowed('financial', 0)).toBe(true);
  });
  it('rounds a field value into the type’s range', () => {
    expect(clampStep('low-urban', 9.3)).toBe(7);
    expect(clampStep('low-urban', 5.4)).toBe(5);
    expect(clampStep('low-urban', 6.6)).toBe(7);
    expect(nominal('suburban')).toBe(3);
    expect(nominal('undeveloped')).toBe(0);
  });
  it('lists level 1 as the densest step', () => {
    expect(STEPS.financial).toEqual([9, 8]);
    expect(STEPS.rural).toEqual([1]);
  });
  it('keeps types next in rank within a step of each other', () => {
    for (let i = 1; i < DEV.length; i++) {
      const a = DEV[i - 1], b = DEV[i];
      const gap = Math.max(Math.min(...STEPS[a]) - Math.max(...STEPS[b]), Math.min(...STEPS[b]) - Math.max(...STEPS[a]));
      expect(gap, `${a}–${b}`).toBeLessThanOrEqual(1);
    }
  });
  it('spaces streets from densest to sparsest', () => {
    expect(spacing(9, S)).toEqual({ depth: 70, length: 160, collectors: 400 });
    expect(spacing(1, S).depth).toBeCloseTo(150);
    for (let k = 2; k <= 9; k++) expect(spacing(k, S).length).toBeLessThan(spacing(k - 1, S).length);
    expect(lotFactor(9)).toBe(1);
    expect(lotFactor(1)).toBeCloseTo(2);
  });
});

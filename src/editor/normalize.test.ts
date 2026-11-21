import { describe, it, expect } from 'vitest';
import { createCityDoc } from '../doc/create.js';
import { STAGES } from '../stages/index.js';
import { normalizeStages } from './normalize.js';

const doc = () => createCityDoc({ name: 'x', seed: 1, now: 'n', id: 'i', stages: [] });

describe('normalizeStages (review: Important 5)', () => {
  it('adds missing registry stages with defaults, in registry order', () => {
    const d = normalizeStages({ ...doc(), stages: [{ id: 'debug-split', settings: { heightLimit: 90 }, seedOffset: 2 }] }, STAGES);
    expect(d.stages.map(s => s.id)).toEqual(['debug-grid', 'debug-split']);
    expect(d.stages[0]).toEqual({ id: 'debug-grid', settings: { cells: 6 }, seedOffset: 0 });
    expect(d.stages[1]).toEqual({ id: 'debug-split', settings: { heightLimit: 90 }, seedOffset: 2 });
  });

  it('keeps unknown stage states after the registry ones', () => {
    const d = normalizeStages({ ...doc(), stages: [{ id: 'retired', settings: {}, seedOffset: 0 }] }, STAGES);
    expect(d.stages.map(s => s.id)).toEqual(['debug-grid', 'debug-split', 'retired']);
  });

  it('clamps generatedThrough to the registry', () => {
    expect(normalizeStages({ ...doc(), generatedThrough: 7 }, STAGES).generatedThrough).toBe(1);
    expect(normalizeStages({ ...doc(), generatedThrough: -3 }, STAGES).generatedThrough).toBe(-1);
  });
});

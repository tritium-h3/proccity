import { describe, it, expect } from 'vitest';
import { createCityDoc } from '../doc/create.js';
import { FAKE_STAGES as STAGES } from '../stages/testing.js';
import { normalizeStages } from './normalize.js';
import { STAGES as REAL } from '../stages/index.js';
import { walk } from '../doc/tree.js';
import type { RegionNode } from '../doc/types.js';

const doc = () => createCityDoc({ name: 'x', seed: 1, now: 'n', id: 'i', stages: [] });

describe('normalizeStages (review: Important 5)', () => {
  it('adds missing registry stages with defaults, in registry order', () => {
    const d = normalizeStages({ ...doc(), stages: [{ id: 'fake-split', settings: { heightLimit: 90 }, seedOffset: 2 }] }, STAGES);
    expect(d.stages.map(s => s.id)).toEqual(['fake-grid', 'fake-split']);
    expect(d.stages[0]).toEqual({ id: 'fake-grid', settings: { cells: 6 }, seedOffset: 0 });
    expect(d.stages[1]).toEqual({ id: 'fake-split', settings: { heightLimit: 90 }, seedOffset: 2 });
  });

  it('keeps unknown stage states after the registry ones', () => {
    const d = normalizeStages({ ...doc(), stages: [{ id: 'retired', settings: {}, seedOffset: 0 }] }, STAGES);
    expect(d.stages.map(s => s.id)).toEqual(['fake-grid', 'fake-split', 'retired']);
  });

  it('clamps generatedThrough to the registry', () => {
    expect(normalizeStages({ ...doc(), generatedThrough: 7 }, STAGES).generatedThrough).toBe(1);
    expect(normalizeStages({ ...doc(), generatedThrough: -3 }, STAGES).generatedThrough).toBe(-1);
  });

  it('steps a saved city back to before a stage inserted inside its generated range', () => {
    const base = doc();
    const leaf = (id: string, stage: string): RegionNode => ({ id, name: id, kind: stage, stage, geometry: base.tree.geometry, attrs: {}, children: [] });
    const tree = { ...base.tree, children: [{ ...leaf('site/a', 'arterials'), children: [leaf('site/a/b', 'blocks')] }] };
    const old = ['terrain', 'districts', 'arterials', 'blocks'].map(id => ({ id, settings: {}, seedOffset: 0 }));
    const d = normalizeStages({ ...base, tree, stages: old, generatedThrough: 3 }, REAL);
    expect(d.stages.map(s => s.id)).toEqual(['terrain', 'districts', 'arterials', 'subdistricts', 'blocks']);
    expect(d.generatedThrough).toBe(2);
    const stages: string[] = [];
    walk(d.tree, n => { stages.push(n.stage); });
    expect(stages).not.toContain('blocks');
    expect(stages).toContain('arterials');
  });

  it('leaves a city alone when the new stage is past what it generated', () => {
    const old = ['terrain', 'districts', 'arterials', 'blocks'].map(id => ({ id, settings: {}, seedOffset: 0 }));
    const d = normalizeStages({ ...doc(), stages: old, generatedThrough: 2 }, REAL);
    expect(d.generatedThrough).toBe(2);
  });
});

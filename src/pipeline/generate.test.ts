import { describe, it, expect } from 'vitest';
import { createCityDoc } from '../doc/create.js';
import { ancestry, walk } from '../doc/tree.js';
import type { CityDoc, Override, RegionNode } from '../doc/types.js';
import { FAKE_STAGES as STAGES } from '../stages/testing.js';
import { defaultsFor, resolveAttr } from '../stages/settings.js';
import { generate, generateIter } from './generate.js';

const baseDoc = (): CityDoc => ({
  ...createCityDoc({
    name: 'T', seed: 123, now: '2026-11-20T00:00:00.000Z', id: 'c',
    stages: STAGES.map(s => ({ id: s.id, defaults: defaultsFor(s.settings) })),
  }),
  generatedThrough: 1,
});

const nodesOfKind = (tree: RegionNode, kind: string) => {
  const out: RegionNode[] = [];
  walk(tree, n => { if (n.kind === kind) out.push(n); });
  return out;
};

const withSetting = (doc: CityDoc, stage: number, key: string, value: number): CityDoc => ({
  ...doc, stages: doc.stages.map((s, i) => (i === stage ? { ...s, settings: { ...s.settings, [key]: value } } : s)),
});

const anchorOverride: Override = {
  id: 'o1', stage: 'fake-grid', kind: 'cell', anchor: [10, 10],
  settings: { colour: 'violet' }, createdAt: '2026-11-20T01:00:00.000Z',
};

describe('generate', () => {
  it('runs every stage through generatedThrough with valid partitions', () => {
    const r = generate({ doc: baseDoc(), fromStage: 0, stages: STAGES, devChecks: true });
    expect(nodesOfKind(r.tree, 'cell')).toHaveLength(36);
    expect(nodesOfKind(r.tree, 'strip')).toHaveLength(72);
    expect(r.partitionProblems).toEqual([]);
  });

  it('leaves earlier stages identical when regenerating from a later one', () => {
    const doc = baseDoc();
    const first = generate({ doc, fromStage: 0, stages: STAGES });
    const changed = withSetting({ ...doc, tree: first.tree }, 1, 'heightLimit', 120);
    const second = generate({ doc: changed, fromStage: 1, stages: STAGES });
    const strip = (t: RegionNode) => ({ ...t, children: [] });
    expect(nodesOfKind(second.tree, 'cell').map(strip)).toEqual(nodesOfKind(first.tree, 'cell').map(strip));
    expect(nodesOfKind(second.tree, 'buildable')[0].geometry.height.high).toBe(120);
  });

  it('is deterministic', () => {
    expect(generate({ doc: baseDoc(), fromStage: 0, stages: STAGES }))
      .toEqual(generate({ doc: baseDoc(), fromStage: 0, stages: STAGES }));
  });

  it('rerolls a stage via its seedOffset', () => {
    const doc = baseDoc();
    const colours = (d: CityDoc) => nodesOfKind(generate({ doc: d, fromStage: 0, stages: STAGES }).tree, 'cell').map(c => c.attrs.colour);
    const rerolled = { ...doc, stages: doc.stages.map((s, i) => (i === 0 ? { ...s, seedOffset: 1 } : s)) };
    expect(colours(rerolled)).not.toEqual(colours(doc));
  });

  it('stops at generatedThrough', () => {
    const r = generate({ doc: { ...baseDoc(), generatedThrough: 0 }, fromStage: 0, stages: STAGES });
    expect(nodesOfKind(r.tree, 'strip')).toHaveLength(0);
  });

  it('applies overrides, and children inherit them', () => {
    const r = generate({ doc: { ...baseDoc(), overrides: [anchorOverride] }, fromStage: 0, stages: STAGES });
    const cell = nodesOfKind(r.tree, 'cell').find(c => c.attrs.colour === 'violet' && c.id === 'site/cell:3-3');
    expect(cell).toBeDefined();
    const strip = cell!.children[0];
    expect(resolveAttr(ancestry(r.tree, strip.id), 'colour', {})).toBe('violet');
    expect(r.overrides).toEqual([anchorOverride]);
  });

  it('drops an override that falls off a shrunk site, and lands it again when restored', () => {
    const shrunk = { ...baseDoc(), site: { size: 10 }, overrides: [{ ...anchorOverride, anchor: [500, 500] as [number, number] }] };
    const r = generate({ doc: shrunk, fromStage: 0, stages: STAGES });
    expect(r.dropped.map(d => d.reason)).toEqual(['no-region']);
    expect(r.overrides).toEqual([]);
    const restored = generate({ doc: { ...shrunk, site: { size: 2000 } }, fromStage: 0, stages: STAGES });
    expect(restored.dropped).toEqual([]);
    expect(restored.overrides).toHaveLength(1);
  });

  it('yields once per stage before returning', () => {
    const it = generateIter({ doc: baseDoc(), fromStage: 0, stages: STAGES });
    expect(it.next().value).toEqual({ stageIndex: 0 });
    expect(it.next().value).toEqual({ stageIndex: 1 });
    const end = it.next();
    expect(end.done).toBe(true);
  });
});

import { fakeAnnotate, fakeGrid } from '../stages/testing.js';

describe('stage annotations (terrain plan Task 2)', () => {
  const annotDoc = (): CityDoc => ({
    ...createCityDoc({ name: 'A', seed: 1, now: 'n', id: 'a', stages: [{ id: 'fake-annotate', defaults: {} }] }),
    generatedThrough: 0,
  });

  it('merges annotation data onto existing regions and records its stage', () => {
    const r = generate({ doc: annotDoc(), fromStage: 0, stages: [fakeAnnotate] });
    expect(r.tree.data?.heightfield?.cols).toBe(2);
    expect(r.tree.dataStage?.heightfield).toBe('fake-annotate');
  });

  it('strips annotation data when its stage is pruned, keeping earlier stages', () => {
    const doc2 = (): CityDoc => ({
      ...createCityDoc({ name: 'B', seed: 1, now: 'n', id: 'b', stages: [{ id: 'fake-grid', defaults: { cells: 2 } }, { id: 'fake-annotate', defaults: {} }] }),
      generatedThrough: 1,
    });
    const first = generate({ doc: doc2(), fromStage: 0, stages: [fakeGrid, fakeAnnotate] });
    expect(first.tree.data?.heightfield).toBeDefined();
    const cleared = generate({ doc: { ...doc2(), tree: first.tree, generatedThrough: 0 }, fromStage: 1, stages: [fakeGrid, fakeAnnotate] });
    expect(cleared.tree.data?.heightfield).toBeUndefined();
    expect(cleared.tree.dataStage?.heightfield).toBeUndefined();
    expect(cleared.tree.children).toHaveLength(4); // fake-grid cells kept
  });

  it('passes a stage its own overrides before resolution', () => {
    let seen: unknown[] = [];
    const spy = { ...fakeGrid, run: (input: Parameters<typeof fakeGrid.run>[0]) => { seen = input.overridesForStage; return fakeGrid.run(input); } };
    generate({ doc: { ...baseDoc(), overrides: [anchorOverride, { ...anchorOverride, id: 'o2', stage: 'other' }] }, fromStage: 0, stages: [spy, STAGES[1]] });
    expect(seen).toEqual([anchorOverride]);
  });

  it('generates past regions from stages it no longer knows (old debug cities)', () => {
    const first = generate({ doc: baseDoc(), fromStage: 0, stages: STAGES });
    const relabelled = JSON.parse(JSON.stringify(first.tree).replaceAll('"fake-split"', '"debug-split"')) as RegionNode;
    expect(() => generate({ doc: { ...baseDoc(), tree: relabelled }, fromStage: 1, stages: STAGES })).not.toThrow();
  });
});

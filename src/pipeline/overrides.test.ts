import { describe, it, expect } from 'vitest';
import { createSite } from '../doc/create.js';
import { leaves } from '../doc/tree.js';
import type { Override, RegionNode } from '../doc/types.js';
import { rect } from '../grammar/polygon.js';
import { makeSlab } from '../grammar/slab.js';
import { debugGrid } from '../stages/debug-grid/stage.js';
import { resolveAttr } from '../stages/settings.js';
import type { Stage } from '../stages/types.js';
import { describeDrop, resolveOverrides } from './overrides.js';

const site = createSite(2000);
const cells = debugGrid.run({
  tree: site, leaves: leaves(site), settings: { cells: 3 }, rng: () => 0.1,
  attr: (n, k) => resolveAttr([n], k, {}),
}).children.get('site')!;

let seq = 0;
const ov = (anchor: [number, number], settings: Override['settings'], extra: Partial<Override> = {}): Override => ({
  id: `o${++seq}`, stage: 'debug-grid', kind: 'cell', anchor, settings,
  createdAt: `2026-11-20T00:00:${String(seq).padStart(2, '0')}.000Z`, ...extra,
});

describe('resolveOverrides', () => {
  it('applies an override to the cell under its anchor', () => {
    const o = ov([0, 0], { colour: 'violet' });
    const r = resolveOverrides(debugGrid, cells, [o]);
    expect(r.applied.get('site/cell:1-1')).toEqual({ colour: 'violet' });
    expect(r.kept).toEqual([o]);
    expect(r.dropped).toEqual([]);
  });

  it('drops an override whose spot has no region', () => {
    const r = resolveOverrides(debugGrid, cells, [ov([5000, 5000], { colour: 'violet' })]);
    expect(r.dropped.map(d => d.reason)).toEqual(['no-region']);
    expect(describeDrop(r.dropped[0])).toBe(`Dropped "colour: violet" on a cell: there's no cell at that spot any more.`);
  });

  it('names what now covers the spot when it is a different kind', () => {
    const r = resolveOverrides(debugGrid, cells, [ov([0, 0], { use: 'church' }, { kind: 'block' })]);
    expect(r.dropped[0].reason).toBe('no-region');
    expect(describeDrop(r.dropped[0])).toBe(`Dropped "use: church" on a block: that spot is now a cell.`);
  });

  it('drops invalid values and unknown keys', () => {
    const r = resolveOverrides(debugGrid, cells, [ov([0, 0], { colour: 'pink' }), ov([0, 0], { height: 3 })]);
    expect(r.dropped.map(d => d.reason)).toEqual(['invalid-setting', 'invalid-setting']);
    expect(describeDrop(r.dropped[0])).toBe(`Dropped "colour: pink" on a cell: that cell doesn't accept colour: pink.`);
  });

  it('lets the newer of two overrides on the same region and key win', () => {
    const older = ov([10, 10], { colour: 'red' });
    const newer = ov([-10, -10], { colour: 'blue' });
    const r = resolveOverrides(debugGrid, cells, [newer, older]);
    expect(r.applied.get('site/cell:1-1')).toEqual({ colour: 'blue' });
    expect(r.dropped.map(d => [d.override.id, d.reason])).toEqual([[older.id, 'superseded']]);
    expect(describeDrop(r.dropped[0])).toBe(`Dropped "colour: red" on a cell: a newer override on the same cell replaced it.`);
  });

  it('leaves overrides for other stages untouched and kept', () => {
    const other = ov([0, 0], { x: 1 }, { stage: 'districts' });
    const r = resolveOverrides(debugGrid, cells, [other]);
    expect(r.kept).toEqual([other]);
    expect(r.applied.size).toBe(0);
  });

  it('picks the lowest region when several are stacked at the anchor', () => {
    const zone = (name: string, low: number, high: number | null): RegionNode => ({
      id: `site/${name}`, name, kind: 'zone', stage: 'test', attrs: {}, children: [],
      geometry: makeSlab(rect(-10, -10, 10, 10), low, high),
    });
    const stage: Stage = {
      id: 'test', title: 'Test', settings: [], run: () => ({ children: new Map() }),
      overridable: { zone: [{ key: 'tag', label: 'Tag', type: 'boolean', default: false }] },
    };
    const r = resolveOverrides(stage, [zone('upper', 40, null), zone('lower', 0, 40)], [ov([0, 0], { tag: true }, { stage: 'test', kind: 'zone' })]);
    expect([...r.applied.keys()]).toEqual(['site/lower']);
  });
});

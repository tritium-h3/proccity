import { describe, it, expect } from 'vitest';
import { createSite } from '../doc/create.js';
import { ancestry, attachChildren, leaves } from '../doc/tree.js';
import type { RegionNode, Settings } from '../doc/types.js';
import { checkPartition } from '../grammar/partition.js';
import { createRng as rng } from '../pipeline/seeds.js';
import { debugGrid, DEBUG_COLOURS } from './debug-grid/stage.js';
import { debugSplit } from './debug-split/stage.js';
import { resolveAttr } from './settings.js';
import type { Stage } from './types.js';


function run(stage: Stage, tree: RegionNode, settings: Settings, seed = 1) {
  return stage.run({
    tree, leaves: leaves(tree), settings, rng: rng(seed),
    attr: (node, key) => resolveAttr(ancestry(tree, node.id), key, settings),
  });
}

describe('debug-grid', () => {
  it('splits the site into cells × cells coloured cells that partition it', () => {
    const site = createSite(2000);
    const out = run(debugGrid, site, { cells: 3 });
    const cells = out.children.get('site')!;
    expect(cells).toHaveLength(9);
    for (const c of cells) {
      expect(c.kind).toBe('cell');
      expect(DEBUG_COLOURS).toContain(c.attrs.colour);
    }
    expect(checkPartition(site.geometry, cells.map(c => c.geometry)).ok).toBe(true);
  });

  it('is reproducible for the same rng seed', () => {
    const site = createSite(2000);
    expect(run(debugGrid, site, { cells: 3 }, 7)).toEqual(run(debugGrid, site, { cells: 3 }, 7));
  });
});

describe('debug-split', () => {
  const grid = () => {
    const site = createSite(2000);
    return attachChildren(site, run(debugGrid, site, { cells: 3 }).children);
  };

  it('halves every cell into two strips, each split into buildable and airspace', () => {
    const tree = grid();
    const out = run(debugSplit, tree, { heightLimit: 60 });
    expect(out.children.size).toBe(9);
    for (const [cellId, strips] of out.children) {
      expect(strips.map(s => s.kind)).toEqual(['strip', 'strip']);
      const cell = leaves(tree).find(l => l.id === cellId)!;
      expect(checkPartition(cell.geometry, strips.map(s => s.geometry)).ok).toBe(true);
      for (const s of strips) {
        expect(s.children.map(c => c.kind)).toEqual(['buildable', 'airspace']);
        expect(s.children[0].geometry.height).toEqual({ ref: 'ground', low: 0, high: 60 });
        expect(s.children[1].geometry.height).toEqual({ ref: 'ground', low: 60, high: null });
        expect(checkPartition(s.geometry, s.children.map(c => c.geometry)).ok).toBe(true);
      }
    }
  });

  it('leaves strips whole when there is no height limit', () => {
    const out = run(debugSplit, grid(), { heightLimit: 0 });
    for (const strips of out.children.values()) for (const s of strips) expect(s.children).toEqual([]);
  });
});

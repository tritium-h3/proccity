// THROWAWAY: a second stage so "Next", "Clear after", attribute inheritance
// and vertical (height) splits have something to act on. Delete with debug-grid.

import { childId } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import { split } from '../../grammar/ops.js';
import type { Stage } from '../types.js';

export const debugSplit: Stage = {
  id: 'debug-split',
  title: 'Debug split',
  settings: [{ key: 'heightLimit', label: 'Height limit', type: 'number', min: 0, max: 200, step: 5, default: 60, unit: 'm' }],
  run({ leaves, settings, rng }) {
    const limit = settings.heightLimit as number;
    const children = new Map<string, RegionNode[]>();
    for (const cell of leaves.filter(l => l.kind === 'cell')) {
      const halves = split(cell.geometry, rng() < 0.5 ? 'x' : 'z', ['1r', '1r']);
      children.set(cell.id, halves.map((geometry, i) => {
        const id = childId(cell.id, `strip:${i}`);
        const strip: RegionNode = { id, name: `strip:${i}`, kind: 'strip', stage: 'debug-split', geometry, attrs: {}, children: [] };
        if (limit > 0) {
          const [low, high] = split(geometry, 'y', [limit, '1r']);
          strip.children = [
            { id: childId(id, 'buildable'), name: 'buildable', kind: 'buildable', stage: 'debug-split', geometry: low, attrs: {}, children: [] },
            { id: childId(id, 'airspace'), name: 'airspace', kind: 'airspace', stage: 'debug-split', geometry: high, attrs: {}, children: [] },
          ];
        }
        return strip;
      }));
    }
    return { children };
  },
};

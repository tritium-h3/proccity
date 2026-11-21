// THROWAWAY: exercises the pipeline, overrides and undo until real stages
// exist. Delete when terrain and districts land.

import { childId } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import { split } from '../../grammar/ops.js';
import type { SettingField, Stage } from '../types.js';

export const DEBUG_COLOURS = ['red', 'amber', 'green', 'teal', 'blue', 'violet'] as const;

const colourField: SettingField = {
  key: 'colour', label: 'Colour', type: 'choice', default: 'red',
  options: DEBUG_COLOURS.map(c => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })),
};

export const debugGrid: Stage = {
  id: 'debug-grid',
  title: 'Debug grid',
  settings: [{ key: 'cells', label: 'Cells per side', type: 'number', min: 2, max: 12, step: 1, default: 6 }],
  overridable: { cell: [colourField] },
  run({ leaves, settings, rng }) {
    const n = settings.cells as number;
    const children = new Map<string, RegionNode[]>();
    for (const leaf of leaves.filter(l => l.kind === 'site')) {
      const cells: RegionNode[] = [];
      split(leaf.geometry, 'x', Array(n).fill('1r')).forEach((col, i) => {
        split(col, 'z', Array(n).fill('1r')).forEach((geometry, j) => {
          const name = `cell:${i}-${j}`;
          cells.push({
            id: childId(leaf.id, name), name, kind: 'cell', stage: 'debug-grid', geometry,
            attrs: { colour: DEBUG_COLOURS[Math.floor(rng() * DEBUG_COLOURS.length)] }, children: [],
          });
        });
      });
      children.set(leaf.id, cells);
    }
    return { children };
  },
};

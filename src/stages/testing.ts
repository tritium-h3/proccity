// TEST-ONLY stages for pipeline, override and editor tests. Never registered in STAGES.
// fakeGrid/fakeSplit are the former debug stages; fakeAnnotate exercises StageOutput.data.

import { childId } from '../doc/tree.js';
import type { RegionNode } from '../doc/types.js';
import { split } from '../grammar/ops.js';
import type { SettingField, Stage } from './types.js';

export const FAKE_COLOURS = ['red', 'amber', 'green', 'teal', 'blue', 'violet'] as const;

const colourField: SettingField = {
  key: 'colour', label: 'Colour', type: 'choice', default: 'red',
  options: FAKE_COLOURS.map(c => ({ value: c, label: c[0].toUpperCase() + c.slice(1) })),
};

export const fakeGrid: Stage = {
  id: 'fake-grid',
  title: 'Fake grid',
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
            id: childId(leaf.id, name), name, kind: 'cell', stage: 'fake-grid', geometry,
            attrs: { colour: FAKE_COLOURS[Math.floor(rng() * FAKE_COLOURS.length)] }, children: [],
          });
        });
      });
      children.set(leaf.id, cells);
    }
    return { children };
  },
};

export const fakeSplit: Stage = {
  id: 'fake-split',
  title: 'Fake split',
  settings: [{ key: 'heightLimit', label: 'Height limit', type: 'number', min: 0, max: 200, step: 5, default: 60, unit: 'm' }],
  run({ leaves, settings, rng }) {
    const limit = settings.heightLimit as number;
    const children = new Map<string, RegionNode[]>();
    for (const cell of leaves.filter(l => l.kind === 'cell')) {
      const halves = split(cell.geometry, rng() < 0.5 ? 'x' : 'z', ['1r', '1r']);
      children.set(cell.id, halves.map((geometry, i) => {
        const id = childId(cell.id, `strip:${i}`);
        const strip: RegionNode = { id, name: `strip:${i}`, kind: 'strip', stage: 'fake-split', geometry, attrs: {}, children: [] };
        if (limit > 0) {
          const [low, high] = split(geometry, 'y', [limit, '1r']);
          strip.children = [
            { id: childId(id, 'buildable'), name: 'buildable', kind: 'buildable', stage: 'fake-split', geometry: low, attrs: {}, children: [] },
            { id: childId(id, 'airspace'), name: 'airspace', kind: 'airspace', stage: 'fake-split', geometry: high, attrs: {}, children: [] },
          ];
        }
        return strip;
      }));
    }
    return { children };
  },
};

export const fakeAnnotate: Stage = {
  id: 'fake-annotate',
  title: 'Fake annotate',
  settings: [],
  run({ tree }) {
    return {
      children: new Map(),
      data: new Map([[tree.id, { heightfield: { origin: [0, 0], cell: 8, cols: 2, rows: 2, heights: 'AACAPwAAAEAAAEBAAACAQA==' } }]]),
    };
  },
};

export const FAKE_STAGES: Stage[] = [fakeGrid, fakeSplit];

/** The settings every stage had before the 30 km rescale (2026-11-24), for tests written at the
 *  2 km scale: with these, a 2 km site generates as it always did. */
export const SMALL_SCALE = {
  site: 2000,
  terrain: { cellSize: 120, regionSize: 20, pondSize: 4, relief: 150, riverWidth: 40, flatWidth: 2 },
  districts: { districtSize: 8 },
  arterials: { spacing: 700, usableWidth: 60, curveRadius: 60 },
};

/** The 30 km defaults before the 10 km defaults (2026-11-25), for tests of the 30 km scale. */
export const LARGE_SCALE = {
  site: 30000,
  terrain: { cellSize: 1800, regionSize: 4500, pondSize: 900, relief: 600, riverWidth: 150, flatWidth: 2 },
  districts: { districtSize: 1800 },
  arterials: { spacing: 2000, usableWidth: 300, curveRadius: 150 },
};

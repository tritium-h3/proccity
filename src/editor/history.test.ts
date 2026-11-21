import { describe, it, expect } from 'vitest';
import type { Override } from '../doc/types.js';
import { STAGES } from '../stages/index.js';
import { History, regenerateFrom, type EditState } from './history.js';

const base = (): EditState => ({
  seed: 1, site: { size: 2000 }, generatedThrough: 1, overrides: [],
  stages: [{ id: 'debug-grid', settings: { cells: 6 }, seedOffset: 0 }, { id: 'debug-split', settings: { heightLimit: 60 }, seedOffset: 0 }],
});
const withCells = (n: number): EditState => {
  const s = base();
  s.stages[0].settings.cells = n;
  return s;
};
const O: Override = { id: 'o1', stage: 'debug-grid', kind: 'cell', anchor: [5, 5], settings: { colour: 'violet' }, createdAt: '2026-11-20T00:00:00.000Z' };

describe('History', () => {
  it('undoes and redoes', () => {
    const h = new History(base());
    h.push(withCells(4));
    h.push(withCells(8));
    expect(h.undo()?.stages[0].settings.cells).toBe(4);
    expect(h.undo()?.stages[0].settings.cells).toBe(6);
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBeNull();
    expect(h.redo()?.stages[0].settings.cells).toBe(4);
    expect(h.current.stages[0].settings.cells).toBe(4);
  });

  it('clears redo on a new push', () => {
    const h = new History(base());
    h.push(withCells(4));
    h.undo();
    h.push(withCells(9));
    expect(h.canRedo).toBe(false);
    expect(h.redo()).toBeNull();
  });

  it('coalesces consecutive pushes with the same key', () => {
    const h = new History(base());
    h.push(withCells(7), 'cells');
    h.push(withCells(8), 'cells');
    h.push(withCells(9), 'cells');
    expect(h.undo()?.stages[0].settings.cells).toBe(6);
  });

  it('restores an override dropped by the undone edit exactly', () => {
    const a = { ...base(), overrides: [O] };
    const h = new History(a);
    h.push({ ...a, site: { size: 10 }, overrides: [] });
    expect(h.undo()?.overrides).toEqual([O]);
  });

  it('does not alias stored states', () => {
    const s = base();
    const h = new History(s);
    s.stages[0].settings.cells = 99;
    expect(h.current.stages[0].settings.cells).toBe(6);
  });
});

describe('regenerateFrom', () => {
  it('rebuilds everything when the seed or site changes', () => {
    expect(regenerateFrom(base(), { ...base(), seed: 2 }, STAGES)).toBe(0);
    expect(regenerateFrom(base(), { ...base(), site: { size: 900 } }, STAGES)).toBe(0);
  });
  it('starts at the changed stage', () => {
    const b = base();
    b.stages[1].settings.heightLimit = 90;
    expect(regenerateFrom(base(), b, STAGES)).toBe(1);
    const r = base();
    r.stages[1].seedOffset = 1;
    expect(regenerateFrom(base(), r, STAGES)).toBe(1);
  });
  it('starts at an override’s stage when overrides change', () => {
    expect(regenerateFrom(base(), { ...base(), overrides: [O] }, STAGES)).toBe(0);
    expect(regenerateFrom({ ...base(), overrides: [O] }, { ...base(), overrides: [{ ...O, settings: { colour: 'red' } }] }, STAGES)).toBe(0);
  });
  it('generates or prunes when generatedThrough moves', () => {
    expect(regenerateFrom({ ...base(), generatedThrough: 0 }, base(), STAGES)).toBe(1);
    expect(regenerateFrom(base(), { ...base(), generatedThrough: 0 }, STAGES)).toBe(1);
  });
  it('returns null when nothing changed', () => {
    expect(regenerateFrom(base(), base(), STAGES)).toBeNull();
  });
});

import { combineFrom } from './history.js';

describe('combineFrom (review: Critical 1)', () => {
  it('keeps an unapplied earlier stage when a later edit supersedes it', () => {
    // 6→8 cells (from 0) still in flight, then a height edit (from 1): must rebuild from 0.
    expect(combineFrom(0, 1)).toBe(0);
    expect(combineFrom(null, 1)).toBe(1);
    expect(combineFrom(2, null)).toBe(2);
    expect(combineFrom(null, null)).toBeNull();
  });
});

describe('History.depth (review: Important 3)', () => {
  it('tracks how many undo steps exist', () => {
    const h = new History(base());
    expect(h.depth).toBe(0);
    h.push(withCells(4));
    expect(h.depth).toBe(1);
    h.push(withCells(5));
    h.undo();
    expect(h.depth).toBe(1);
  });
});

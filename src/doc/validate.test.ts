import { describe, it, expect } from 'vitest';
import { createCityDoc } from './create.js';
import { CityDocError, parseCityDoc } from './validate.js';

const doc = () =>
  createCityDoc({
    name: 'Test',
    stages: [{ id: 'debug-grid', defaults: { cells: 6 } }],
    seed: 42,
    now: '2026-11-20T00:00:00.000Z',
    id: 'city-1',
  });

describe('parseCityDoc', () => {
  it('round-trips a created document through JSON', () => {
    const d = doc();
    expect(parseCityDoc(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it('rejects another format version, naming the format', () => {
    expect(() => parseCityDoc({ ...doc(), format: 'proccity/0' })).toThrow(CityDocError);
    expect(() => parseCityDoc({ ...doc(), format: 'proccity/0' })).toThrow(/format/);
  });

  it('rejects non-objects and missing trees', () => {
    expect(() => parseCityDoc('nope')).toThrow(CityDocError);
    expect(() => parseCityDoc(null)).toThrow(CityDocError);
    const { tree: _tree, ...noTree } = doc();
    expect(() => parseCityDoc(noTree)).toThrow(CityDocError);
  });

  it('rejects unknown geometry kinds, naming the path', () => {
    const d = doc();
    (d.tree.geometry as unknown as { type: string }).type = 'box';
    expect(() => parseCityDoc(d)).toThrow(/tree\.geometry/);
  });
});

describe('createCityDoc', () => {
  it('starts ungenerated with a 30 km open site', () => {
    const d = doc();
    expect(d.format).toBe('proccity/1');
    expect(d.generatedThrough).toBe(-1);
    expect(d.site.size).toBe(30000);
    expect(d.stages).toEqual([{ id: 'debug-grid', settings: { cells: 6 }, seedOffset: 0 }]);
    expect(d.tree.geometry.height).toEqual({ ref: 'ground', low: 0, high: null });
  });
});


describe('parseCityDoc height maps', () => {
  it('accepts a valid height map on a region', () => {
    const d = doc();
    d.tree.data = { heightfield: { origin: [-1000, -1000], cell: 8, cols: 2, rows: 2, heights: 'AACAPwAAAEAAAEBAAACAQA==' } };
    expect(parseCityDoc(JSON.parse(JSON.stringify(d))).tree.data?.heightfield?.cols).toBe(2);
  });

  it('rejects heights that decode to the wrong count', () => {
    const d = doc();
    d.tree.data = { heightfield: { origin: [0, 0], cell: 8, cols: 3, rows: 3, heights: 'AACAPwAAAEAAAEBAAACAQA==' } }; // 4 values, not 9
    expect(() => parseCityDoc(d)).toThrow(/heightfield/);
  });
});

describe('parseCityDoc ground surfaces', () => {
  it('accepts a valid ground surface', () => {
    const d = doc();
    d.tree.data = { ground: { points: [[0, 0, 1], [1, 0, 2], [0, 1, 3]], triangles: [[0, 1, 2]] } };
    expect(parseCityDoc(JSON.parse(JSON.stringify(d))).tree.data?.ground?.triangles).toHaveLength(1);
  });
  it('rejects a triangle index out of range', () => {
    const d = doc();
    d.tree.data = { ground: { points: [[0, 0, 1]], triangles: [[0, 1, 2]] } };
    expect(() => parseCityDoc(d)).toThrow(/ground/);
  });
});

describe('parseCityDoc roads', () => {
  it('accepts road centrelines', () => {
    const d = doc();
    d.tree.data = { roads: [{ id: 'r0', points: [[0, 0], [10, 5]], exit: false }] };
    expect(parseCityDoc(JSON.parse(JSON.stringify(d))).tree.data?.roads).toHaveLength(1);
  });
  it('rejects a malformed road', () => {
    const d = doc();
    (d.tree as unknown as { data: unknown }).data = { roads: [{ id: 1 }] };
    expect(() => parseCityDoc(d)).toThrow(/roads/);
  });
});

import { describe, it, expect } from 'vitest';
import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { triangleArea } from '../../doc/ground.js';
import { difference, offsetPolygons, union } from '../../grammar/clipper.js';
import { area, containsPoint, rect } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { buildCells, vkey } from './cells.js';
import { computeLevels, riverSurfaceAt } from './elevation.js';
import { constrainedSurface } from './ground.js';
import { classify, mergeRegions } from './rules.js';
import { riverProfile } from './water.js';

const site = rect(-1000, -1000, 1000, 1000);
const sea = rect(-1000, 700, 1000, 1000);
const river = rect(-20, -1000, 20, 700);
const course: Point2[] = [[0, -1000], [0, 0], [0, 700]];
const profile = riverProfile(course, 150, true);
const land = difference(site, union(sea, river));
const cells = buildCells(land, site, sea, river, 120, createRng(1));

function setup(seed: number, overrides: { group: number; elevation: number }[] = []) {
  const c = classify(cells, { flatWidth: 2, hilliness: 0.5, ponds: 4 }, createRng(seed));
  const groups = mergeRegions(cells, c);
  const levels = computeLevels(cells, c, groups, { relief: 150, hilliness: 0.5, flatWidth: 2, course, profile, sea, river, overrides }, createRng(seed + 100));
  return { c, groups, levels };
}
const verts = (poly: MultiPolygon) => poly.flat(2);

describe('computeLevels', () => {
  it('gives shared vertices of neighbouring cells one elevation', () => {
    const { levels } = setup(1);
    for (const cell of cells) for (const p of verts([cell.poly])) expect(levels.vertex.has(vkey(p))).toBe(true);
    // vertex map is keyed, so agreement is by construction; check no NaN
    for (const v of levels.vertex.values()) expect(Number.isFinite(v)).toBe(true);
  });

  it('puts coastal and river flats at their levels', () => {
    const { c, levels } = setup(2);
    cells.forEach((cell, i) => {
      if (c.flatType[i] === 'coastal') expect(levels.flatLevel[i]).toBeCloseTo(2 + cell.hop, 5);
      if (c.flatType[i] === 'river') {
        const highest = Math.max(...cell.poly[0].map(p => riverSurfaceAt(course, profile, p)));
        expect(levels.flatLevel[i]).toBeCloseTo(Math.max(riverSurfaceAt(course, profile, cell.seed) + 1.5 + cell.hop, highest + 0.5), 5);
      }
    });
  });

  it('keeps pond banks above the water and the bed below it', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { c, levels } = setup(seed);
      cells.forEach((cell, i) => {
        if (c.kind[i] !== 'pond') return;
        const s = levels.pondSurface[i]!;
        for (const p of verts([cell.poly])) expect(levels.vertex.get(vkey(p))!).toBeGreaterThanOrEqual(s + 0.5 - 1e-9);
        expect(levels.centre[i]).toBeCloseTo(s - 2, 9);
      });
    }
  });

  it('keeps riverbanks above the river surface', () => {
    const bank = offsetPolygons(river, 0.1);
    const { levels } = setup(3);
    for (const cell of cells) for (const p of verts([cell.poly])) {
      if (containsPoint(bank, p)) expect(levels.vertex.get(vkey(p))!).toBeGreaterThanOrEqual(riverSurfaceAt(course, profile, p) + 0.5 - 1e-9);
    }
  });

  it('applies a flat override to its cells and their vertices', () => {
    const base = setup(4);
    const gi = base.groups.findIndex(g => g.kind === 'flat' && g.flatType === 'shelf') >= 0
      ? base.groups.findIndex(g => g.kind === 'flat' && g.flatType === 'shelf')
      : base.groups.findIndex(g => g.kind === 'flat');
    const { groups, levels } = setup(4, [{ group: gi, elevation: 90 }]);
    for (const ci of groups[gi].cells) {
      expect(levels.flatLevel[ci]).toBe(90);
      for (const p of verts([cells[ci].poly])) {
        const v = levels.vertex.get(vkey(p))!;
        expect(v).toBeLessThanOrEqual(90 + 1e-9); // shared corners take the lowest touching level
      }
    }
  });
});

describe('constrainedSurface', () => {
  it('covers an L-shape exactly, keeping every boundary vertex and an interior point', () => {
    const L: MultiPolygon = [[[[0, 0], [100, 0], [100, 50], [50, 50], [50, 100], [0, 100]]]];
    const g = constrainedSurface(L, p => p[0] / 10, [[25, 25, 99]]);
    expect(triangleArea(g)).toBeCloseTo(area(L), 0);
    for (const p of L[0][0]) expect(g.points.some(q => q[0] === p[0] && q[1] === p[1])).toBe(true);
    expect(g.points.some(q => q[2] === 99)).toBe(true);
    for (const [i, j, k] of g.triangles) {
      const cx = (g.points[i][0] + g.points[j][0] + g.points[k][0]) / 3, cz = (g.points[i][1] + g.points[j][1] + g.points[k][1]) / 3;
      expect(containsPoint(L, [cx, cz])).toBe(true);
    }
  });
});

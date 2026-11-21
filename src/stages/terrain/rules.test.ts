import { describe, it, expect } from 'vitest';
import { difference, union } from '../../grammar/clipper.js';
import { rect } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { buildCells, type Cell } from './cells.js';
import { classify, mergeRegions, TERRAIN_RULES } from './rules.js';

const site = rect(-1000, -1000, 1000, 1000);
const sea = rect(-1000, 700, 1000, 1000);
const river = rect(-20, -1000, 20, 700);
const land = difference(site, union(sea, river));
const cells: Cell[] = buildCells(land, site, sea, river, 120, createRng(1));
const opts = { flatWidth: 2, hilliness: 0.5, ponds: 3 };

describe('terrain rules', () => {
  it('has the five rows in order', () => {
    expect(TERRAIN_RULES.map(r => r.name)).toEqual(['coast', 'riverbank', 'near water', 'foothills', 'uplands']);
  });

  it('lets riverbank cells be flat, slope or hills', () => {
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const c = classify(cells, { ...opts, ponds: 0 }, createRng(s));
      cells.forEach((cell, i) => { if (cell.touchesRiver && !cell.touchesSea) seen.add(c.kind[i]); });
    }
    expect([...seen].sort()).toEqual(['flat', 'hills', 'slope']);
  });

  it('smooths away isolated cells', () => {
    for (const s of [1, 2, 3]) {
      const c = classify(cells, { ...opts, ponds: 0 }, createRng(s));
      cells.forEach((cell, i) => {
        if (cell.touchesSea || cell.touchesRiver || !cell.neighbours.length) return;
        expect(cell.neighbours.some(n => c.kind[n] === c.kind[i])).toBe(true);
      });
    }
  });

  it('keeps ponds off the sea, the river and each other', () => {
    for (const s of [1, 2, 3, 4, 5]) {
      const c = classify(cells, { ...opts, ponds: 6 }, createRng(s));
      cells.forEach((cell, i) => {
        if (c.kind[i] !== 'pond') return;
        expect(cell.touchesSea || cell.touchesRiver).toBe(false);
        for (const n of cell.neighbours) expect(c.kind[n]).not.toBe('pond');
      });
    }
    expect(classify(cells, { ...opts, ponds: 0 }, createRng(1)).kind).not.toContain('pond');
  });

  it('types flats by nearest water', () => {
    const c = classify(cells, opts, createRng(2));
    cells.forEach((cell, i) => {
      if (c.kind[i] !== 'flat') expect(c.flatType[i]).toBeNull();
      else if (cell.hop <= 2 && cell.nearest === 'sea') expect(c.flatType[i]).toBe('coastal');
      else if (cell.hop <= 2 && cell.nearest === 'river') expect(c.flatType[i]).toBe('river');
      else expect(c.flatType[i]).toBe('shelf');
    });
  });

  it('merges connected same-kind cells into regions', () => {
    const c = classify(cells, opts, createRng(3));
    const groups = mergeRegions(cells, c);
    const owner = new Map<number, number>();
    groups.forEach((g, gi) => g.cells.forEach(ci => owner.set(ci, gi)));
    expect(owner.size).toBe(cells.length);
    groups.forEach((g, gi) => {
      if (g.kind === 'pond') expect(g.cells).toHaveLength(1);
      for (const ci of g.cells) for (const n of cells[ci].neighbours) {
        const o = groups[owner.get(n)!];
        if (owner.get(n) !== gi && g.kind !== 'pond') expect(o.kind === g.kind && o.flatType === g.flatType).toBe(false);
      }
    });
  });
});

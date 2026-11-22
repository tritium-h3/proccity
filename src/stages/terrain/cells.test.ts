import { describe, it, expect } from 'vitest';
import { difference } from '../../grammar/clipper.js';
import { checkPartition } from '../../grammar/partition.js';
import { rect } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import { createRng } from '../../pipeline/seeds.js';
import { buildCells } from './cells.js';

const site = rect(-500, -500, 500, 500);

describe('buildCells', () => {
  it('partitions the land into cells', () => {
    const cells = buildCells(site, site, null, null, 120, createRng(1));
    expect(cells.length).toBeGreaterThan(40);
    expect(checkPartition(makeSlab(site), cells.map(c => makeSlab([c.poly]))).problems).toEqual([]);
  });

  it('has a symmetric neighbour relation', () => {
    const cells = buildCells(site, site, null, null, 120, createRng(2));
    for (const c of cells) for (const n of c.neighbours) expect(cells[n].neighbours).toContain(c.id);
  });

  it('measures hop distance from the sea', () => {
    const sea = rect(-500, 300, 500, 500);
    const land = difference(site, sea);
    const cells = buildCells(land, site, sea, null, 120, createRng(3));
    const touching = cells.filter(c => c.touchesSea);
    expect(touching.length).toBeGreaterThan(3);
    for (const c of touching) { expect(c.hop).toBe(0); expect(c.nearest).toBe('sea'); }
    const far = cells.reduce((a, b) => (b.seed[1] < a.seed[1] ? b : a));
    expect(far.hop).toBeGreaterThan(3);
    for (const c of cells) for (const n of c.neighbours) expect(Math.abs(cells[n].hop - c.hop)).toBeLessThanOrEqual(1);
  });

  it('is deterministic for a seed', () => {
    expect(buildCells(site, site, null, null, 120, createRng(4))).toEqual(buildCells(site, site, null, null, 120, createRng(4)));
  });

  it('leaves no slivers beside a narrow river', () => {
    const river = rect(-500, -3, 500, 3);
    const land = difference(site, river);
    const cells = buildCells(land, site, null, river, 120, createRng(5));
    for (const c of cells) expect(c.area).toBeGreaterThanOrEqual(1);
    expect(cells.some(c => c.touchesRiver)).toBe(true);
    expect(checkPartition(makeSlab(land), cells.map(c => makeSlab([c.poly]))).problems).toEqual([]);
  });
});

describe('irregular cells', () => {
  const tri = (cells: ReturnType<typeof buildCells>) => cells.filter(c => c.poly[0].length <= 4).length;
  it('cuts more cells into triangles and wedges as irregularity rises, keeping the partition', () => {
    let low = 0, high = 0;
    for (const s of [1, 2, 3]) {
      const a = buildCells(site, site, null, null, 120, createRng(s), 0);
      const b = buildCells(site, site, null, null, 120, createRng(s), 1);
      low += tri(a); high += tri(b);
      expect(b.length).toBeGreaterThan(a.length);
      expect(checkPartition(makeSlab(site), b.map(c => makeSlab([c.poly]))).problems).toEqual([]);
    }
    expect(high).toBeGreaterThan(low * 1.5);
  });

  it('varies cell sizes widely', () => {
    const cells = buildCells(site, site, null, null, 120, createRng(7), 0.5);
    const areas = cells.map(c => c.area).sort((a, b) => a - b);
    expect(areas[Math.floor(areas.length * 0.9)] / areas[Math.floor(areas.length * 0.1)]).toBeGreaterThan(4);
  });
});

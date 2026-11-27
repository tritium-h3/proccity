import { describe, expect, it } from 'vitest';
import { createCityDoc } from '../../doc/create.js';
import { walk } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import { checkPartition } from '../../grammar/partition.js';
import { area } from '../../grammar/polygon.js';
import { generate } from '../../pipeline/generate.js';
import { FACES, type Zone } from '../blocks/rules.js';
import { STAGES } from '../index.js';
import { defaultsFor } from '../settings.js';
import { BIG_LOT } from './rules.js';

let cached: RegionNode | undefined;
function city(): RegionNode {
  if (!cached) {
    const base = createCityDoc({ name: 'lots', seed: 1, now: 'n', id: 'o', stages: STAGES.map(st => ({ id: st.id, defaults: defaultsFor(st.settings) })) });
    cached = generate({ doc: { ...base, generatedThrough: STAGES.length - 1 }, fromStage: 0, stages: STAGES }).tree;
  }
  return cached;
}
const outline = (n: RegionNode) => n.geometry.footprint.flat().reduce((m, ring) => m + ring.reduce((s, p, i) => {
  const q = ring[(i + 1) % ring.length];
  return s + Math.hypot(q[0] - p[0], q[1] - p[1]);
}, 0), 0);

describe('lots stage', () => {
  it('comes after blocks', () => {
    expect(STAGES.map(s => s.id).slice(-2)).toEqual(['blocks', 'lots']);
  });

  it('partitions every zoned block into lots (and open ground), each fronting an allowed road', () => {
    let blocks = 0, lots = 0;
    walk(city(), n => {
      if (n.kind !== 'block') return;
      if (!n.attrs.zone) { expect(n.children, n.id).toHaveLength(0); return; }
      blocks++;
      expect(n.children.length, n.id).toBeGreaterThan(0);
      const edges = (outline(n) + n.children.reduce((m, k) => m + outline(k), 0)) / 2;
      const tol = Math.max(1e-6, (edges * 1e-3) / area(n.geometry.footprint));
      expect(checkPartition(n.geometry, n.children.map(k => k.geometry), tol).problems, n.id).toEqual([]);
      for (const l of n.children) {
        if (l.kind !== 'lot') { expect(l.kind).toBe('open'); continue; }
        lots++;
        expect(FACES[n.attrs.zone as Zone], `${l.id} ${l.attrs.edges}`).toContain(l.attrs.front);
        expect(String(l.attrs.edges).length).toBe(l.geometry.footprint.flat().reduce((m, r) => m + r.length, 0));
      }
    });
    expect(blocks).toBeGreaterThan(1000);
    expect(lots).toBeGreaterThan(10_000);
    expect(lots).toBeLessThan(90_000);
  }, 300_000);

  it('keeps most big-lot blocks as one lot', () => {
    let big = 0, single = 0;
    walk(city(), n => {
      if (n.kind !== 'block' || !BIG_LOT.has(n.attrs.zone as Zone)) return;
      big++;
      if (n.children.filter(k => k.kind === 'lot').length === 1) single++;
    });
    expect(big).toBeGreaterThan(20);
    expect(single / big).toBeGreaterThan(0.7);
  }, 300_000);

  it('records its numbers', () => {
    const s = city().data!.lotStats!;
    expect(s.lots).toBeGreaterThan(0);
    expect(typeof s.ms).toBe('number');
  }, 300_000);
});

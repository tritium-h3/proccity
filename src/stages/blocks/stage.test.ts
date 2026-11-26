import { describe, expect, it } from 'vitest';
import { createCityDoc } from '../../doc/create.js';
import { walk } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import { checkPartition } from '../../grammar/partition.js';
import { area } from '../../grammar/polygon.js';
import { generate } from '../../pipeline/generate.js';
import { STAGES } from '../index.js';
import { defaultsFor } from '../settings.js';
import { smallestLot, type Developed } from './rules.js';

const cache = new Map<number, RegionNode>();
export function city(seed: number): RegionNode {
  if (!cache.has(seed)) {
    const base = createCityDoc({ name: `seed ${seed}`, seed, now: 'n', id: 'o', stages: STAGES.map(st => ({ id: st.id, defaults: defaultsFor(st.settings) })) });
    cache.set(seed, generate({ doc: { ...base, generatedThrough: STAGES.length - 1 }, fromStage: 0, stages: STAGES }).tree);
  }
  return cache.get(seed)!;
}

const outline = (n: RegionNode) => n.geometry.footprint.flat().reduce((m, ring) => m + ring.reduce((s, p, i) => {
  const q = ring[(i + 1) % ring.length];
  return s + Math.hypot(q[0] - p[0], q[1] - p[1]);
}, 0), 0);

describe('blocks stage', () => {
  it('divides every developed superblock into streets and blocks that partition it', () => {
    const tree = city(1);
    const byId = new Map<string, RegionNode>();
    walk(tree, n => byId.set(n.id, n));
    let developed = 0, divided = 0;
    walk(tree, n => {
      if (n.kind !== 'superblock') return;
      const type = byId.get(n.id.slice(0, n.id.lastIndexOf('/')))!.attrs.type as string;
      if (type === 'undeveloped') { expect(n.children, n.id).toHaveLength(0); return; }
      developed++;
      expect(n.children.length, n.id).toBeGreaterThan(0);
      if (n.children.length > 1) divided++;
      // 1 mm per metre of outline, as districts allow: Clipper rounds to the millimetre.
      const tol = (outline(n) * 1e-3) / area(n.geometry.footprint);
      const check = checkPartition(n.geometry, n.children.map(k => k.geometry), Math.max(1e-6, tol));
      expect(check.problems, n.id).toEqual([]);
      const lot = smallestLot(type as Developed);
      const blocks = n.children.filter(k => k.kind === 'block');
      if (blocks.length > 1) for (const b of blocks) expect(area(b.geometry.footprint), b.id).toBeGreaterThanOrEqual(lot.area);
    });
    expect(developed).toBeGreaterThan(10);
    expect(divided / developed).toBeGreaterThan(0.5);
  }, 120_000);
});

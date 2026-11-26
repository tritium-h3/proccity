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
      // 1 mm per metre of outline, as districts allow: Clipper rounds to the millimetre. Counted on
      // the children's outlines (each shared edge once): a hundred blocks' edges each round.
      const edges = (outline(n) + n.children.reduce((m, k) => m + outline(k), 0)) / 2;
      const tol = (edges * 1e-3) / area(n.geometry.footprint);
      const check = checkPartition(n.geometry, n.children.map(k => k.geometry), Math.max(1e-6, tol));
      expect(check.problems.map(p => p.slice(0, 300)), n.id).toEqual([]);
      const lot = smallestLot(type as Developed);
      const blocks = n.children.filter(k => k.kind === 'block');
      if (blocks.length > 1) for (const b of blocks) expect(area(b.geometry.footprint), b.id).toBeGreaterThanOrEqual(lot.area);
    });
    expect(developed).toBeGreaterThan(10);
    expect(divided / developed).toBeGreaterThan(0.5);
  }, 120_000);
});

describe('zone pins', () => {
  it('keeps a pin the rules allow and drops one they forbid', async () => {
    const { centroid, containsPoint } = await import('../../grammar/polygon.js');
    const tree = city(1);
    const blocks: RegionNode[] = [];
    walk(tree, n => { if (n.kind === 'block' && containsPoint(n.geometry.footprint, centroid(n.geometry.footprint))) blocks.push(n); });
    const tb = blocks.find(b => b.attrs.district === 'town-business' && String(b.attrs.faces).includes('L') && b.attrs.zone !== 'HO')!;
    const sub = blocks.find(b => b.attrs.district === 'suburban')!;
    expect(tb && sub).toBeTruthy();
    const base = createCityDoc({ name: 'pins', seed: 1, now: 'n', id: 'o', stages: STAGES.map(st => ({ id: st.id, defaults: defaultsFor(st.settings) })) });
    const pin = (b: RegionNode, zone: string, k: number) => ({ id: `o${k}`, stage: 'blocks', kind: 'block', anchor: centroid(b.geometry.footprint), settings: { zone }, createdAt: `2026-11-25T00:00:0${k}Z` });
    const res = generate({ doc: { ...base, generatedThrough: STAGES.length - 1, overrides: [pin(tb, 'HO', 1), pin(sub, 'UO', 2)] }, fromStage: 0, stages: STAGES });
    let pinned: RegionNode | undefined;
    walk(res.tree, n => { if (n.id === tb.id) pinned = n; });
    expect(pinned?.attrs.zone).toBe('HO');
    expect(res.dropped.map(d => d.override.id)).toEqual(['o2']);
    expect(res.dropped[0].reason).toBe('invalid-setting');
  }, 120_000);

  it('zones every block by its district and the roads it faces', async () => {
    const { zoneFits } = await import('./zones.js');
    let zoned = 0, all = 0;
    walk(city(1), n => {
      if (n.kind !== 'block') return;
      all++;
      if (n.attrs.zone === undefined) return;
      zoned++;
      const faces = String(n.attrs.faces).split(',').filter(Boolean) as ('A' | 'C' | 'L')[];
      expect(zoneFits(n.attrs.district as 'urban', faces, n.attrs.zone as 'MR'), n.id).toBe(true);
    });
    expect(zoned / all).toBeGreaterThan(0.8);
  }, 120_000);
});

describe('blocks at 30 km', () => {
  it('still divides the developed land', async () => {
    const { LARGE_SCALE } = await import('../testing.js');
    const L = LARGE_SCALE as unknown as Record<string, Record<string, number>> & { site: number };
    const base = createCityDoc({ name: '30', seed: 1, now: 'n', id: 'o', stages: STAGES.map(st => ({ id: st.id, defaults: defaultsFor(st.settings) })) });
    const doc = { ...base, site: { size: L.site }, stages: base.stages.map(s => ({ ...s, settings: { ...s.settings, ...(L[s.id] ?? {}) } })), generatedThrough: STAGES.length - 1 };
    const stats = generate({ doc, fromStage: 0, stages: STAGES }).tree.data!.blockStats!;
    expect(stats.blocks).toBeGreaterThan(5000);
  }, 300_000);
});

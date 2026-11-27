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
  it('divides every developed sub-district into streets and blocks that partition it', () => {
    const tree = city(1);
    let developed = 0, divided = 0;
    walk(tree, n => {
      if (n.kind !== 'subdistrict') return;
      const type = n.attrs.district as string;
      if (n.attrs.step === '0') { expect(n.children, n.id).toHaveLength(0); return; }
      developed++;
      expect(n.children.length, n.id).toBeGreaterThan(0);
      if (n.children.length > 1) divided++;
      // 1 mm per metre of outline, as districts allow: Clipper rounds to the millimetre. Counted on
      // the children's outlines (each shared edge once): a hundred blocks' edges each round.
      const edges = (outline(n) + n.children.reduce((m, k) => m + outline(k), 0)) / 2;
      const tol = (edges * 1e-3) / area(n.geometry.footprint);
      const check = checkPartition(n.geometry, n.children.map(k => k.geometry), Math.max(1e-6, tol));
      expect(check.problems.map(p => p.slice(0, 300)), n.id).toEqual([]);
      const lot = smallestLot(type as Developed, Number(n.attrs.step));
      const blocks = n.children.filter(k => k.kind === 'block');
      if (blocks.length > 1) for (const b of blocks) expect(area(b.geometry.footprint), b.id).toBeGreaterThanOrEqual(lot.area);
    });
    expect(developed).toBeGreaterThan(10);
    expect(divided / developed).toBeGreaterThan(0.5);
  }, 120_000);

  it('keeps the partition where collector strips meet at corners (seeds 2 and 4)', () => {
    // Strips cut independently overlapped where an edge collector met a border collector.
    for (const seed of [2, 4]) walk(city(seed), n => {
      if (n.kind !== 'subdistrict' || !n.children.length) return;
      const edges = (outline(n) + n.children.reduce((m, k) => m + outline(k), 0)) / 2;
      const tol = (edges * 1e-3) / area(n.geometry.footprint);
      const check = checkPartition(n.geometry, n.children.map(k => k.geometry), Math.max(1e-6, tol));
      expect(check.problems.map(p => p.slice(0, 120)), `seed ${seed} ${n.id}`).toEqual([]);
    });
  }, 240_000);

  it('carries streets on: longer routes, some across sub-districts', () => {
    const tree = city(1);
    const streets = tree.data!.streets!;
    const ids = new Set(streets.map(st => st.id));
    const len = (ps: number[][]) => ps.slice(1).reduce((m, p, i) => m + Math.hypot(p[0] - ps[i][0], p[1] - ps[i][1]), 0);
    const routes = new Map<string, number>();
    for (const st of streets) {
      if (st.route) expect(ids.has(st.route), st.route).toBe(true);
      routes.set(st.route ?? st.id, (routes.get(st.route ?? st.id) ?? 0) + len(st.points));
    }
    const L = [...routes.values()].sort((a, b) => a - b);
    expect(L[L.length >> 1]).toBeGreaterThan(1.3 * 220);
    expect(tree.data!.blockStats!.continued).toBeGreaterThan(0);
    // A route with segments under two different sub-districts.
    const owners = new Map<string, Set<string>>();
    walk(tree, n => {
      if (n.kind !== 'collector' && n.kind !== 'local') return;
      const st = streets.find(x => x.id === n.attrs.road);
      if (!st?.route) return;
      const sub = n.id.slice(0, n.id.lastIndexOf('/'));
      owners.set(st.route, (owners.get(st.route) ?? new Set()).add(sub));
    });
    expect([...owners.values()].some(o => o.size > 1)).toBe(true);
  }, 120_000);

  it('records each street once, even where two sub-districts share it', () => {
    const keys = city(1).data!.streets!.map(st => [st.points[0], st.points[st.points.length - 1]].map(p => `${Math.round(p[0])},${Math.round(p[1])}`).sort().join('|'));
    expect(keys.length - new Set(keys).size).toBe(0);
  }, 120_000);

  it('runs a collector along open land in dense districts only', () => {
    const tree = city(1);
    expect(tree.data!.blockStats!.edgeStreets).toBeGreaterThan(0);
    walk(tree, n => {
      if (n.kind === 'collector' && n.attrs.edge) expect(['suburban', 'rural'], n.id).not.toContain(n.attrs.district);
    });
  }, 120_000);

  it('makes bigger blocks where the step is lower', () => {
    const sizes = new Map<number, number[]>();
    walk(city(1), n => {
      if (n.kind !== 'subdistrict' || n.attrs.step === '0') return;
      const bs = n.children.filter(k => k.kind === 'block').map(k => area(k.geometry.footprint));
      const step = Number(n.attrs.step);
      sizes.set(step, [...(sizes.get(step) ?? []), ...bs]);
    });
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const steps = [...sizes.keys()].sort((a, b) => a - b);
    expect(median(sizes.get(steps[0])!)).toBeGreaterThan(2 * median(sizes.get(steps[steps.length - 1])!));
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

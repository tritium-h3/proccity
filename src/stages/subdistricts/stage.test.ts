import { describe, expect, it } from 'vitest';
import { createCityDoc } from '../../doc/create.js';
import { walk } from '../../doc/tree.js';
import type { Override, RegionNode } from '../../doc/types.js';
import { checkPartition } from '../../grammar/partition.js';
import { area, centroid, containsPoint } from '../../grammar/polygon.js';
import { generate } from '../../pipeline/generate.js';
import type { Developed } from '../blocks/rules.js';
import { STAGES } from '../index.js';
import { defaultsFor } from '../settings.js';
import { allowed, codeOf, STEPS } from './rules.js';

const THROUGH = STAGES.findIndex(s => s.id === 'subdistricts');
function gen(seed: number, overrides: Override[] = []) {
  const base = createCityDoc({ name: `seed ${seed}`, seed, now: 'n', id: 'o', stages: STAGES.map(st => ({ id: st.id, defaults: defaultsFor(st.settings) })) });
  return generate({ doc: { ...base, overrides, generatedThrough: THROUGH }, fromStage: 0, stages: STAGES });
}
const cache = new Map<number, RegionNode>();
const city = (seed: number) => { if (!cache.has(seed)) cache.set(seed, gen(seed).tree); return cache.get(seed)!; };
const typeOf = (tree: RegionNode, n: RegionNode) => {
  let t: string | undefined;
  walk(tree, d => { if (d.kind === 'district' && n.id.startsWith(`${d.id}/`)) t = d.attrs.type as string; });
  return t!;
};
const subs = (tree: RegionNode) => { const out: RegionNode[] = []; walk(tree, n => { if (n.kind === 'subdistrict') out.push(n); }); return out; };
const pin = (kind: string, at: [number, number], settings: Record<string, string>, t = '2026-11-27T00:00:00Z'): Override =>
  ({ id: `o${at.join()}`, stage: kind === 'district' ? 'districts' : 'subdistricts', kind, anchor: at, settings, createdAt: t });

describe('sub-districts stage', () => {
  it('sits between arterials and blocks', () => {
    expect(STAGES.map(s => s.id).slice(0, 5)).toEqual(['terrain', 'districts', 'arterials', 'subdistricts', 'blocks']);
  });

  it('partitions each developed superblock and leaves Undeveloped ones alone', () => {
    const tree = city(1);
    let developed = 0;
    walk(tree, n => {
      if (n.kind !== 'superblock') return;
      if (typeOf(tree, n) === 'undeveloped') { expect(n.children, n.id).toHaveLength(0); return; }
      developed++;
      expect(n.children.length, n.id).toBeGreaterThan(0);
      const check = checkPartition(n.geometry, n.children.map(k => k.geometry), 1e-4);
      expect(check.problems, n.id).toEqual([]);
    });
    expect(developed).toBeGreaterThan(10);
  });

  it('gives every sub-district a valid code, and a gradient within types', () => {
    for (const seed of [1, 2]) {
      const tree = city(seed);
      let off = 0, open = 0;
      for (const s of subs(tree)) {
        const t = typeOf(tree, s) as Developed, step = Number(s.attrs.step);
        expect(allowed(t, step), `${s.id} ${t} ${step}`).toBe(true);
        expect(s.attrs.code).toBe(codeOf(t, step));
        expect(typeof s.attrs.label).toBe('string');
        if (STEPS[t].length === 3 && step !== 0 && step !== STEPS[t][1]) off++;
        if (step === 0) open++;
      }
      expect(off, `seed ${seed}`).toBeGreaterThan(0);
      expect(open, `seed ${seed}`).toBeGreaterThan(0);
      expect(tree.data?.subdistrictStats?.subdistricts).toBe(subs(tree).length);
    }
  });

  it('holds a pin and leaves the other sub-districts as they were', () => {
    const tree = city(1);
    const target = subs(tree).find(s => typeOf(tree, s) === 'financial')!;
    const want = Number(target.attrs.step) === 9 ? '8' : '9';
    const pinned = gen(1, [pin('subdistrict', centroid(target.geometry.footprint), { step: want })]).tree;
    const after = new Map(subs(pinned).map(s => [s.id, s.attrs.step]));
    expect(after.get(target.id)).toBe(want);
    const changed = subs(tree).filter(s => s.id !== target.id && after.get(s.id) !== s.attrs.step);
    expect(changed).toEqual([]);
  });

  it('drops a pin its district no longer allows', () => {
    const tree = city(1);
    const target = subs(tree).find(s => typeOf(tree, s) === 'financial' && Number(s.attrs.step) > 0)!;
    const at = centroid(target.geometry.footprint);
    expect(containsPoint(target.geometry.footprint, at)).toBe(true);
    const res = gen(1, [pin('district', at, { type: 'urban' }), pin('subdistrict', at, { step: '9' })]);
    expect(res.dropped.length).toBeGreaterThan(0);
    const now = subs(res.tree).find(s => containsPoint(s.geometry.footprint, at))!;
    expect(Number(now.attrs.step)).not.toBe(9);
    expect(area(now.geometry.footprint)).toBeGreaterThan(0);
  });
});

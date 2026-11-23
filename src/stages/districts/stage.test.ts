import { describe, it, expect } from 'vitest';
import { createSite } from '../../doc/create.js';
import { ancestry, attachChildren, leaves } from '../../doc/tree.js';
import type { Override, RegionNode, Settings } from '../../doc/types.js';
import { checkPartition } from '../../grammar/partition.js';
import { area, centroid } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { defaultsFor, resolveAttr } from '../settings.js';
import { terrain } from '../terrain/stage.js';
import { tableViolations } from './fill.js';
import { buildGraph, isWide, type DistrictInfo } from './graph.js';
import { allowedOn, budgets, type DistrictType, type TerrainKind } from './rules.js';
import { districts } from './stage.js';
import { union } from '../../grammar/clipper.js';

const LAND = new Set(['flat', 'slope', 'hills']);
// Clipper rounds each place a cut crosses a region edge to the millimetre, kinking outlines by
// up to about a millimetre over their length: 0.2–0.3 m² on a 26 ha region cut a dozen ways,
// over the default 1e-6. So allow 1 mm per metre of the districts' outlines (and 0.01 m² for
// folds already in terrain outlines, which terrain's site-wide check allows).
const perimeter = (n: RegionNode) => n.geometry.footprint.flat().reduce((s, ring) => s + ring.reduce((t, p, i) => t + Math.hypot(p[0] - ring[(i + 1) % ring.length][0], p[1] - ring[(i + 1) % ring.length][1]), 0), 0);
const partition = (r: RegionNode, kids: RegionNode[]) => {
  const tol = Math.max(0.01, 0.001 * kids.reduce((s, k) => s + perimeter(k), 0));
  return checkPartition(r.geometry, kids.map(k => k.geometry), Math.max(1e-6, tol / area(r.geometry.footprint))).problems;
};
const terrainCache = new Map<string, RegionNode>();

function withTerrain(over: Partial<Settings>, seed: number): RegionNode {
  const key = JSON.stringify([over, seed]);
  if (!terrainCache.has(key)) {
    const site = createSite(2000);
    const settings = { ...defaultsFor(terrain.settings), ...over } as Settings;
    const out = terrain.run({ tree: site, leaves: leaves(site), settings, rng: createRng(seed), attr: (n, k) => resolveAttr(ancestry(site, n.id), k, settings), overridesForStage: [] });
    terrainCache.set(key, attachChildren(site, out.children));
  }
  return terrainCache.get(key)!;
}

function run(over: Partial<Settings> = {}, seed = 1, terrainOver: Partial<Settings> = {}, overrides: Override[] = []) {
  const tree = withTerrain(terrainOver, seed);
  const settings = { ...defaultsFor(districts.settings), ...over } as Settings;
  const out = districts.run({ tree, leaves: leaves(tree), settings, rng: createRng(seed * 7 + 1), attr: (n, k) => resolveAttr(ancestry(tree, n.id), k, settings), overridesForStage: overrides });
  const regions = tree.children;
  const all = [...out.children.values()].flat();
  return { tree, regions, out, all, settings };
}

/** Rebuild the graph from the output, the way a checker would. */
function check(all: RegionNode[]) {
  const infos: DistrictInfo[] = all.map(d => ({ footprint: d.geometry.footprint, terrain: d.attrs.terrain as TerrainKind, area: area(d.geometry.footprint), centroid: centroid(d.geometry.footprint) }));
  const g = buildGraph(infos, 60);
  const types = all.map(d => d.attrs.type as DistrictType);
  const wide = (ids: number[]) => ids.some(i => infos[i].terrain === 'hills') || isWide(union(ids.map(i => infos[i].footprint).flat(), []));
  return tableViolations(types, g, wide);
}

describe('districts stage', () => {
  it('divides every land region and leaves water alone', () => {
    const { regions, out } = run();
    for (const r of regions) {
      const kids = out.children.get(r.id) ?? [];
      if (!LAND.has(r.kind)) { expect(kids, r.id).toEqual([]); continue; }
      expect(kids.length, r.id).toBeGreaterThan(0);
      expect(partition(r, kids), r.id).toEqual([]);
      if (r.kind === 'hills') expect(kids).toHaveLength(1);
      for (const k of kids) expect(k.id.startsWith(`${r.id}/district:`)).toBe(true);
    }
  });

  it('obeys the neighbour table and the terrain', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { all } = run({}, seed);
      expect(check(all), `seed ${seed}`).toEqual([]);
      for (const d of all) expect(allowedOn(d.attrs.type as DistrictType, d.attrs.terrain as TerrainKind), `seed ${seed} ${d.id}`).toBe(true);
    }
  });

  it('has a financial main centre, countryside, and budgets kept', () => {
    for (const seed of [1, 2, 3]) {
      const { all, out } = run({}, seed);
      const mains = all.filter(d => d.attrs.anchor === 'main');
      expect(mains, `seed ${seed}`).toHaveLength(1);
      expect(mains[0].attrs.type).toBe('financial');
      expect(all.some(d => d.attrs.type === 'rural')).toBe(true);
      const land = all.reduce((s, d) => s + area(d.geometry.footprint), 0);
      const overflows = out.data!.get('site')!.stats!.overflows;
      const share: Record<string, number> = {};
      for (const d of all) if (!d.attrs.anchor) share[d.attrs.type as string] = (share[d.attrs.type as string] ?? 0) + area(d.geometry.footprint) / land;
      const maxDistrict = Math.max(...all.map(d => area(d.geometry.footprint))) / land;
      for (const [t, s] of Object.entries(share)) expect(s, `seed ${seed} ${t}`).toBeLessThanOrEqual(budgets(0.5)[t as DistrictType] + overflows * maxDistrict + 1e-9);
    }
  });

  it('has no city tier at growth 0', () => {
    const types = run({ growth: 0 }).all.map(d => d.attrs.type);
    for (const t of ['low-urban', 'urban', 'financial']) expect(types).not.toContain(t);
  });

  it('is deterministic and varies by seed', () => {
    const types = (seed: number) => run({}, seed).all.map(d => `${d.id}=${d.attrs.type}`);
    expect(types(1)).toEqual(types(1));
    expect(types(1)).not.toEqual(types(2));
  });

  it('pins a district type from an override and refuses dense types on slopes', () => {
    const { all } = run();
    const target = all.find(d => d.attrs.terrain === 'flat' && d.attrs.type !== 'rural' && !d.attrs.anchor)!;
    const o: Override = { id: 'o1', stage: 'districts', kind: 'district', anchor: centroid(target.geometry.footprint), settings: { type: 'rural' }, createdAt: '2026-11-23T00:00:00.000Z' };
    const pinned = run({}, 1, {}, [o]).all.find(d => d.id === target.id)!;
    expect(pinned.attrs.type).toBe('rural');
    const slope = all.find(d => d.attrs.terrain === 'slope')!;
    expect(districts.validateOverride!(slope, 'type', 'financial')).toBe('Financial needs flat land');
    expect(districts.validateOverride!(slope, 'type', 'suburban')).toBeNull();
  });

  it('survives extremes with the partition intact', () => {
    const cases: [Partial<Settings>, Partial<Settings>][] = [
      [{}, { relief: 400, hilliness: 1 }], [{ districtSize: 2 }, {}], [{ districtSize: 30 }, {}],
      [{ settlements: 8 }, {}], [{ settlements: 1 }, {}], [{ growth: 1 }, {}],
    ];
    for (const [over, terr] of cases) {
      const { regions, out, all } = run(over, 2, terr);
      for (const r of regions.filter(rr => LAND.has(rr.kind))) {
        expect(partition(r, out.children.get(r.id) ?? []), JSON.stringify([over, terr])).toEqual([]);
      }
      const v = check(all);
      expect(v.map(([a, b]) => `${all[a].id}:${all[a].attrs.type}/${all[a].attrs.terrain} ${all[b].id}:${all[b].attrs.type}/${all[b].attrs.terrain}`), JSON.stringify([over, terr])).toEqual([]);
    }
  }, 120_000);

  it('makes nothing without terrain', () => {
    const site = createSite(2000);
    const settings = defaultsFor(districts.settings) as Settings;
    const out = districts.run({ tree: site, leaves: leaves(site), settings, rng: createRng(1), attr: () => undefined, overridesForStage: [] });
    expect([...out.children.values()].flat()).toEqual([]);
  });
});

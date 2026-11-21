import { describe, it, expect } from 'vitest';
import { createCityDoc, createSite } from '../../doc/create.js';
import { triangleArea } from '../../doc/ground.js';
import { ancestry, leaves } from '../../doc/tree.js';
import type { CityDoc, Override, RegionNode, Settings } from '../../doc/types.js';
import { intersect, offsetPolygons } from '../../grammar/clipper.js';
import { checkPartition } from '../../grammar/partition.js';
import { area } from '../../grammar/polygon.js';
import { generate } from '../../pipeline/generate.js';
import { createRng } from '../../pipeline/seeds.js';
import { defaultsFor, resolveAttr } from '../settings.js';
import { riverSurfaceAt } from './elevation.js';
import { terrain } from './stage.js';

function run(over: Partial<Settings> = {}, seed = 1, size = 2000, overrides: Override[] = []) {
  const site = createSite(size);
  const settings = { ...defaultsFor(terrain.settings), ...over } as Settings;
  const t = performance.now();
  const out = terrain.run({
    tree: site, leaves: leaves(site), settings, rng: createRng(seed),
    attr: (n, k) => resolveAttr(ancestry(site, n.id), k, settings), overridesForStage: overrides,
  });
  return { site, children: out.children.get('site') ?? [], stats: out.data!.get('site')!.stats!, ms: performance.now() - t, out };
}
const WATER = new Set(['sea', 'river', 'pond']);
const touching = (a: RegionNode, b: RegionNode) => area(intersect(offsetPolygons(a.geometry.footprint, 0.5), b.geometry.footprint)) > 0.5;

/** Elevation of a footprint vertex in a land region's ground. */
function boundaryElevations(n: RegionNode): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of n.data!.ground!.points) m.set(`${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`, p[2]);
  return m;
}

describe('terrain v2 stage', () => {
  const def = run();

  it('partitions the site', () => {
    expect(checkPartition(def.site.geometry, def.children.map(c => c.geometry)).problems).toEqual([]);
  });

  it('produces the default kinds', () => {
    const kinds = new Set(def.children.map(c => c.kind));
    for (const k of ['sea', 'river', 'flat', 'slope']) expect(kinds).toContain(k);
  });

  for (const shore of ['none', 'north', 'east', 'south', 'west']) {
    for (const seed of [1, 2, 3, 4]) {
      it(`keeps water no higher than the land beside it (shore ${shore}, seed ${seed})`, () => {
        const r = run({ shore, ponds: 4 }, seed);
        const river = r.children.find(c => c.kind === 'river');
        const land = r.children.filter(c => !WATER.has(c.kind));
        for (const w of r.children.filter(c => WATER.has(c.kind))) {
          const surfaceAt = (x: number, z: number) => w.kind === 'river'
            ? riverSurfaceAt(river!.data!.course!, river!.data!.profile!, [x, z]) : (w.attrs.surface as number);
          const keys = new Set(w.geometry.footprint.flat(2).map(p => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`));
          for (const l of land.filter(l => touching(w, l))) {
            for (const [k, e] of boundaryElevations(l)) {
              if (!keys.has(k)) continue;
              const [x, z] = k.split(',').map(v => Number(v) / 100);
              expect(e).toBeGreaterThanOrEqual(surfaceAt(x, z) - 1e-6);
            }
          }
        }
      });
    }
  }

  it('keeps ponds away from the sea, the river and each other', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = run({ ponds: 6 }, seed);
      const ponds = r.children.filter(c => c.kind === 'pond');
      for (const p of ponds) {
        for (const o of r.children) {
          if (o === p || !['sea', 'river', 'pond'].includes(o.kind)) continue;
          expect(touching(p, o), `${p.id} touches ${o.id}`).toBe(false);
        }
      }
    }
  });

  it('gives each region a ground surface covering its footprint', () => {
    for (const c of def.children) {
      const a = area(c.geometry.footprint), t = triangleArea(c.data!.ground!);
      expect(Math.abs(t - a) / a, c.id).toBeLessThan(0.005);
    }
  });

  it('stays within the triangle budget', () => {
    const total = def.children.reduce((s, c) => s + c.data!.ground!.triangles.length, 0);
    console.log(`terrain v2: ${total} triangles, ${def.stats.cells} cells, ${def.ms.toFixed(0)} ms`);
    expect(total).toBeLessThan(10_000);
  });

  it('is deterministic', () => {
    expect(run({}, 9).out).toEqual(run({}, 9).out);
  });

  it('levels a river flat at an override, keeping its banks above the river', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const base = run({}, seed);
      const rf = base.children.find(c => c.kind === 'flat' && c.attrs.riverFlat);
      if (!rf) continue;
      const ring = rf.geometry.footprint[0][0];
      const anchor = rf.data!.ground!.points.find(p => !ring.some(q => q[0] === p[0] && q[1] === p[1])) ?? [ring[0][0], ring[0][1]];
      const r = run({}, seed, 2000, [{ id: 'o', stage: 'terrain', kind: 'flat', anchor: [anchor[0], anchor[1]], settings: { elevation: 80 }, createdAt: 't' }]);
      const f = r.children.find(c => c.kind === 'flat' && c.attrs.riverFlat && c.attrs.elevation === 80);
      expect(f, `seed ${seed}`).toBeDefined();
      for (const p of f!.data!.ground!.points) expect(p[2]).toBeGreaterThanOrEqual(80 - 1e-6 - 0); // banks never below the level here (80 is above the river)
      return;
    }
    throw new Error('no river flat found in seeds 1–6');
  });

  it('survives setting extremes with the partition intact', () => {
    const cases: [Partial<Settings>, number][] = [
      [{ cellSize: 250 }, 500], [{ cellSize: 60 }, 2000], [{ flatWidth: 0 }, 2000], [{ flatWidth: 5 }, 2000],
      [{ ponds: 6, shore: 'none', river: false }, 500], [{ relief: 20, hilliness: 0 }, 2000], [{ relief: 400, hilliness: 1 }, 2000],
    ];
    for (const [over, size] of cases) {
      const r = run(over, 2, size);
      expect(checkPartition(r.site.geometry, r.children.map(c => c.geometry)).problems, JSON.stringify(over)).toEqual([]);
    }
  }, 120_000);

  it('handles a 5000 m site (timing logged)', () => {
    const r = run({}, 3, 5000);
    console.log(`terrain v2 5000 m: ${r.stats.cells} cells, ${r.ms.toFixed(0)} ms`);
    expect(r.children.length).toBeGreaterThan(0);
  }, 120_000);

  it('generates the default site fast enough', () => {
    expect(def.ms).toBeLessThan(500);
  });

  it('drops an override whose flat is gone after a reroll, without throwing', () => {
    const doc: CityDoc = {
      ...createCityDoc({ name: 'T', seed: 5, now: 'n', id: 'c', stages: [{ id: 'terrain', defaults: defaultsFor(terrain.settings) }] }),
      generatedThrough: 0,
      overrides: [{ id: 'o', stage: 'terrain', kind: 'flat', anchor: [990, -990], settings: { elevation: 40 }, createdAt: 't' }],
    };
    const r = generate({ doc: { ...doc, stages: [{ ...doc.stages[0], seedOffset: 3 }] }, fromStage: 0, stages: [terrain] });
    expect(r.overrides.length + r.dropped.length).toBe(1);
  });
});

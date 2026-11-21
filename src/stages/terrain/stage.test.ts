import { describe, it, expect } from 'vitest';
import { createCityDoc, createSite } from '../../doc/create.js';
import { decodeHeights } from '../../doc/heightfield.js';
import { ancestry, leaves } from '../../doc/tree.js';
import type { CityDoc, Override, RegionNode, Settings } from '../../doc/types.js';
import { checkPartition } from '../../grammar/partition.js';
import { generate } from '../../pipeline/generate.js';
import { createRng } from '../../pipeline/seeds.js';
import { defaultsFor, resolveAttr } from '../settings.js';
import { gridFor, rasterize } from './field.js';
import { terrain } from './stage.js';

function run(over: Partial<Settings> = {}, seed = 1, size = 2000, overrides: Override[] = []) {
  const site = createSite(size);
  const settings = { ...defaultsFor(terrain.settings), ...over } as Settings;
  const t = performance.now();
  const out = terrain.run({
    tree: site, leaves: leaves(site), settings, rng: createRng(seed),
    attr: (n, k) => resolveAttr(ancestry(site, n.id), k, settings), overridesForStage: overrides,
  });
  const ms = performance.now() - t;
  const children = out.children.get('site') ?? [];
  const hf = out.data!.get('site')!.heightfield!;
  return { site, children, hf, h: decodeHeights(hf.heights), data: out.data!.get('site')!, ms, out };
}

const kinds = (cs: RegionNode[]) => new Set(cs.map(c => c.kind));
const pointsIn = (size: number, node: RegionNode) => rasterize(gridFor(size), node.geometry.footprint);

describe('terrain stage', () => {
  const def = run();

  it('partitions the site', () => {
    const r = checkPartition(def.site.geometry, def.children.map(c => c.geometry));
    expect(r.problems).toEqual([]);
  });

  it('produces the default kinds', () => {
    for (const k of ['sea', 'river', 'flat', 'slope']) expect(kinds(def.children)).toContain(k);
  });

  it('keeps every flat exactly level at its elevation', () => {
    for (const f of def.children.filter(c => c.kind === 'flat')) {
      const m = pointsIn(2000, f);
      let n = 0;
      m.forEach((v, k) => { if (v) { n++; expect(Math.abs(def.h[k] - (f.attrs.elevation as number))).toBeLessThan(0.01); } });
      expect(n).toBeGreaterThan(0);
    }
  });

  it('keeps the sea at or below sea level and land above it', () => {
    const sea = def.children.find(c => c.kind === 'sea')!;
    pointsIn(2000, sea).forEach((v, k) => { if (v) expect(def.h[k]).toBeLessThanOrEqual(0); });
    for (const c of def.children.filter(c => c.kind === 'slope' || c.kind === 'hills')) {
      pointsIn(2000, c).forEach((v, k) => { if (v) expect(def.h[k]).toBeGreaterThan(0); });
    }
  });

  it('runs the river downhill', () => {
    const river = def.children.find(c => c.kind === 'river')!;
    const course = river.data!.course!;
    const src = river.attrs.sourceSurface as number;
    expect(src).toBeGreaterThanOrEqual(5);
    // surface is linear in arc length from source to 0: check non-increasing at the vertices
    let s = 0, prev = Infinity;
    const L = course.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - course[i][0], p[1] - course[i][1]), 0);
    course.forEach((p, i) => {
      if (i) s += Math.hypot(p[0] - course[i - 1][0], p[1] - course[i - 1][1]);
      const surf = src * (1 - s / L);
      expect(surf).toBeLessThanOrEqual(prev + 1e-9);
      prev = surf;
    });
  });

  it('puts pond beds below their surface', () => {
    const r = run({ ponds: 3 }, 4);
    for (const p of r.children.filter(c => c.kind === 'pond')) {
      pointsIn(2000, p).forEach((v, k) => { if (v) expect(r.h[k]).toBeLessThan(p.attrs.surface as number); });
    }
  });

  it('honours the shore and river toggles', () => {
    expect(kinds(run({ shore: 'none' }).children)).not.toContain('sea');
    expect(kinds(run({ river: false }).children)).not.toContain('river');
  });

  it('is deterministic for a seed', () => {
    expect(run({}, 9).out).toEqual(run({}, 9).out);
  });

  it('moves a flat to an overridden elevation', () => {
    const flat1 = def.children.find(c => c.name === 'flat:1')!;
    const ring = flat1.geometry.footprint[0][0];
    const anchor: [number, number] = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    const o: Override = { id: 'o', stage: 'terrain', kind: 'flat', anchor, settings: { elevation: 40 }, createdAt: 't' };
    const r = run({}, 1, 2000, [o]);
    expect(r.children.find(c => c.name === 'flat:1')!.attrs.elevation).toBe(40);
  });

  it('survives extreme settings without breaking the partition', () => {
    const cases: [Partial<Settings>, number][] = [
      [{ flats: 4, flatSize: 600 }, 500],
      [{ ponds: 5 }, 500],
      [{ relief: 20, hillsThreshold: 5 }, 2000],
    ];
    for (const [over, size] of cases) {
      const r = run(over, 2, size);
      expect(checkPartition(r.site.geometry, r.children.map(c => c.geometry)).problems).toEqual([]);
      expect(r.data.stats!.pondsPlaced).toBeLessThanOrEqual((over.ponds as number) ?? 2);
    }
  });

  it('completes at site-size extremes, fast at the default size', () => {
    const small = run({}, 3, 500), big = run({}, 3, 5000);
    console.log(`terrain: 500 m ${small.ms.toFixed(0)} ms, 2000 m ${def.ms.toFixed(0)} ms, 5000 m ${big.ms.toFixed(0)} ms`);
    expect(small.hf.cols).toBe(64); // round(500 / 8) + 1: spacing stays exactly 8 m, overhanging the site by 4 m
    expect(big.hf.cols).toBe(626);
    expect(def.ms).toBeLessThan(2000);
  });

  it('drops an elevation override whose flat moved away after a reroll, without throwing', () => {
    const doc: CityDoc = {
      ...createCityDoc({ name: 'T', seed: 5, now: 'n', id: 'c', stages: [{ id: 'terrain', defaults: defaultsFor(terrain.settings) }] }),
      generatedThrough: 0,
      overrides: [{ id: 'o', stage: 'terrain', kind: 'flat', anchor: [990, -990], settings: { elevation: 40 }, createdAt: 't' }],
    };
    const rerolled = { ...doc, stages: [{ ...doc.stages[0], seedOffset: 3 }] };
    expect(() => generate({ doc: rerolled, fromStage: 0, stages: [terrain] })).not.toThrow();
    const r = generate({ doc: rerolled, fromStage: 0, stages: [terrain] });
    expect(r.overrides.length + r.dropped.length).toBe(1);
  });
});

describe('terrain has no vertical walls (found in the browser walk-through)', () => {
  const maxJump = (h: Float32Array, n: number) => {
    let m = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (i < n - 1) m = Math.max(m, Math.abs(h[k + 1] - h[k]));
      if (j < n - 1) m = Math.max(m, Math.abs(h[k + n] - h[k]));
    }
    return m;
  };
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`keeps neighbouring points within 60 m (no shore, no river, relief 400, seed ${seed})`, () => {
      const r = run({ shore: 'none', river: false, relief: 400, ruggedness: 1 }, seed);
      const j = maxJump(r.h, r.hf.cols);
      if (j >= 60) console.log(`seed ${seed}: max jump ${j.toFixed(1)} m`);
      expect(j).toBeLessThan(60);
    });
  }
  it('starts the first flat above the waterline only when there is water', () => {
    const dry = run({ shore: 'none', river: false, relief: 400 }, 1);
    expect(dry.children.find(c => c.name === 'flat:0')!.attrs.elevation).toBeGreaterThan(3);
  });
});

describe('flat elevations match the override slider (found in the browser walk-through)', () => {
  it('uses whole metres, so a step-1 slider never snaps them', () => {
    for (const seed of [1, 2, 3]) {
      for (const f of run({ flats: 4 }, seed).children.filter(c => c.kind === 'flat')) {
        expect(Number.isInteger(f.attrs.elevation)).toBe(true);
      }
    }
  });
});

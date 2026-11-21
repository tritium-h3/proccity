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

  it('runs the river downhill and ends at sea level on the coast', () => {
    const river = def.children.find(c => c.kind === 'river')!;
    const profile = river.data!.profile!;
    expect(profile).toHaveLength(river.data!.course!.length);
    profile.forEach((v, i) => { expect(v).toBeGreaterThanOrEqual(0); if (i) expect(v).toBeLessThanOrEqual(profile[i - 1]); });
    expect(profile.at(-1)).toBe(0);
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

import { area } from '../../grammar/polygon.js';
import { intersect, offsetPolygons } from '../../grammar/clipper.js';

describe('terrain review fixes', () => {
  const surfaceAt = (river: RegionNode, x: number, z: number) => {
    const course = river.data!.course!;
    const profile = river.data?.profile;
    let best = 0, bd = Infinity;
    course.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - z) ** 2; if (d < bd) { bd = d; best = i; } });
    if (profile) return profile[best];
    const src = river.attrs.sourceSurface as number;
    return src * (1 - best / (course.length - 1));
  };

  for (const shore of ['none', 'north', 'east', 'south', 'west']) {
    for (const seed of [1, 2, 3, 4]) {
      it(`keeps water no higher than the land beside it (shore ${shore}, seed ${seed})`, () => {
        const r = run({ shore, ponds: 3 }, seed);
        const g = gridFor(2000), n = g.cols;
        const water = new Uint8Array(n * n);
        const surf = new Float32Array(n * n).fill(NaN);
        for (const c of r.children) {
          if (c.kind !== 'river' && c.kind !== 'pond') continue;
          rasterize(g, c.geometry.footprint).forEach((v, k) => {
            if (!v) return;
            water[k] = 1;
            surf[k] = c.kind === 'pond' ? (c.attrs.surface as number) : surfaceAt(c, g.origin[0] + (k % n) * 8, g.origin[1] + Math.floor(k / n) * 8);
          });
        }
        const sea = r.children.find(c => c.kind === 'sea');
        const seaM = sea ? rasterize(g, sea.geometry.footprint) : new Uint8Array(n * n);
        let worst = 0;
        for (let k = 0; k < n * n; k++) {
          if (!water[k]) continue;
          const i = k % n, j = Math.floor(k / n);
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            const kk = jj * n + ii;
            if (water[kk] || seaM[kk]) continue;
            worst = Math.max(worst, surf[k] - r.h[kk]);
          }
        }
        expect(worst).toBeLessThan(0.5);
      });
    }
  }

  it('keeps an elevation override above the relief: ground and attribute agree', () => {
    const flat1 = run({ relief: 150 }, 1).children.find(c => c.name === 'flat:1')!;
    const ring = flat1.geometry.footprint[0][0];
    const anchor: [number, number] = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
    const r = run({ relief: 150 }, 1, 2000, [{ id: 'o', stage: 'terrain', kind: 'flat', anchor, settings: { elevation: 300 }, createdAt: 't' }]);
    const f = r.children.find(c => c.name === 'flat:1')!;
    expect(f.attrs.elevation).toBe(300);
    pointsIn(2000, f).forEach((v, k) => { if (v) expect(Math.abs(r.h[k] - 300)).toBeLessThan(0.01); });
  });

  it('leaves no degenerate or mergeable specks', () => {
    for (const shore of ['none', 'south', 'east']) for (const seed of [1, 3, 5, 7]) {
      const r = run({ shore }, seed);
      const land = r.children.filter(c => c.kind === 'slope' || c.kind === 'hills');
      for (const c of land) {
        const a = area(c.geometry.footprint);
        expect(a).toBeGreaterThan(1);
        if (a < 2000) {
          // a remaining speck must have no slope/hills neighbour it could have merged into
          const grown = offsetPolygons(c.geometry.footprint, 0.5);
          const touching = land.filter(o => o !== c && area(intersect(grown, o.geometry.footprint)) > 0.01);
          expect(touching.map(t => t.id)).toEqual([]);
        }
      }
    }
  }, 60_000);

  it('makes the river one connected piece', () => {
    for (const shore of ['none', 'north', 'east', 'south', 'west']) for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const river = run({ shore, meander: 1 }, seed).children.find(c => c.kind === 'river');
      expect(river?.geometry.footprint.length, `shore ${shore} seed ${seed}`).toBe(1);
    }
  }, 60_000);
});

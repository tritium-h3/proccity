import { describe, it, expect } from 'vitest';
import { createCityDoc, createSite } from '../../doc/create.js';
import { triangleArea } from '../../doc/ground.js';
import { ancestry, leaves } from '../../doc/tree.js';
import type { CityDoc, Override, RegionNode, Settings } from '../../doc/types.js';
import { intersect, offsetPolygons } from '../../grammar/clipper.js';
import { checkPartition } from '../../grammar/partition.js';
import { area, containsPoint } from '../../grammar/polygon.js';
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
      const river = r.children.find(c => c.kind === 'river')!;
      const nearRiver = offsetPolygons(river.geometry.footprint, 2);
      // Interior points sit at the override. Edge points meet their neighbours: the bank band
      // just above the river, and a corner shared with a lower flat takes the lower level.
      const edge = new Set(f!.geometry.footprint.flat(2).map(q => `${Math.round(q[0] * 100)},${Math.round(q[1] * 100)}`));
      let interiorCount = 0;
      for (const p of f!.data!.ground!.points) {
        const onEdge = edge.has(`${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`);
        if (containsPoint(nearRiver, [p[0], p[1]])) expect(p[2]).toBeGreaterThanOrEqual(riverSurfaceAt(river.data!.course!, river.data!.profile!, [p[0], p[1]]) + 0.5 - 1e-6);
        else if (!onEdge) { expect(p[2]).toBeCloseTo(80, 6); interiorCount++; }
      }
      expect(interiorCount).toBeGreaterThan(0);
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

describe('no micro-cliffs from near-duplicate vertices (found in the browser)', () => {
  for (const [cellSize, seed] of [[60, 1], [60, 2], [120, 3], [120, 4]] as const) {
    it(`keeps vertices closer than 1.5 m within 3 m of each other's height (cellSize ${cellSize}, seed ${seed})`, () => {
      const r = run({ cellSize, ponds: 6 }, seed);
      const pts = r.children.flatMap(c => c.data!.ground!.points);
      const grid = new Map<string, [number, number, number][]>();
      for (const p of pts) {
        const k = `${Math.floor(p[0] / 2)},${Math.floor(p[1] / 2)}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(p);
      }
      let worst = 0;
      for (const p of pts) {
        const gx = Math.floor(p[0] / 2), gz = Math.floor(p[1] / 2);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          for (const q of grid.get(`${gx + dx},${gz + dz}`) ?? []) {
            const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            if (d > 0.01 && d < 1.5) worst = Math.max(worst, Math.abs(p[2] - q[2]));
          }
        }
      }
      expect(worst).toBeLessThan(3);
    });
  }
});

describe('terrain v2 review fixes', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`never perches the river above the land beside it (seed ${seed})`, () => {
      const r = run({}, seed);
      const river = r.children.find(c => c.kind === 'river');
      if (!river) return;
      // Two tiers: at the bank (5 m) land is never below the water; within 50 m nothing sits
      // more than 2 m below it (a levee was ~40 m). The nearest-course-point surface is only a
      // proxy away from the bank: near a bend it can be the upstream, higher reach.
      const bank = offsetPolygons(river.geometry.footprint, 5);
      const near = offsetPolygons(river.geometry.footprint, 50);
      let worstBank = 0, worstNear = 0;
      for (const c of r.children.filter(c => !WATER.has(c.kind))) {
        for (const p of c.data!.ground!.points) {
          if (!containsPoint(near, [p[0], p[1]])) continue;
          const below = riverSurfaceAt(river.data!.course!, river.data!.profile!, [p[0], p[1]]) - p[2];
          worstNear = Math.max(worstNear, below);
          if (containsPoint(bank, [p[0], p[1]])) worstBank = Math.max(worstBank, below);
        }
      }
      expect(worstBank).toBeLessThan(0.01);
      expect(worstNear).toBeLessThan(2);
    });
  }

  it('drops a river-flat elevation override below the river, leaving the flat level', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const base = run({}, seed);
      const rf = base.children.find(c => c.kind === 'flat' && c.attrs.riverFlat && (c.attrs.minElevation as number) > 5);
      if (!rf) continue;
      const pts = rf.data!.ground!.points;
      const inner = pts.reduce((a, b) => (b[2] > a[2] ? b : a));
      const doc: CityDoc = {
        ...createCityDoc({ name: 'T', seed: 1, now: 'n', id: 'c', stages: [{ id: 'terrain', defaults: defaultsFor(terrain.settings) }] }),
        generatedThrough: 0,
        overrides: [{ id: 'o', stage: 'terrain', kind: 'flat', anchor: [inner[0], inner[1]], settings: { elevation: 1 }, createdAt: 't' }],
      };
      // run through the pipeline with the same stage seed as `base`
      const g = generate({ doc: { ...doc, seed: 0, stages: [{ ...doc.stages[0] }] }, fromStage: 0, stages: [{ ...terrain, run: input => terrain.run({ ...input, rng: createRng(seed) }) }] });
      expect(g.dropped.map(d => d.reason)).toEqual(['invalid-setting']);
      expect(g.dropped[0].detail).toMatch(/minimum/);
      const f = g.tree.children.find(c => c.name === rf.name)!;
      expect(f.attrs.elevation).toBe(rf.attrs.elevation);
      return;
    }
    throw new Error('no river flat with a raised minimum in seeds 1–6');
  });
});

describe('no land strips inside water (found in the browser)', () => {
  const distToEdge = (fp: RegionNode['geometry']['footprint'], x: number, z: number) => {
    let best = Infinity;
    for (const poly of fp) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const dx = bx - ax, dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
    }
    return best;
  };
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`keeps every triangle away from the shore under the water (seed ${seed})`, () => {
      const r = run({ ponds: 3, pondSize: 6 }, seed);
      const river = r.children.find(c => c.kind === 'river');
      for (const w of r.children.filter(c => WATER.has(c.kind))) {
        const g = w.data!.ground!;
        for (const [i, j, k] of g.triangles) {
          const cx = (g.points[i][0] + g.points[j][0] + g.points[k][0]) / 3;
          const cz = (g.points[i][1] + g.points[j][1] + g.points[k][1]) / 3;
          if (distToEdge(w.geometry.footprint, cx, cz) < 3) continue;
          const cy = (g.points[i][2] + g.points[j][2] + g.points[k][2]) / 3;
          const surface = w.kind === 'river' ? riverSurfaceAt(river!.data!.course!, river!.data!.profile!, [cx, cz]) : (w.attrs.surface as number);
          expect(cy, `${w.id} at (${cx.toFixed(0)}, ${cz.toFixed(0)})`).toBeLessThan(surface);
        }
      }
    });
  }

  it('keeps points shared by the river and the sea under the water', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = run({}, seed);
      const river = r.children.find(c => c.kind === 'river'), sea = r.children.find(c => c.kind === 'sea');
      if (!river || !sea) continue;
      const k = (p: number[]) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
      const seaPts = new Map(sea.data!.ground!.points.map(p => [k(p), p[2]]));
      const land = new Set(r.children.filter(c => !WATER.has(c.kind)).flatMap(c => c.data!.ground!.points.map(k)));
      for (const p of river.data!.ground!.points) {
        if (!seaPts.has(k(p)) || land.has(k(p))) continue;
        expect(p[2]).toBeLessThanOrEqual(0);
        expect(seaPts.get(k(p))!).toBeCloseTo(p[2], 6);
      }
    }
  });
});

describe('strict pond rule (irregular cells)', () => {
  it('keeps ponds from touching the sea, the river or each other, even at a corner', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const r = run({ ponds: 6, pondSize: 3, irregularity: 1 }, seed);
      const ponds = r.children.filter(c => c.kind === 'pond');
      for (const p of ponds) {
        const grown = offsetPolygons(p.geometry.footprint, 1);
        for (const o of r.children) {
          if (o === p || !WATER.has(o.kind)) continue;
          expect(area(intersect(grown, o.geometry.footprint)), `${p.id} vs ${o.id}, seed ${seed}`).toBeLessThan(1e-6);
        }
      }
    }
  }, 60_000);
});

describe('no cliffs from irregular cells (found in the browser)', () => {
  it('keeps very steep land triangles rare', () => {
    for (const seed of [1, 2, 3, 4]) {
      const r = run({}, seed);
      let total = 0, over55 = 0, over70 = 0;
      for (const c of r.children.filter(k => k.kind === 'slope' || k.kind === 'hills')) {
        const g = c.data!.ground!;
        for (const [i, j, k] of g.triangles) {
          const a = g.points[i], b = g.points[j], d = g.points[k];
          const ux = b[0] - a[0], uz = b[1] - a[1], uy = b[2] - a[2], vx = d[0] - a[0], vz = d[1] - a[1], vy = d[2] - a[2];
          const ny = ux * vz - uz * vx, nx = uz * vy - uy * vz, nz = uy * vx - ux * vy;
          const ang = Math.acos(Math.abs(ny) / Math.hypot(nx, ny, nz)) * 180 / Math.PI;
          total++; if (ang > 55) over55++; if (ang > 70) over70++;
        }
      }
      expect(over70 / total, `seed ${seed}`).toBeLessThan(0.01);
      expect(over55 / total, `seed ${seed}`).toBeLessThan(0.03);
    }
  });
});

describe('no flat fins (found in the browser)', () => {
  it('keeps every point of a flat no higher than its highest edge point', () => {
    for (const [irregularity, seed] of [[0.5, 1], [0.5, 2], [0.5, 3], [1, 1], [1, 2], [1, 3], [1, 4]] as const) {
      const r = run({ irregularity }, seed);
      for (const f of r.children.filter(c => c.kind === 'flat')) {
        const k = (p: number[]) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;
        const edge = new Set(f.geometry.footprint.flat(2).map(k));
        const pts = f.data!.ground!.points;
        const edgeMax = Math.max(...pts.filter(p => edge.has(k(p))).map(p => p[2]));
        for (const p of pts) expect(p[2], `${f.id} irr ${irregularity} seed ${seed}`).toBeLessThanOrEqual(edgeMax + 0.01);
      }
    }
  }, 60_000);
});

describe('rounded ponds (polygonal shorelines seen in the browser)', () => {
  it('has no sharp corner on any pond outline', () => {
    const turn = (ring: number[][], i: number) => {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      let d = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - Math.atan2(b[1] - a[1], b[0] - a[0])) * 180 / Math.PI;
      return d > 180 ? 360 - d : d;
    };
    // Cell outlines made almost every pond vertex a corner; now only the tips of narrow
    // fingers turn sharply.
    let ponds = 0, vertices = 0, sharp = 0;
    for (const [irregularity, seed] of [[0, 1], [0.5, 1], [0.5, 2], [1, 3]] as const) {
      const r = run({ irregularity, ponds: 4 }, seed);
      for (const p of r.children.filter(c => c.kind === 'pond')) {
        ponds++;
        const ring = p.geometry.footprint[0][0];
        vertices += ring.length;
        sharp += ring.filter((_, i) => turn(ring, i) > 30).length;
      }
    }
    expect(sharp / vertices).toBeLessThan(0.05);
    expect(ponds).toBeGreaterThan(4);
  }, 60_000);
});

describe('ponds never touch (two shared a corner at irregularity 0, seed 5)', () => {
  it('keeps every pair of ponds apart, even at a corner', () => {
    for (const [irregularity, seed] of [[0, 5], [0, 1], [0.5, 2], [1, 3]] as const) {
      const ponds = run({ irregularity, ponds: 4 }, seed).children.filter(c => c.kind === 'pond');
      for (let i = 0; i < ponds.length; i++) for (let j = i + 1; j < ponds.length; j++) {
        const contact = area(intersect(offsetPolygons(ponds[i].geometry.footprint, 0.5), ponds[j].geometry.footprint));
        expect(contact, `${ponds[i].id} / ${ponds[j].id}, irr ${irregularity} seed ${seed}`).toBe(0);
      }
    }
  }, 60_000);
});

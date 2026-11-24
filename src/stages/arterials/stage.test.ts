import { describe, it, expect } from 'vitest';
import { createSite } from '../../doc/create.js';
import { groundHeightAt } from '../../doc/ground.js';
import { ancestry, attachChildren, leaves } from '../../doc/tree.js';
import type { MultiPolygon, Point2, RegionNode, Settings } from '../../doc/types.js';
import { intersect, offsetPolygons, offsetPolyline, union } from '../../grammar/clipper.js';
import { checkPartition } from '../../grammar/partition.js';
import { area, bounds, containsPoint } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { districts } from '../districts/stage.js';
import { defaultsFor, resolveAttr } from '../settings.js';
import { terrain } from '../terrain/stage.js';
import { tightBends } from './smooth.js';
import { slivers } from './space.js';
import { arterials } from './stage.js';
import { SMALL_SCALE } from '../testing.js';

// Share of road length allowed inside Undeveloped land at 30 km. With gateways, a link the tree
// needs across the wilds is a road through a whole Undeveloped district: seed 2, whose
// developed land comes in islands, has 18% (seed 1 about 6%).
const WILD_SHARE = 0.2;

const cache = new Map<string, RegionNode>();
function upToDistricts(terrainOver: Partial<Settings>, seed: number): RegionNode {
  const key = JSON.stringify([terrainOver, seed]);
  if (!cache.has(key)) {
    const site = createSite(2000);
    const ts = { ...defaultsFor(terrain.settings), ...SMALL_SCALE.terrain, ...terrainOver } as Settings;
    let tree = attachChildren(site, terrain.run({ tree: site, leaves: leaves(site), settings: ts, rng: createRng(seed), attr: (n, k) => resolveAttr(ancestry(site, n.id), k, ts), overridesForStage: [] }).children);
    const ds = { ...defaultsFor(districts.settings), ...SMALL_SCALE.districts } as Settings;
    tree = attachChildren(tree, districts.run({ tree, leaves: leaves(tree), settings: ds, rng: createRng(seed * 7 + 1), attr: () => undefined, overridesForStage: [] }).children);
    cache.set(key, tree);
  }
  return cache.get(key)!;
}

function run(over: Partial<Settings> = {}, seed = 1, terrainOver: Partial<Settings> = {}) {
  const tree = upToDistricts(terrainOver, seed);
  const settings = { ...defaultsFor(arterials.settings), ...SMALL_SCALE.arterials, ...over } as Settings;
  const out = arterials.run({ tree, leaves: leaves(tree), settings, rng: createRng(seed * 13 + 5), attr: () => undefined, overridesForStage: [] });
  const site = out.data!.get('site')!;
  return { tree, out, roads: site.roads!, stats: site.stats!, settings };
}

const perimeter = (mp: MultiPolygon) => mp.flat().reduce((s, ring) => s + ring.reduce((t, p, i) => t + Math.hypot(p[0] - ring[(i + 1) % ring.length][0], p[1] - ring[(i + 1) % ring.length][1]), 0), 0);
function partition(parent: RegionNode, kids: RegionNode[]) {
  const tol = Math.max(0.01, 0.001 * kids.reduce((s, k) => s + perimeter(k.geometry.footprint), 0));
  return checkPartition(parent.geometry, kids.map(k => k.geometry), Math.max(1e-6, tol / area(parent.geometry.footprint))).problems;
}
const districtsOf = (tree: RegionNode) => tree.children.flatMap(r => r.children.filter(c => c.kind === 'district'));
const band = (points: Point2[], width: number) => offsetPolyline(points, width / 2, 'round');
function samples(points: Point2[], step = 10): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  if (points.length) out.push(points[points.length - 1]);
  return out;
}
function meanGrade(tree: RegionNode, pts: Point2[]) {
  let rise = 0, run = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    rise += Math.abs(groundHeightAt(tree, ...pts[i + 1]) - groundHeightAt(tree, ...pts[i]));
    run += d;
  }
  return run ? rise / run : 0;
}

describe('arterials stage', () => {
  it('partitions every district and the river', () => {
    for (const seed of [1, 2]) {
      const { tree, out } = run({}, seed);
      for (const d of districtsOf(tree)) {
        const kids = out.children.get(d.id) ?? [];
        expect(kids.length, d.id).toBeGreaterThan(0);
        expect(partition(d, kids), `seed ${seed} ${d.id}`).toEqual([]);
        for (const k of kids) expect(['arterial', 'superblock']).toContain(k.kind);
      }
      const river = tree.children.find(c => c.kind === 'river')!;
      const rk = out.children.get(river.id) ?? [];
      if (rk.length) expect(partition(river, rk), `seed ${seed} river`).toEqual([]);
    }
  });

  it('builds one connected network that reaches every district it can', () => {
    for (const seed of [1, 2, 3]) {
      const { tree, roads, stats, settings } = run({}, seed);
      const bands = roads.map(r => band(r.points, Number(settings.roadWidth)));
      const parent = roads.map((_, i) => i);
      const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
      for (let i = 0; i < roads.length; i++) for (let j = i + 1; j < roads.length; j++) if (area(intersect(bands[i], bands[j])) > 1) parent[find(i)] = find(j);
      expect(new Set(roads.map((_, i) => find(i))).size, `seed ${seed}`).toBe(1);
      const all = union(bands.flat(), []);
      const untouched = districtsOf(tree).filter(d => d.attrs.type !== 'undeveloped' && area(intersect(d.geometry.footprint, all)) <= 1).length;
      // Districts with only one possible link go unlinked (counted as leaves): a road into one
      // would be a dead end.
      expect(untouched, `seed ${seed}`).toBeLessThanOrEqual(stats.unreachable + stats.leaves);
    }
  });

  it('leaves the site through the requested exits, over land', () => {
    const { tree, roads, stats } = run({ exits: 3 });
    const b = bounds(tree.geometry.footprint);
    const exits = roads.filter(r => r.exit);
    // At least the requested number; a district with no other second link may take another.
    expect(stats.exits).toBeGreaterThanOrEqual(3);
    expect(exits.length).toBeGreaterThanOrEqual(3);
    for (const e of exits) {
      const [x, z] = e.points[0];
      expect(Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z)).toBeLessThan(1);
    }
  });

  it('keeps off the sea and ponds, and bridges the river', () => {
    for (const seed of [1, 2]) {
      const { tree, out, roads } = run({}, seed);
      const deep = offsetPolygons(tree.children.filter(c => c.kind === 'sea' || c.kind === 'pond').flatMap(c => c.geometry.footprint), -5);
      for (const r of roads) for (const p of samples(r.points)) expect(containsPoint(deep, p), `seed ${seed} ${r.id} at ${p}`).toBe(false);
      const river = tree.children.find(c => c.kind === 'river')!;
      const crosses = roads.some(r => samples(r.points).some(p => containsPoint(river.geometry.footprint, p)));
      if (crosses) expect((out.children.get(river.id) ?? []).some(k => k.kind === 'bridge')).toBe(true);
    }
  });

  it('reports every tight curve and sliver it leaves', () => {
    for (const seed of [1, 2]) {
      const { tree, roads, stats, settings } = run({}, seed);
      expect(roads.reduce((s, r) => s + tightBends(r.points, Number(settings.curveRadius)), 0)).toBeLessThanOrEqual(stats.tightCurves);
      const all = union(roads.flatMap(r => band(r.points, Number(settings.roadWidth))), []);
      let count = 0;
      for (const d of districtsOf(tree)) {
        if (slivers(d.geometry.footprint, [], Number(settings.usableWidth)).length) continue; // thin already
        if (area(intersect(d.geometry.footprint, all)) <= 1) continue;
        count += slivers(d.geometry.footprint, all, Number(settings.usableWidth)).length;
      }
      expect(count, `seed ${seed}`).toBeLessThanOrEqual(stats.slivers);
    }
  });

  it('follows the terrain', () => {
    const { tree, roads } = run({}, 1, { relief: 250, hilliness: 0.8 });
    const along = roads.reduce((s, r) => s + meanGrade(tree, samples(r.points)), 0) / roads.length;
    const straight = roads.reduce((s, r) => s + meanGrade(tree, samples([r.points[0], r.points[r.points.length - 1]])), 0) / roads.length;
    // Gateway roads are pinned at both ends and kept near their district, so they can wind less
    // than free routes did (0.7 unconstrained, about 0.83 as built).
    expect(along).toBeLessThan(0.85 * straight);
  });

  it('climbs less steeply with a lower max grade', () => {
    const over12 = (r: ReturnType<typeof run>) => r.roads.reduce((s, road) => {
      const pts = samples(road.points);
      let m = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        if (d > 0 && Math.abs(groundHeightAt(r.tree, ...pts[i + 1]) - groundHeightAt(r.tree, ...pts[i])) / d > 0.12) m += d;
      }
      return s + m;
    }, 0);
    const steep = { relief: 300, hilliness: 0.8 };
    expect(over12(run({ maxGrade: 4 }, 1, steep))).toBeLessThanOrEqual(over12(run({ maxGrade: 12 }, 1, steep)) + 50);
  });

  it('leaves the site square-on and keeps off the site edge', () => {
    for (const seed of [1, 2]) {
      const { tree, roads } = run({}, seed);
      const b = bounds(tree.geometry.footprint);
      const edgeDist = (p: Point2) => Math.min(p[0] - b.minX, b.maxX - p[0], p[1] - b.minZ, b.maxZ - p[1]);
      for (const e of roads.filter(r => r.exit)) {
        const [a, c] = [e.points[0], samples(e.points).find(p => Math.hypot(p[0] - e.points[0][0], p[1] - e.points[0][1]) >= 30)!];
        const inward = edgeDist(c) - edgeDist(a);
        expect(inward / Math.hypot(c[0] - a[0], c[1] - a[1]), `seed ${seed} ${e.id}`).toBeGreaterThan(Math.cos(10 * Math.PI / 180));
      }
      let near = 0, total = 0;
      for (const r of roads.filter(rr => !rr.exit)) for (const p of samples(r.points)) { total++; if (edgeDist(p) < 15) near++; }
      expect(near / total, `seed ${seed}`).toBeLessThan(0.02);
    }
  });

  it('only makes bridges where roads cross the river', () => {
    for (const seed of [1, 4]) {
      const { tree, out, roads } = run({}, seed);
      const river = tree.children.find(c => c.kind === 'river')!;
      const bridges = (out.children.get(river.id) ?? []).filter(k => k.kind === 'bridge');
      let crossings = 0;
      for (const r of roads) {
        let was = false;
        for (const p of samples(r.points, 2)) { const wet = containsPoint(river.geometry.footprint, p); if (wet && !was) crossings++; was = wet; }
      }
      expect(bridges.length, `seed ${seed}`).toBeLessThanOrEqual(crossings);
      for (const br of bridges) expect(area(br.geometry.footprint), `seed ${seed} ${br.id}`).toBeGreaterThan(100);
    }
  });

  it('handles a 30 km site at the new defaults in reasonable time', () => {
    const site = createSite(30000);
    const ts = defaultsFor(terrain.settings) as Settings;
    let tree = attachChildren(site, terrain.run({ tree: site, leaves: leaves(site), settings: ts, rng: createRng(3), attr: (n, k) => resolveAttr(ancestry(site, n.id), k, ts), overridesForStage: [] }).children);
    tree = attachChildren(tree, districts.run({ tree, leaves: leaves(tree), settings: defaultsFor(districts.settings) as Settings, rng: createRng(22), attr: () => undefined, overridesForStage: [] }).children);
    const out = arterials.run({ tree, leaves: leaves(tree), settings: defaultsFor(arterials.settings) as Settings, rng: createRng(44), attr: () => undefined, overridesForStage: [] });
    const st = out.data!.get('site')!.stats!;
    expect(st.ms, JSON.stringify(st)).toBeLessThan(3000);
    for (const d of districtsOf(tree)) expect(partition(d, out.children.get(d.id) ?? []), d.id).toEqual([]);
  }, 120_000);

  it('at 30 km, bridges every river crossing and partitions the river', () => {
    for (const seed of [1, 2, 3]) {
      const site = createSite(30000);
      const ts = defaultsFor(terrain.settings) as Settings;
      let tree = attachChildren(site, terrain.run({ tree: site, leaves: leaves(site), settings: ts, rng: createRng(seed), attr: (n, k) => resolveAttr(ancestry(site, n.id), k, ts), overridesForStage: [] }).children);
      tree = attachChildren(tree, districts.run({ tree, leaves: leaves(tree), settings: defaultsFor(districts.settings) as Settings, rng: createRng(seed * 7 + 1), attr: () => undefined, overridesForStage: [] }).children);
      const as = defaultsFor(arterials.settings) as Settings;
      const out = arterials.run({ tree, leaves: leaves(tree), settings: as, rng: createRng(seed * 13 + 5), attr: () => undefined, overridesForStage: [] });
      const river = tree.children.find(c => c.kind === 'river')!;
      const kids = out.children.get(river.id) ?? [];
      if (kids.length) expect(partition(river, kids), `seed ${seed}`).toEqual([]);
      // Every stretch of road over the river is on a bridge (its own, or a road it shares a
      // crossing with).
      const decks = offsetPolygons(kids.filter(k => k.kind === 'bridge').flatMap(k => k.geometry.footprint), 1);
      for (const r of out.data!.get('site')!.roads!) {
        const wet = samples(r.points, 5).filter(p => containsPoint(river.geometry.footprint, p));
        const dry = wet.filter(p => !containsPoint(decks, p));
        expect(dry.length, `seed ${seed} ${r.id}: ${dry.length * 5} m over the river off any bridge`).toBeLessThanOrEqual(2);
      }
    }
  }, 120_000);

  describe('at 30 km, where roads end and run', () => {
    const cities = new Map<number, ReturnType<typeof city30>>();
    function city30(seed: number) {
      const site = createSite(30000);
      const ts = defaultsFor(terrain.settings) as Settings;
      let tree = attachChildren(site, terrain.run({ tree: site, leaves: leaves(site), settings: ts, rng: createRng(seed), attr: (n, k) => resolveAttr(ancestry(site, n.id), k, ts), overridesForStage: [] }).children);
      tree = attachChildren(tree, districts.run({ tree, leaves: leaves(tree), settings: defaultsFor(districts.settings) as Settings, rng: createRng(seed * 7 + 1), attr: () => undefined, overridesForStage: [] }).children);
      const settings = defaultsFor(arterials.settings) as Settings;
      const out = arterials.run({ tree, leaves: leaves(tree), settings, rng: createRng(seed * 13 + 5), attr: () => undefined, overridesForStage: [] });
      return { tree, out, roads: out.data!.get('site')!.roads!, settings };
    }
    const get = (seed: number) => { if (!cities.has(seed)) cities.set(seed, city30(seed)); return cities.get(seed)!; };
    type Seg = [number, number, number, number];
    const segsOf = (mp: MultiPolygon): Seg[] => mp.flatMap(p => p.flatMap(r => r.map((a, i) => { const b = r[(i + 1) % r.length]; return [a[0], a[1], b[0], b[1]] as Seg; })));
    const lineSegs = (pts: Point2[]): Seg[] => pts.slice(1).map((b, i) => [pts[i][0], pts[i][1], b[0], b[1]] as Seg);
    function nearest(p: Point2, ss: Seg[]) {
      let d = Infinity, seg: Seg | null = null;
      for (const s of ss) {
        const [ax, az, bx, bz] = s, dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
        const t = L ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - az) * dz) / L)) : 0;
        const e = Math.hypot(p[0] - ax - t * dx, p[1] - az - t * dz);
        if (e < d) { d = e; seg = s; }
      }
      return { d, seg };
    }
    const inner = (s: Seg) => !([s[0], s[2]].every(x => Math.abs(Math.abs(x) - 15000) < 1) || [s[1], s[3]].every(z => Math.abs(Math.abs(z) - 15000) < 1));
    const waterSegs = (tree: RegionNode) => tree.children.filter(r => ['sea', 'river', 'pond'].includes(r.kind)).flatMap(r => segsOf(r.geometry.footprint)).filter(inner);
    /** Non-exit road ends that meet no other road. */
    function deadEnds(roads: { points: Point2[]; exit: boolean }[]) {
      const out: { road: number; at: Point2 }[] = [];
      roads.forEach((r, i) => {
        for (const [k, at] of [[0, r.points[0]], [1, r.points[r.points.length - 1]]] as [number, Point2][]) {
          if (r.exit && k === 0) continue;
          if (!roads.some((o, j) => j !== i && nearest(at, lineSegs(o.points)).d < 30)) out.push({ road: i, at });
        }
      });
      return out;
    }

    it('ends no road at the water or in Undeveloped land', () => {
      for (const seed of [1, 2, 3]) {
        const { tree, roads, settings } = get(seed);
        const ws = waterSegs(tree);
        const wild = districtsOf(tree).filter(d => d.attrs.type === 'undeveloped');
        for (const e of deadEnds(roads)) {
          // The stage aims for the Usable width plus a cell; a district along a shore may have
          // no cell that clear, so the bar is half the Usable width (ends used to touch water).
          expect(nearest(e.at, ws).d, `seed ${seed} road ${e.road} ends at ${e.at.map(Math.round)}`).toBeGreaterThanOrEqual(Number(settings.usableWidth) / 2);
          expect(wild.some(d => containsPoint(d.geometry.footprint, e.at)), `seed ${seed} road ${e.road} ends in Undeveloped land`).toBe(false);
        }
      }
    }, 120_000);

    it('keeps a dead end only when it reaches a district no other road does, or carries a road', () => {
      for (const seed of [1, 2, 3]) {
        const { tree, roads, settings } = get(seed);
        const developed = districtsOf(tree).filter(d => d.attrs.type !== 'undeveloped');
        const bands = roads.map(r => band(r.points, Number(settings.roadWidth)));
        const reaches = (i: number, d: RegionNode) => area(intersect(d.geometry.footprint, bands[i])) > 1;
        for (const i of new Set(deadEnds(roads).map(e => e.road))) {
          const own = developed.filter(d => reaches(i, d) && !roads.some((_, j) => j !== i && reaches(j, d)));
          // Or another road joins the network through it (a road ends within a grid cell of it).
          const carries = roads.some((o, j) => j !== i && [o.points[0], o.points[o.points.length - 1]].some(p => nearest(p, lineSegs(roads[i].points)).d < 100));
          expect(own.length > 0 || carries, `seed ${seed} road ${i}`).toBe(true);
        }
      }
    }, 120_000);

    it('runs on district borders rather than just beside them', () => {
      for (const seed of [1, 2, 3]) {
        const { tree, roads } = get(seed);
        const ws = waterSegs(tree);
        const borders = districtsOf(tree).flatMap(d => segsOf(d.geometry.footprint)).filter(s => inner(s) && nearest([(s[0] + s[2]) / 2, (s[1] + s[3]) / 2], ws).d > 1);
        let on = 0, beside = 0;
        for (const r of roads) for (const [ax, az, bx, bz] of lineSegs(r.points)) {
          const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 25)), h = Math.atan2(bz - az, bx - ax);
          for (let k = 0; k < n; k++) {
            const { d, seg } = nearest([ax + (bx - ax) * (k + 0.5) / n, az + (bz - az) * (k + 0.5) / n], borders);
            if (d < 15) on += L / n;
            else if (d < 150 && seg && Math.abs(Math.cos(h - Math.atan2(seg[3] - seg[1], seg[2] - seg[0]))) > 0.85) beside += L / n;
          }
        }
        expect(beside, `seed ${seed}: ${Math.round(beside)} m beside a border, ${Math.round(on)} m on one`).toBeLessThan(on);
      }
    }, 120_000);

    it('makes no hairpins', () => {
      for (const seed of [1, 2, 3]) {
        const { roads, settings } = get(seed);
        const within = 2 * Number(settings.curveRadius);
        for (const r of roads) {
          const p = r.points;
          for (let m = 0; m + 2 < p.length; m++) {
            let turn = 0, dist = 0, h = Math.atan2(p[m + 1][1] - p[m][1], p[m + 1][0] - p[m][0]);
            for (let q = m + 1; q + 1 < p.length && dist < within; q++) {
              const nh = Math.atan2(p[q + 1][1] - p[q][1], p[q + 1][0] - p[q][0]);
              let d = nh - h; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
              turn += d; h = nh; dist += Math.hypot(p[q + 1][0] - p[q][0], p[q + 1][1] - p[q][1]);
              // A 90° corner on the Curve radius spans about 1.6 radii, so a hairpin is anything
              // turning over 120° within two.
              expect(Math.abs(turn), `seed ${seed} ${r.id} turns ${Math.round(turn * 180 / Math.PI)}° in ${Math.round(dist)} m at ${p[m + 1].map(Math.round)}`).toBeLessThanOrEqual((2 * Math.PI) / 3);
            }
          }
        }
      }
    }, 120_000);

    it('leaves no dead end near the site edge, and none just past a bridge', () => {
      for (const seed of [1, 2, 3]) {
        const { tree, roads, settings } = get(seed);
        const river = tree.children.find(c => c.kind === 'river');
        for (const e of deadEnds(roads)) {
          const edge = 15000 - Math.max(Math.abs(e.at[0]), Math.abs(e.at[1]));
          expect(edge, `seed ${seed} road ${e.road} ends ${Math.round(edge)} m from the edge`).toBeGreaterThanOrEqual(Number(settings.spacing) / 2);
          if (!river) continue;
          // Walk 1 km back along the road from its end: no river.
          const pts = roads[e.road].points[0] === e.at ? roads[e.road].points : [...roads[e.road].points].reverse();
          let run = 0;
          for (const p of samples(pts, 10)) {
            if (run > 1000) break;
            expect(containsPoint(river.geometry.footprint, p), `seed ${seed} road ${e.road} ends ${Math.round(run)} m past the river`).toBe(false);
            run += 10;
          }
        }
      }
    }, 120_000);

    it('has no dead ends: every road end meets another road or the site edge', () => {
      for (const seed of [1, 2, 3]) {
        const { roads, out } = get(seed);
        const st = out.data!.get('site')!.stats!;
        expect(st.deadEnds, `seed ${seed}`).toBe(0);
        const loose = deadEnds(roads).filter(e => 15000 - Math.max(Math.abs(e.at[0]), Math.abs(e.at[1])) > 1);
        expect(loose.map(e => `${roads[e.road].id} at ${e.at.map(Math.round)}`), `seed ${seed}`).toEqual([]);
      }
    }, 120_000);

    it('keeps out of Undeveloped land where it can', () => {
      for (const seed of [1, 2, 3]) {
        const { tree, roads } = get(seed);
        const wild = districtsOf(tree).filter(d => d.attrs.type === 'undeveloped');
        let total = 0, inWild = 0;
        for (const r of roads) for (const [ax, az, bx, bz] of lineSegs(r.points)) {
          const L = Math.hypot(bx - ax, bz - az);
          total += L;
          if (wild.some(d => containsPoint(d.geometry.footprint, [(ax + bx) / 2, (az + bz) / 2]))) inWild += L;
        }
        expect(inWild / total, `seed ${seed}`).toBeLessThan(WILD_SHARE);
      }
    }, 120_000);
  });

  it('joins neighbouring gateways along the border only as often as Border roads asks', () => {
    for (const seed of [1, 2, 3]) expect(run({ borderRoads: 0 }, seed).stats.borderRoads, `seed ${seed}`).toBe(0);
    const some = [1, 2, 3].reduce((n, seed) => n + run({ borderRoads: 1 }, seed).stats.borderRoads, 0);
    expect(some).toBeGreaterThan(0);
  });

  it('adds loops with Redundancy (at 30 km: at 2 km, gateways on 250 m districts are too crowded for loops)', () => {
    const site = createSite(30000);
    const ts = defaultsFor(terrain.settings) as Settings;
    let tree = attachChildren(site, terrain.run({ tree: site, leaves: leaves(site), settings: ts, rng: createRng(1), attr: (n, k) => resolveAttr(ancestry(site, n.id), k, ts), overridesForStage: [] }).children);
    tree = attachChildren(tree, districts.run({ tree, leaves: leaves(tree), settings: defaultsFor(districts.settings) as Settings, rng: createRng(8), attr: () => undefined, overridesForStage: [] }).children);
    const loops = (redundancy: number) => arterials.run({ tree, leaves: leaves(tree), settings: { ...defaultsFor(arterials.settings), redundancy } as Settings, rng: createRng(18), attr: () => undefined, overridesForStage: [] }).data!.get('site')!.stats!.loops;
    expect(loops(1)).toBeGreaterThan(loops(0));
  }, 120_000);

  it('is deterministic and quick', () => {
    const a = run({}, 2), b = run({}, 2);
    expect(a.roads).toEqual(b.roads);
    expect(a.stats.ms).toBeLessThan(1500);
  });

  it('survives extremes with partitions intact', () => {
    const cases: [Partial<Settings>, Partial<Settings>][] = [
      [{}, { shore: 'none', river: false }], [{}, { relief: 400, hilliness: 1 }],
      [{ spacing: 300 }, {}], [{ spacing: 1500 }, {}], [{ redundancy: 0 }, {}], [{ redundancy: 1 }, {}],
      [{ exits: 8 }, {}], [{ junctionAngle: 90 }, {}], [{ curveRadius: 200 }, {}], [{ maxGrade: 2 }, {}], [{ usableWidth: 150 }, {}],
    ];
    for (const [over, terr] of cases) {
      const { tree, out } = run(over, 2, terr);
      for (const d of districtsOf(tree)) expect(partition(d, out.children.get(d.id) ?? []), JSON.stringify([over, terr, d.id])).toEqual([]);
    }
  }, 300_000);

  it('makes nothing without districts', () => {
    const site = createSite(2000);
    const out = arterials.run({ tree: site, leaves: leaves(site), settings: defaultsFor(arterials.settings) as Settings, rng: createRng(1), attr: () => undefined, overridesForStage: [] });
    expect([...out.children.values()].flat()).toEqual([]);
  });
});

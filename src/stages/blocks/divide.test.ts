import { describe, expect, it } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { defaultsFor } from '../settings.js';
import { divideAll, divideSuperblock, type BlockSettings, type DivideCtx } from './divide.js';
import { Junctions } from './junctions.js';
import { checkPartition } from '../../grammar/partition.js';
import { makeSlab } from '../../grammar/slab.js';
import { RoadIndex } from './roads.js';
import { blocks } from './stage.js';

const S = defaultsFor(blocks.settings) as unknown as BlockSettings;

/** A superblock with arterials (25 m) all round. */
function ringed(w: number, h: number): DivideCtx {
  const roads = new RoadIndex();
  const ring: Point2[] = [[-12.5, -12.5], [w + 12.5, -12.5], [w + 12.5, h + 12.5], [-12.5, h + 12.5], [-12.5, -12.5]];
  roads.add({ points: ring, category: 'A', half: 12.5 });
  return { family: 'dense', step: 9, s: S, minBlockArea: 200, minDepth: 25, rng: createRng(1), roads, junctions: new Junctions(), openAt: () => false };
}

describe('dividing a superblock', () => {
  it('lays collectors in a big dense superblock, each meeting an arterial or collector', () => {
    const ctx = ringed(1600, 1000);
    const out = divideSuperblock([rect(0, 0, 1600, 1000)], ctx);
    const cs = out.streets.filter(s => s.category === 'C');
    expect(cs.length).toBeGreaterThan(0);
    for (const c of cs) {
      const cats = [c.points[0], c.points[c.points.length - 1]].map(e => ctx.roads.at(e)?.category);
      expect(cats.some(x => x === 'A' || x === 'C')).toBe(true);
    }
  });

  it('lays no collector in a small superblock', () => {
    const out = divideSuperblock([rect(0, 0, 300, 200)], ringed(300, 200));
    expect(out.streets.filter(s => s.category === 'C')).toHaveLength(0);
    expect(out.blocks.length).toBeGreaterThan(1);
  });

  it('leaves a sliver whole', () => {
    const out = divideSuperblock([rect(0, 0, 40, 40)], ringed(40, 40));
    expect(out.streets).toHaveLength(0);
    expect(out.blocks).toHaveLength(1);
  });

  it('cuts a piece with a road on one side only square off that side', () => {
    const roads = new RoadIndex();
    roads.add({ points: [[-100, -12.5], [1100, -12.5]], category: 'A', half: 12.5 });
    const ctx: DivideCtx = { family: 'dense', step: 9, s: S, minBlockArea: 200, minDepth: 25, rng: createRng(1), roads, junctions: new Junctions(), openAt: () => true };
    const out = divideSuperblock([rect(0, 0, 1000, 300)], ctx);
    expect(out.streets.length).toBeGreaterThan(0);
    // Every street meets a road at one end at least.
    for (const st of out.streets) expect([st.points[0], st.points[st.points.length - 1]].some(e => ctx.roads.at(e)), JSON.stringify(st.points.slice(0, 2))).toBe(true);
  });
});

describe('dividing the site in one queue', () => {
  // Two pieces side by side, arterials all round, a 12 m local road between them.
  function pair(between: 'L' | 'A' = 'L', rightWidth = 600) {
    const ctx = ringed(612 + rightWidth, 600);
    ctx.roads.add({ points: [[606, -20], [606, 620]], category: between, half: 6 });
    return { ctx, left: rect(0, 0, 600, 600), right: rect(612, 0, 612 + rightWidth, 600) };
  }
  const routesIn = (out: ReturnType<typeof divideAll>, owner: string, cat?: string) =>
    new Set(out.byOwner.get(owner)!.streets.filter(st => !cat || st.category === cat).map(st => st.route));
  it('divides every owner’s pieces, each partitioned', () => {
    const { ctx, left, right } = pair();
    const out = divideAll([{ owner: 'a', piece: left, ctx }, { owner: 'b', piece: right, ctx }]);
    for (const [owner, piece] of [['a', left], ['b', right]] as const) {
      const o = out.byOwner.get(owner)!;
      expect(o.blocks.length, owner).toBeGreaterThan(1);
      const check = checkPartition(makeSlab(piece), [...o.strips, ...o.blocks].map(fp => makeSlab(fp)), 1e-4);
      expect(check.problems, owner).toEqual([]);
    }
  });
  it('carries a street on across a local road, in line', () => {
    const { ctx, left, right } = pair();
    const out = divideAll([{ owner: 'a', piece: left, ctx }, { owner: 'b', piece: right, ctx }]);
    const a = out.byOwner.get('a')!.streets, b = out.byOwner.get('b')!.streets;
    const shared = a.filter(st => b.some(o => o.route === st.route));
    expect(shared.length).toBeGreaterThan(0);
    // Facing ends across the road line up.
    for (const st of shared) {
      const o = b.find(x => x.route === st.route)!;
      const ea = [st.points[0], st.points[st.points.length - 1]].reduce((m, p) => (p[0] > m[0] ? p : m));
      const eb = [o.points[0], o.points[o.points.length - 1]].reduce((m, p) => (p[0] < m[0] ? p : m));
      expect(Math.abs(ea[1] - eb[1]), JSON.stringify([ea, eb])).toBeLessThan(7);
    }
    expect(out.stats.continued).toBeGreaterThan(0);
  });
  it('stops a local road at an arterial', () => {
    const { ctx, left, right } = pair('A');
    const out = divideAll([{ owner: 'a', piece: left, ctx }, { owner: 'b', piece: right, ctx }]);
    const a = routesIn(out, 'a', 'L'), b = routesIn(out, 'b', 'L');
    expect([...a].filter(r => b.has(r))).toEqual([]);
  });
  it('doesn’t cut a piece already small enough to be a block', () => {
    const { ctx, left } = pair('L', 40);
    const right = rect(612, 0, 652, 60);
    const out = divideAll([{ owner: 'a', piece: left, ctx }, { owner: 'b', piece: right, ctx }]);
    expect(out.byOwner.get('b')!.streets).toEqual([]);
    expect(out.byOwner.get('b')!.blocks).toHaveLength(1);
  });
  it('lines up local roads’ junctions rather than staggering them', () => {
    // On the arterial ring close junctions can't be helped (every edge local must end on it);
    // on local roads, a near miss is a brick.
    const out = divideAll([{ owner: '', piece: rect(0, 0, 1000, 600), ctx: ringed(1000, 600) }]);
    expect(out.stats.closeL ?? 0).toBe(0);
    expect(out.stats.continued).toBeGreaterThan(10);
  });
  it('keeps local roads off arterials where the piece can be cut otherwise', () => {
    const out = divideAll([{ owner: '', piece: rect(0, 0, 1600, 1000), ctx: ringed(1600, 1000) }]);
    const locals = out.byOwner.get('')!.streets.filter(st => st.category === 'L').length;
    expect(locals).toBeGreaterThan(20);
    expect(out.stats.localOnArterial).toBeLessThan(0.15 * locals);
  });
  it('gives a long strip between arterials a cross street, though it must end on them', () => {
    // 900 × 100 m at step 3 (target 376 m long): under two target blocks in area, but over twice
    // the target length. Kept whole, it was a kilometre of lots on one block.
    const ctx = ringed(900, 100);
    ctx.step = 3;
    const out = divideAll([{ owner: '', piece: rect(0, 0, 900, 100), ctx }]);
    expect(out.byOwner.get('')!.streets.length).toBeGreaterThan(0);
  });
});

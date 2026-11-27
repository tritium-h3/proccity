import { describe, expect, it } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { rect } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { defaultsFor } from '../settings.js';
import { divideSuperblock, type BlockSettings, type DivideCtx } from './divide.js';
import { RoadIndex } from './roads.js';
import { blocks } from './stage.js';

const S = defaultsFor(blocks.settings) as unknown as BlockSettings;

/** A superblock with arterials (25 m) all round. */
function ringed(w: number, h: number): DivideCtx {
  const roads = new RoadIndex();
  const ring: Point2[] = [[-12.5, -12.5], [w + 12.5, -12.5], [w + 12.5, h + 12.5], [-12.5, h + 12.5], [-12.5, -12.5]];
  roads.add({ points: ring, category: 'A', half: 12.5 });
  return { family: 'dense', step: 9, s: S, minBlockArea: 200, minDepth: 25, rng: createRng(1), roads, openAt: () => false };
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
    const ctx: DivideCtx = { family: 'dense', step: 9, s: S, minBlockArea: 200, minDepth: 25, rng: createRng(1), roads, openAt: () => true };
    const out = divideSuperblock([rect(0, 0, 1000, 300)], ctx);
    expect(out.streets.length).toBeGreaterThan(0);
    // Every street meets a road at one end at least.
    for (const st of out.streets) expect([st.points[0], st.points[st.points.length - 1]].some(e => ctx.roads.at(e)), JSON.stringify(st.points.slice(0, 2))).toBe(true);
  });
});

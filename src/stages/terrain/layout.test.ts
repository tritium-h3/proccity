import { describe, it, expect } from 'vitest';
import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { intersect } from '../../grammar/clipper.js';
import { area, bounds } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { layoutTerrain, type LayoutInput, type Shore } from './layout.js';

const base = (over: Partial<LayoutInput> = {}): LayoutInput => ({
  size: 2000, rng: createRng(7), shore: 'south', coastWiggle: 0.4,
  river: true, riverWidth: 40, meander: 0.5, flats: 2, flatSize: 300, ponds: 2, ...over,
});
const overlap = (a: MultiPolygon, b: MultiPolygon) => area(intersect(a, b));
const H = 1000;
const onEdge: Record<Exclude<Shore, 'none'>, (b: ReturnType<typeof bounds>) => boolean> = {
  north: b => Math.abs(b.minZ + H) < 1, south: b => Math.abs(b.maxZ - H) < 1,
  east: b => Math.abs(b.maxX - H) < 1, west: b => Math.abs(b.minX + H) < 1,
};
const distToLine = (p: Point2, line: Point2[]) => Math.min(...line.map(q => Math.hypot(p[0] - q[0], p[1] - q[1])));

describe('layoutTerrain', () => {
  for (const shore of ['none', 'north', 'east', 'south', 'west'] as Shore[]) {
    for (const river of [true, false]) {
      it(`honours shore=${shore}, river=${river}`, () => {
        const l = layoutTerrain(base({ shore, river, rng: createRng(11) }));
        if (shore === 'none') expect(l.sea).toBeNull();
        else {
          expect(l.sea).not.toBeNull();
          expect(onEdge[shore](bounds(l.sea!))).toBe(true);
        }
        if (!river) expect(l.river).toBeNull();
        else {
          expect(l.river).not.toBeNull();
          const mouth = l.river!.course.at(-1)!;
          if (l.coastline) expect(distToLine(mouth, l.coastline)).toBeLessThan(40);
          else {
            const src = l.river!.course[0];
            // opposite edges: the source and mouth are each on an edge, on opposite sides
            const edgeOf = (p: Point2) => (Math.abs(p[0]) > Math.abs(p[1]) ? (p[0] > 0 ? 'e' : 'w') : (p[1] > 0 ? 's' : 'n'));
            const opp: Record<string, string> = { n: 's', s: 'n', e: 'w', w: 'e' };
            expect(edgeOf(mouth)).toBe(opp[edgeOf(src)]);
            expect(Math.max(Math.abs(mouth[0]), Math.abs(mouth[1]))).toBeGreaterThan(H - 1);
          }
          if (l.sea) expect(overlap(l.river!.polygon, l.sea)).toBeLessThan(1);
        }
      });
    }
  }

  it('places the requested flats, disjoint and on land', () => {
    const l = layoutTerrain(base({ flats: 3 }));
    expect(l.flats).toHaveLength(3);
    for (let i = 0; i < l.flats.length; i++) {
      expect(area(l.flats[i])).toBeGreaterThan(1000);
      if (l.sea) expect(overlap(l.flats[i], l.sea)).toBeLessThan(1);
      if (l.river) expect(overlap(l.flats[i], l.river.polygon)).toBeLessThan(1);
      for (let j = i + 1; j < l.flats.length; j++) expect(overlap(l.flats[i], l.flats[j])).toBeLessThan(1);
    }
  });

  it('keeps ponds clear of the sea, river and flats', () => {
    const l = layoutTerrain(base({ ponds: 4 }));
    expect(l.ponds.length).toBeGreaterThan(0);
    for (const p of l.ponds) {
      if (l.sea) expect(overlap(p, l.sea)).toBeLessThan(1);
      if (l.river) expect(overlap(p, l.river.polygon)).toBeLessThan(1);
      for (const f of l.flats) expect(overlap(p, f)).toBeLessThan(1);
    }
  });

  it('skips what will not fit instead of throwing', () => {
    const l = layoutTerrain(base({ size: 500, ponds: 5, flats: 4, flatSize: 600 }));
    expect(l.ponds.length).toBeLessThanOrEqual(5);
    expect(l.flats.length).toBeLessThanOrEqual(4);
  });

  it('is deterministic for a seed', () => {
    expect(layoutTerrain(base({ rng: createRng(3) }))).toEqual(layoutTerrain(base({ rng: createRng(3) })));
  });
});

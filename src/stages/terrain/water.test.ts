import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { intersect } from '../../grammar/clipper.js';
import { area, bounds } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import type { Shore } from './water.js';
import { layoutWater, riverProfile } from './water.js';

const H = 1000;
const onEdge: Record<Exclude<Shore, 'none'>, (b: ReturnType<typeof bounds>) => boolean> = {
  north: b => Math.abs(b.minZ + H) < 1, south: b => Math.abs(b.maxZ - H) < 1,
  east: b => Math.abs(b.maxX - H) < 1, west: b => Math.abs(b.minX + H) < 1,
};
const distToLine = (p: Point2, line: Point2[]) => Math.min(...line.map(q => Math.hypot(p[0] - q[0], p[1] - q[1])));

describe('layoutWater', () => {
  for (const shore of ['none', 'north', 'east', 'south', 'west'] as Shore[]) {
    for (const river of [true, false]) {
      it(`honours shore=${shore}, river=${river}`, () => {
        const l = layoutWater({ size: 2000, rng: createRng(11), shore, river, riverWidth: 40 });
        if (shore === 'none') expect(l.sea).toBeNull();
        else expect(onEdge[shore](bounds(l.sea!))).toBe(true);
        if (!river) expect(l.river).toBeNull();
        else {
          expect(l.river!.polygon).toHaveLength(1);
          if (l.coastline) expect(distToLine(l.river!.course.at(-1)!, l.coastline)).toBeLessThan(40);
          if (l.sea) expect(area(intersect(l.river!.polygon, l.sea))).toBeLessThan(1);
        }
      });
    }
  }
  it('is deterministic', () => {
    const a = layoutWater({ size: 2000, rng: createRng(3), shore: 'south', river: true, riverWidth: 40 });
    const b = layoutWater({ size: 2000, rng: createRng(3), shore: 'south', river: true, riverWidth: 40 });
    expect(a).toEqual(b);
  });
});

describe('riverProfile', () => {
  const course: Point2[] = [[0, -1000], [0, 0], [300, 400], [300, 700]];
  it('descends from 0.3 × relief to 0 at a coastal mouth, never rising', () => {
    const p = riverProfile(course, 150, true);
    expect(p[0]).toBeCloseTo(45);
    expect(p.at(-1)).toBe(0);
    p.forEach((v, i) => { if (i) expect(v).toBeLessThanOrEqual(p[i - 1]); });
  });
  it('leaves a non-coastal exit a little above sea level', () => {
    expect(riverProfile(course, 200, false).at(-1)).toBeCloseTo(10);
  });
});

import { describe, expect, it } from 'vitest';
import { junctionCost, Junctions, minSpacing } from './junctions.js';
import { RoadIndex, type RoadLine } from './roads.js';

const T = { depth: 70, length: 160, collectors: 400 };

describe('junction spacing', () => {
  it('widens with the road’s category', () => {
    expect(minSpacing('A', T)).toBe(300);
    expect(minSpacing('C', T)).toBe(120);
    expect(minSpacing('L', T)).toBe(35);
  });

  const setup = () => {
    const roads = new RoadIndex(), js = new Junctions();
    const local: RoadLine = { points: [[0, 0], [500, 0]], category: 'L', half: 6 };
    roads.add(local);
    js.add(local, [100, -6]);
    return { roads, js };
  };
  it('costs nothing off any road', () => {
    const { roads, js } = setup();
    expect(junctionCost(roads, js, [100, 50], T)).toBe(0);
  });
  it('costs nothing for a crossing of an existing junction', () => {
    const { roads, js } = setup();
    expect(junctionCost(roads, js, [102, 6], T)).toBe(0);
  });
  it('prices a near miss by how far short it falls', () => {
    const { roads, js } = setup();
    expect(junctionCost(roads, js, [120, 6], T)).toBeCloseTo((35 - Math.hypot(20, 12)) * 2);
    expect(junctionCost(roads, js, [140, 6], T)).toBe(0);
  });
  it('measures along the road it meets only', () => {
    const { roads, js } = setup();
    const other: RoadLine = { points: [[0, 100], [500, 100]], category: 'L', half: 6 };
    roads.add(other);
    expect(junctionCost(roads, js, [110, 94], T)).toBe(0);
  });
});

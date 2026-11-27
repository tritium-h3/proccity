import { describe, expect, it } from 'vitest';
import { junctionCost, Junctions, minSpacing, snapEnds } from './junctions.js';
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

describe('lining up with a street across the road', () => {
  const setup = () => {
    const roads = new RoadIndex(), js = new Junctions();
    const local: RoadLine = { points: [[0, 0], [500, 0]], category: 'L', half: 6 };
    roads.add(local);
    js.add(local, [100, -6]); // a street from the south ends here
    return { roads, js };
  };
  it('moves an end that falls just short onto the street opposite', () => {
    const { roads, js } = setup();
    const moved = snapEnds([[120, 200], [120, 6]], roads, js, 35);
    expect(moved).not.toBeNull();
    expect(moved![1][0]).toBeCloseTo(100, 0);
    expect(moved![1][1]).toBeCloseTo(6, 0);
    expect(moved![0]).toEqual([120, 200]);
  });
  it('leaves an end that already lines up, or is too far off', () => {
    const { roads, js } = setup();
    expect(snapEnds([[101, 200], [101, 6]], roads, js, 35)).toBeNull();
    expect(snapEnds([[160, 200], [160, 6]], roads, js, 35)).toBeNull();
  });
  it('never moves onto a road end on its own side', () => {
    const { roads, js } = setup();
    expect(snapEnds([[120, -200], [120, -6]], roads, js, 35)).toBeNull();
  });
  it('lines up with a street of any category, on a road of any category', () => {
    const roads = new RoadIndex(), js = new Junctions();
    const collector: RoadLine = { points: [[0, 0], [500, 0]], category: 'C', half: 9 };
    roads.add(collector);
    js.add(collector, [100, -9]); // a local road from the south ends on the collector
    const moved = snapEnds([[115, 200], [115, 9]], roads, js, 35); // a collector from the north
    expect(moved![1][0]).toBeCloseTo(100, 0);
  });
});

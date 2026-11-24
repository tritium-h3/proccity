import { describe, it, expect } from 'vitest';
import { chooseLinks, type LinkCand } from './links.js';

const degrees = (n: number, cands: LinkCand[], chosen: number[]) => {
  const d = new Array(n + 1).fill(0);
  for (const i of chosen) { d[cands[i].a]++; d[cands[i].b]++; }
  return d;
};
const border = (a: number, b: number, cost: number): LinkCand => ({ a, b, cost, kind: 'border' });

describe('chooseLinks', () => {
  it('takes the cheapest tree, then gives a developed leaf its cheapest second link', () => {
    // A square 0-1-2-3 with a diagonal: the tree is the three cheapest edges.
    const cands = [border(0, 1, 1), border(1, 2, 1), border(2, 3, 1), border(3, 0, 5), border(0, 2, 9)];
    const r = chooseLinks(4, [true, true, true, true], cands, { exits: 0, redundancy: 0 });
    expect([...r.tree].sort()).toEqual([0, 1, 2]);
    // 0 and 3 were leaves; 3-0 is the cheapest link that fixes both.
    expect(r.chosen).toContain(3);
    expect(degrees(4, cands, r.chosen).slice(0, 4).every(d => d >= 2)).toBe(true);
    expect(r.leaves).toEqual([]);
  });

  it('drops Undeveloped leaves from the tree', () => {
    // 2 is Undeveloped and hangs off 1.
    const cands = [border(0, 1, 1), border(1, 2, 1), border(0, 3, 1), border(3, 1, 2)];
    const r = chooseLinks(4, [true, true, false, true], cands, { exits: 0, redundancy: 0 });
    expect(degrees(4, cands, r.chosen)[2]).toBe(0);
  });

  it('never leaves an Undeveloped district with exactly one link', () => {
    // 0 and 2 are developed and only meet through Undeveloped 1; 0 also meets 3.
    const cands = [border(0, 1, 1), border(1, 2, 1), border(0, 3, 1), border(2, 3, 9), border(1, 3, 3)];
    for (const red of [0, 0.5, 1]) {
      const r = chooseLinks(4, [true, false, true, true], cands, { exits: 0, redundancy: red });
      const d = degrees(4, cands, r.chosen);
      expect(d[1] === 0 || d[1] >= 2, `redundancy ${red}: ${d}`).toBe(true);
    }
  });

  it('passes through Undeveloped land to save a developed leaf', () => {
    // 2 can only be reached through Undeveloped 1, and 0-1 is its only way on.
    const cands = [border(0, 2, 1), border(2, 1, 1), border(1, 0, 1)];
    const r = chooseLinks(3, [true, false, true], cands, { exits: 0, redundancy: 0 });
    const d = degrees(3, cands, r.chosen);
    expect(d[0]).toBeGreaterThanOrEqual(2);
    expect(d[2]).toBeGreaterThanOrEqual(2);
    expect(d[1]).toBe(2);
  });

  it('adds more loops with more redundancy', () => {
    const cands: LinkCand[] = [];
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) cands.push(border(i, j, 1 + ((i * 7 + j * 3) % 5)));
    const count = (red: number) => chooseLinks(6, new Array(6).fill(true), cands, { exits: 0, redundancy: red }).chosen.length;
    expect(count(1)).toBeGreaterThan(count(0.3));
    expect(count(0.3)).toBeGreaterThan(count(0));
  });

  it('picks the requested exits in the given order, and exits count as links', () => {
    const cands = [border(0, 1, 1), { a: 0, b: 2, cost: 3, kind: 'exit' as const }, { a: 1, b: 2, cost: 1, kind: 'exit' as const }];
    const r = chooseLinks(2, [true, true], cands, { exits: 1, redundancy: 0, exitOrder: [1, 2] });
    // The one requested exit is the first in order; then 1, left with only the tree link, takes
    // the other exit as its second link.
    expect(r.chosen.indexOf(1)).toBeGreaterThanOrEqual(0);
    expect(r.chosen.indexOf(1)).toBeLessThan(r.chosen.indexOf(2));
  });

  it('skips a loop the placement refuses, but never a tree link', () => {
    const cands: LinkCand[] = [];
    for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) cands.push(border(i, j, 1 + ((i * 7 + j * 3) % 5)));
    const r = chooseLinks(6, new Array(6).fill(true), cands, { exits: 0, redundancy: 1, place: (_i, required) => required });
    for (const i of r.tree) expect(r.chosen).toContain(i);
    expect(r.chosen.length).toBeLessThan(cands.length);
  });

  it('reports a developed district that cannot get a second link', () => {
    const r = chooseLinks(2, [true, true], [border(0, 1, 1)], { exits: 0, redundancy: 0 });
    expect(r.leaves.sort()).toEqual([0, 1]);
  });
});

import { describe, expect, it } from 'vitest';
import { rect } from '../../grammar/polygon.js';
import { createRng } from '../../pipeline/seeds.js';
import { RoadIndex } from './roads.js';
import { DISTRICT_ZONES, USES } from './rules.js';
import { facesOf, pickZone } from './zones.js';

describe('zones', () => {
  it('leaves a Suburban block facing only arterials unzoned', () => {
    expect(pickZone('suburban', ['A'], 0.5).zone).toBeNull();
  });

  it('never puts HC (collectors only) on a block facing only local roads', () => {
    for (let i = 0; i < 200; i++) expect(pickZone('town-core', ['L'], i / 200).zone).not.toBe('HC');
  });

  it('weights Suburban towards houses', () => {
    const rng = createRng(3);
    let res = 0;
    for (let i = 0; i < 10000; i++) if (USES[pickZone('suburban', ['L', 'C'], rng()).zone!].join('') === 'R') res++;
    expect(res / 10000).toBeGreaterThan(0.6);
  });

  it('keeps Financial to its own zones, and flags restriction', () => {
    for (let i = 0; i < 100; i++) expect(DISTRICT_ZONES.financial).toContain(pickZone('financial', ['L', 'C', 'A'], i / 100).zone);
    expect(pickZone('town-core', ['L'], 0.1).restricted).toBe(true);
    expect(pickZone('suburban', ['L', 'C'], 0.1).restricted).toBe(false);
  });

  it('reads the roads along a block', () => {
    const roads = new RoadIndex();
    roads.add({ points: [[-100, -6], [300, -6]], category: 'L', half: 6 });
    roads.add({ points: [[209, -100], [209, 300]], category: 'C', half: 9 });
    expect(facesOf(rect(0, 0, 200, 100), roads)).toEqual(['C', 'L']);
  });
});

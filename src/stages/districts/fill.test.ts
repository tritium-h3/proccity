import { describe, it, expect } from 'vitest';
import { createRng } from '../../pipeline/seeds.js';
import { assignStable, assignTypes, tableViolations, type FillInput } from './fill.js';
import type { DistrictGraph } from './graph.js';
import { allowedOn, budgets, type DistrictType, type TerrainKind } from './rules.js';

/** w×h grid of unit-area districts, ids y*w+x, 280 m apart (8 ha districts). */
function gridGraph(w: number, h: number): DistrictGraph {
  const neighbours: number[][] = [], travel: { to: number; cost: number }[][] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ns: number[] = [];
    if (y > 0) ns.push((y - 1) * w + x);
    if (x > 0) ns.push(y * w + x - 1);
    if (x < w - 1) ns.push(y * w + x + 1);
    if (y < h - 1) ns.push((y + 1) * w + x);
    neighbours.push(ns);
    travel.push(ns.map(to => ({ to, cost: 280 })));
  }
  return { neighbours, travel };
}

const wideIfThree = (ids: number[]) => ids.length >= 3;

function input(w: number, h: number, over: Partial<FillInput> = {}, seed = 1): FillInput {
  const n = w * h;
  return {
    graph: gridGraph(w, h),
    terrain: Array<TerrainKind>(n).fill('flat'),
    area: Array<number>(n).fill(1),
    // Best sites near the middle.
    siteScore: Array.from({ length: n }, (_, i) => -Math.hypot((i % w) - w / 2, Math.floor(i / w) - h / 2)),
    growth: 0.5, settlements: 4, pins: new Map(), isWidePatch: wideIfThree, rng: createRng(seed),
    ...over,
  };
}

function shares(types: DistrictType[], skip: Set<number>) {
  const s: Partial<Record<DistrictType, number>> = {};
  types.forEach((t, i) => { if (!skip.has(i)) s[t] = (s[t] ?? 0) + 1 / types.length; });
  return s;
}

describe('assignTypes', () => {
  it('fills a flat grid within the table, with a financial core, countryside and budgets', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const inp = input(12, 12, {}, seed);
      const r = assignTypes(inp);
      expect(tableViolations(r.types, inp.graph, wideIfThree), `seed ${seed}`).toEqual([]);
      const mains = r.anchor.flatMap((a, i) => (a === 'main' ? [i] : []));
      expect(mains).toHaveLength(1);
      expect(r.types[mains[0]]).toBe('financial');
      expect(r.types).toContain('rural');
      const anchors = new Set(r.anchor.flatMap((a, i) => (a ? [i] : [])));
      const cap = budgets(0.5);
      // A budget is only exceeded where a district was squeezed (counted as an overflow), and rarely.
      expect(r.overflows, `seed ${seed}`).toBeLessThanOrEqual(3);
      for (const [t, share] of Object.entries(shares(r.types, anchors))) expect(share, `seed ${seed} ${t}`).toBeLessThanOrEqual(cap[t as DistrictType] + r.overflows / 144 + 1e-9);
    }
  });

  it('has no city tier at growth 0', () => {
    const r = assignTypes(input(12, 12, { growth: 0 }));
    for (const t of ['low-urban', 'urban', 'financial']) expect(r.types).not.toContain(t);
  });

  it('obeys the terrain', () => {
    const terrain = Array.from({ length: 144 }, (_, i): TerrainKind => (i % 12 < 3 ? 'hills' : i % 12 < 6 ? 'slope' : 'flat'));
    const inp = input(12, 12, { terrain });
    const r = assignTypes(inp);
    r.types.forEach((t, i) => expect(allowedOn(t, terrain[i]), `${i} ${t} on ${terrain[i]}`).toBe(true));
    expect(tableViolations(r.types, inp.graph, wideIfThree)).toEqual([]);
  });

  it('copes with no flat land', () => {
    const inp = input(8, 8, { terrain: Array<TerrainKind>(64).fill('slope') });
    const r = assignTypes(inp);
    expect(r.types).not.toContain('financial');
    expect(tableViolations(r.types, inp.graph, wideIfThree)).toEqual([]);
  });

  it('places fewer centres where there is no room', () => {
    const r = assignTypes(input(3, 3, { settlements: 8 }));
    expect(r.anchor.filter(a => a === 'minor').length).toBeLessThan(7);
  });

  it('keeps pins and ignores ones the terrain forbids', () => {
    const terrain = Array<TerrainKind>(144).fill('flat');
    terrain[0] = 'slope';
    const pins = new Map<number, DistrictType>([[0, 'financial'], [143, 'suburban'], [70, 'rural']]);
    const r = assignTypes(input(12, 12, { terrain, pins }));
    expect(r.types[143]).toBe('suburban');
    expect(r.types[70]).toBe('rural');
    expect(r.types[0]).not.toBe('financial');
  });

  it('repairs a squeeze without touching pins', () => {
    // Pinned financial at 3 and rural at 5 squeeze 4; the main centre goes to 0.
    const pins = new Map<number, DistrictType>([[3, 'financial'], [5, 'rural']]);
    const inp = input(6, 1, { pins, settlements: 1, siteScore: [10, 0, 0, 0, 0, 0], isWidePatch: () => false });
    const r = assignTypes(inp);
    expect(r.types[3]).toBe('financial');
    expect(r.types[5]).toBe('rural');
    expect(r.types[4]).toBe('undeveloped');
    // Only the pinned pair is left: the user's own choice.
    expect(tableViolations(r.types, inp.graph, () => false)).toEqual([[3, 5]]);
  });

  it('steps free districts down until the table holds', () => {
    // A free district between a pinned financial and a pinned rural, with a free one beyond.
    const pins = new Map<number, DistrictType>([[0, 'financial'], [3, 'rural']]);
    const inp = input(4, 1, { pins, settlements: 1, isWidePatch: () => false });
    const r = assignTypes(inp);
    const left = tableViolations(r.types, inp.graph, () => false).filter(([a, b]) => !(pins.has(a) && pins.has(b)));
    expect(left).toEqual([]);
  });

  it('is deterministic per seed and varies between seeds', () => {
    expect(assignTypes(input(12, 12, {}, 3)).types).toEqual(assignTypes(input(12, 12, {}, 3)).types);
    expect(assignTypes(input(12, 12, {}, 1)).types).not.toEqual(assignTypes(input(12, 12, {}, 2)).types);
  });
});

describe('assignStable', () => {
  const stable = (pins: Map<number, DistrictType>, seed = 1) => {
    const { rng: _rng, ...rest } = input(12, 12, { pins }, seed);
    return assignStable(rest, () => createRng(seed * 31));
  };

  it('changes only the pinned district when the pin obeys the rules', () => {
    const base = stable(new Map());
    const g = gridGraph(12, 12);
    // A district and a different type that suits every neighbour (and any narrow patch).
    let pick: [number, DistrictType] | null = null;
    for (let i = 0; i < 144 && !pick; i++) {
      if (base.anchor[i]) continue;
      for (const t of ['rural', 'suburban', 'town-core', 'town-business'] as DistrictType[]) {
        if (t === base.types[i]) continue;
        const types = base.types.slice(); types[i] = t;
        if (!tableViolations(types, g, wideIfThree).length) { pick = [i, t]; break; }
      }
    }
    expect(pick).not.toBeNull();
    const [i, t] = pick!;
    const r = stable(new Map([[i, t]]));
    expect(r.types[i]).toBe(t);
    r.types.forEach((ty, j) => { if (j !== i) expect(ty, `district ${j}`).toBe(base.types[j]); });
  });

  it('refills around a pin that breaks the rules', () => {
    const base = stable(new Map());
    const g = gridGraph(12, 12);
    const i = base.types.findIndex((t, j) => t === 'rural' && g.neighbours[j].some(n => base.types[n] === 'rural'));
    const r = stable(new Map([[i, 'financial']]));
    expect(r.types[i]).toBe('financial');
    expect(tableViolations(r.types, g, wideIfThree)).toEqual([]);
  });

  it('is deterministic', () => {
    const pins = new Map<number, DistrictType>([[5, 'suburban']]);
    expect(stable(pins).types).toEqual(stable(pins).types);
  });
});

describe('tableViolations', () => {
  it('sees through a chain of narrow undeveloped districts', () => {
    const g = gridGraph(4, 1);
    const types: DistrictType[] = ['financial', 'undeveloped', 'undeveloped', 'rural'];
    expect(tableViolations(types, g, () => false)).toEqual([[0, 3]]);
    expect(tableViolations(types, g, ids => ids.length >= 2)).toEqual([]);
  });

  it('flags touching pairs', () => {
    expect(tableViolations(['financial', 'rural'], gridGraph(2, 1), () => false)).toEqual([[0, 1]]);
  });
});

// Classification as a small stochastic shape grammar: a declarative rule table. For each
// land cell the first rule whose `when` matches supplies weighted choices of kind, picked
// with the stage rng. Then: smoothing, flat subtypes, ponds, and merging into regions.

import type { Cell } from './cells.js';

export type CellKind = 'flat' | 'slope' | 'hills' | 'pond';
export type FlatType = 'coastal' | 'river' | 'shelf';
type LandKind = Exclude<CellKind, 'pond'>;

export interface CellContext { cell: Cell; flatWidth: number; hilliness: number }
export interface Rule {
  name: string;
  when: (c: CellContext) => boolean;
  choose: (c: CellContext) => Partial<Record<LandKind, number>>;
}

export const TERRAIN_RULES: Rule[] = [
  { name: 'coast', when: c => c.cell.touchesSea, choose: () => ({ flat: 0.85, slope: 0.15 }) },
  { name: 'riverbank', when: c => c.cell.touchesRiver, choose: () => ({ flat: 0.8, slope: 0.15, hills: 0.05 }) },
  // "Near water" and "foothills" need water to be near; a dry site falls through to uplands.
  { name: 'near water', when: c => c.cell.nearest !== 'none' && c.cell.hop <= c.flatWidth, choose: () => ({ flat: 0.7, slope: 0.3 }) },
  {
    name: 'foothills',
    when: c => c.cell.nearest !== 'none' && c.cell.hop <= c.flatWidth + 2,
    choose: c => ({ slope: 0.7, hills: 0.3 * (0.5 + c.hilliness) }),
  },
  { name: 'uplands', when: () => true, choose: c => ({ hills: 0.6 + 0.4 * c.hilliness, slope: 0.3, flat: 0.1 }) },
];

const LAND_KINDS: LandKind[] = ['flat', 'slope', 'hills'];

function pick(weights: Partial<Record<LandKind, number>>, rng: () => number): LandKind {
  const total = LAND_KINDS.reduce((s, k) => s + (weights[k] ?? 0), 0);
  let r = rng() * total;
  for (const k of LAND_KINDS) {
    r -= weights[k] ?? 0;
    if (r < 0) return k;
  }
  return LAND_KINDS.findLast(k => (weights[k] ?? 0) > 0) ?? 'slope';
}

export interface Classified { kind: CellKind[]; flatType: (FlatType | null)[] }

export function classify(cells: Cell[], o: { flatWidth: number; hilliness: number; ponds: number; pondSize?: number }, rng: () => number): Classified {
  // 1. The rule table.
  let kind: CellKind[] = cells.map(cell => {
    const ctx = { cell, flatWidth: o.flatWidth, hilliness: o.hilliness };
    const rule = TERRAIN_RULES.find(r => r.when(ctx))!;
    return pick(rule.choose(ctx), rng);
  });

  // 2. Smoothing: a cell unlike all its neighbours takes their most common kind. Repeated
  //    (up to 5 passes) because a flip can strand a neighbour that only matched that cell.
  //    Water-touching cells keep their pick (riverbank variety is intended).
  for (let pass = 0; pass < 5; pass++) {
    const before = kind;
    let changed = false;
    kind = cells.map((cell, i) => {
      if (cell.touchesSea || cell.touchesRiver || cell.neighbours.length === 0) return before[i];
      if (cell.neighbours.some(n => before[n] === before[i])) return before[i];
      const counts = new Map<CellKind, number>();
      for (const n of cell.neighbours) counts.set(before[n], (counts.get(before[n]) ?? 0) + 1);
      changed = true;
      return LAND_KINDS.reduce((best, k) => ((counts.get(k) ?? 0) > (counts.get(best) ?? 0) ? k : best), before[cell.neighbours[0]] as LandKind);
    });
    if (!changed) break;
  }

  // 3. Flat subtypes, from the nearest water.
  const typeOf = (cell: Cell): FlatType =>
    cell.hop <= o.flatWidth && cell.nearest === 'sea' ? 'coastal'
      : cell.hop <= o.flatWidth && cell.nearest === 'river' ? 'river' : 'shelf';

  // 4. Ponds: seed at an eligible cell, then grow into eligible neighbours up to a target
  //    size around pondSize. Eligible = flat or slope, not touching the sea or river. A pond
  //    never grows beside a different pond (touching ponds would logically be one).
  const pondSize = o.pondSize ?? 1;
  const owner = new Int32Array(cells.length).fill(-1); // pond index per cell
  const eligible = (id: number) => (kind[id] === 'flat' || kind[id] === 'slope') && !cells[id].touchesSea && !cells[id].touchesRiver;
  const besideOther = (id: number, pond: number) => cells[id].neighbours.some(n => owner[n] >= 0 && owner[n] !== pond);
  const candidates = cells.filter(c => eligible(c.id)).map(c => c.id);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  let placed = 0;
  for (const seed of candidates) {
    if (placed >= o.ponds) break;
    if (owner[seed] >= 0 || besideOther(seed, placed)) continue;
    const pond = placed++;
    const target = Math.max(1, Math.round(pondSize * (0.5 + rng())));
    const members = [seed];
    owner[seed] = pond;
    while (members.length < target) {
      const frontier = [...new Set(members.flatMap(m => cells[m].neighbours))]
        .filter(n => owner[n] < 0 && eligible(n) && !besideOther(n, pond))
        .sort((x, y) => x - y);
      if (!frontier.length) break;
      const next = frontier[Math.floor(rng() * frontier.length)];
      owner[next] = pond;
      members.push(next);
    }
    for (const m of members) kind[m] = 'pond';
  }

  const flatType = cells.map((c, i) => (kind[i] === 'flat' ? typeOf(c) : null));
  return { kind, flatType };
}

export interface RegionGroup { kind: CellKind; flatType: FlatType | null; cells: number[] }

/** Connected components of same-kind cells (flats also by subtype). Pond cells merge too;
 *  separate ponds never touch, so each component is one pond. */
export function mergeRegions(cells: Cell[], c: Classified): RegionGroup[] {
  const seen = new Uint8Array(cells.length);
  const groups: RegionGroup[] = [];
  for (const start of cells) {
    if (seen[start.id]) continue;
    const k = c.kind[start.id], ft = c.flatType[start.id];
    const members: number[] = [];
    const stack = [start.id];
    seen[start.id] = 1;
    while (stack.length) {
      const id = stack.pop()!;
      members.push(id);
      for (const n of cells[id].neighbours) {
        if (!seen[n] && c.kind[n] === k && c.flatType[n] === ft) { seen[n] = 1; stack.push(n); }
      }
    }
    groups.push({ kind: k, flatType: ft, cells: members.sort((a, b) => a - b) });
  }
  return groups;
}

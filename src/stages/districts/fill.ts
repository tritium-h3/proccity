// Assigns district types like a puzzle. Anchors are placed first:
//  - the main centre (densest type, by Growth);
//  - minor centres (Town core);
//  - Rural anchors far from every centre;
//  - the user's pins;
//  - hills (always Undeveloped).
// Then the rest fills outward, nearest first. Each pick is random but must suit every placed
// neighbour (the neighbour table), the terrain and the per-type budgets. It's weighted
// towards the density expected from travel distance to the anchors.
//
// A narrow Undeveloped patch (touching Undeveloped districts, merged) doesn't hide a jump:
// the districts around it must obey the table with each other. If nothing fits, the district
// becomes Undeveloped and a repair pass steps the denser side of each broken pair down one rank
// (pins and anchors never move) until the table holds. Ranks only fall, so it ends.

import type { DistrictGraph } from './graph.js';
import { travelFrom } from './graph.js';
import { allowedOn, budgets, mainCentreType, mayBorder, RANK, TYPES, type DistrictType, type TerrainKind } from './rules.js';

export type AnchorRole = 'main' | 'minor' | 'rural';
export interface FillInput {
  graph: DistrictGraph;
  terrain: TerrainKind[];
  area: number[];
  /** higher = better main-centre site */
  siteScore: number[];
  growth: number;
  settlements: number;
  pins: Map<number, DistrictType>;
  /** is this set of Undeveloped districts a wide patch (a hill in it, or over ~100 m across)? */
  isWidePatch(ids: number[]): boolean;
  rng: () => number;
}
export interface FillResult { types: DistrictType[]; anchor: (AnchorRole | null)[]; repairs: number; overflows: number }

const STEP = 250;          // m of travel per rank of falling density
// Denser than expected is penalised more steeply than sparser, so chains of legal steps
// (Town core → Low urban → Urban) don't drift density upward far from any centre.
const SIGMA_UP = 0.6, SIGMA_DOWN = 1.2;
const UNDEVELOPED_WEIGHT = 0.05;
const MINOR_SPACING = 600; // m of travel between centres
const RURAL_REACH = 500;   // near a Rural anchor, expect at most Suburban
const TOP_SITES = 3;

/** The Undeveloped patch containing `start` (or, if `start` isn't placed yet, the patch it
 *  would join), found over touching Undeveloped districts. */
function patchOf(start: number, types: (DistrictType | null)[], g: DistrictGraph): number[] {
  const seen = new Set([start]), stack = [start];
  while (stack.length) for (const n of g.neighbours[stack.pop()!]) {
    if (!seen.has(n) && types[n] === 'undeveloped') { seen.add(n); stack.push(n); }
  }
  return [...seen].sort((a, b) => a - b);
}

/** Placed, developed districts touching a patch. */
function around(patch: number[], types: (DistrictType | null)[], g: DistrictGraph): number[] {
  const inside = new Set(patch), out = new Set<number>();
  for (const p of patch) for (const n of g.neighbours[p]) if (!inside.has(n) && types[n] !== null && types[n] !== 'undeveloped') out.add(n);
  return [...out].sort((a, b) => a - b);
}

export function tableViolations(types: DistrictType[], g: DistrictGraph, isWidePatch: (ids: number[]) => boolean): [number, number][] {
  const out = new Set<string>();
  const add = (a: number, b: number) => { if (!mayBorder(types[a], types[b])) out.add(a < b ? `${a},${b}` : `${b},${a}`); };
  types.forEach((t, i) => { for (const j of g.neighbours[i]) if (j > i) add(i, j); });
  const done = new Set<number>();
  types.forEach((t, i) => {
    if (t !== 'undeveloped' || done.has(i)) return;
    const patch = patchOf(i, types, g);
    patch.forEach(p => done.add(p));
    if (isWidePatch(patch)) return;
    const ring = around(patch, types, g);
    for (let x = 0; x < ring.length; x++) for (let y = x + 1; y < ring.length; y++) add(ring[x], ring[y]);
  });
  return [...out].map(k => k.split(',').map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

export function assignTypes(inp: FillInput): FillResult {
  const { graph: g, terrain, area, rng } = inp;
  const n = terrain.length;
  const types: (DistrictType | null)[] = Array(n).fill(null);
  const anchor: (AnchorRole | null)[] = Array(n).fill(null);
  const fixed = new Uint8Array(n);
  const total = area.reduce((a, b) => a + b, 0);
  const cap = budgets(inp.growth);
  const used = Object.fromEntries(TYPES.map(t => [t, 0])) as Record<DistrictType, number>;
  const place = (i: number, t: DistrictType) => { types[i] = t; used[t] += area[i]; };
  // Pins (and hills) never move; anchors are placed like pins but the repair may step them down.
  const fix = (i: number, t: DistrictType, role: AnchorRole | null) => { place(i, t); anchor[i] = role; if (!role) fixed[i] = 1; };

  // Pins first (the user's word wins), then hills.
  for (const [i, t] of [...inp.pins].sort((a, b) => a[0] - b[0])) if (i < n && allowedOn(t, terrain[i])) fix(i, t, null);
  for (let i = 0; i < n; i++) if (terrain[i] === 'hills' && types[i] === null) { place(i, 'undeveloped'); fixed[i] = 1; }

  // Does type t at i obey the table with everything placed (through narrow patches too)?
  const fits = (i: number, t: DistrictType, budgeted = true): boolean => {
    if (!allowedOn(t, terrain[i]) || (budgeted && used[t] + area[i] > cap[t] * total + 1e-9)) return false;
    if (t === 'undeveloped') {
      const was = types[i];
      types[i] = 'undeveloped';
      const patch = patchOf(i, types, g);
      const ok = inp.isWidePatch(patch) || (() => {
        const ring = around(patch, types, g);
        for (let x = 0; x < ring.length; x++) for (let y = x + 1; y < ring.length; y++) if (!mayBorder(types[ring[x]]!, types[ring[y]]!)) return false;
        return true;
      })();
      types[i] = was;
      return ok;
    }
    for (const j of g.neighbours[i]) {
      const tj = types[j];
      if (tj === null) continue;
      if (tj !== 'undeveloped') { if (!mayBorder(t, tj)) return false; continue; }
      const patch = patchOf(j, types, g);
      if (inp.isWidePatch(patch)) continue;
      for (const k of around(patch, types, g)) if (k !== i && !mayBorder(t, types[k]!)) return false;
    }
    return true;
  };

  // Centres: anchors must suit what's already placed (pins), but sit outside the budgets.
  const free = (i: number) => types[i] === null;
  const centres: number[] = [];
  const mainType = mainCentreType(inp.growth);
  const flats = [...Array(n).keys()].filter(i => free(i) && terrain[i] === 'flat' && fits(i, mainType, false)).sort((a, b) => inp.siteScore[b] - inp.siteScore[a] || a - b);
  const slopes = [...Array(n).keys()].filter(i => free(i) && terrain[i] === 'slope' && fits(i, 'town-core', false)).sort((a, b) => inp.siteScore[b] - inp.siteScore[a] || a - b);
  if (flats.length) {
    const main = flats[Math.floor(rng() * Math.min(TOP_SITES, flats.length))];
    fix(main, mainType, 'main');
    centres.push(main);
  } else if (slopes.length) {
    fix(slopes[0], 'town-core', 'main');
    centres.push(slopes[0]);
  }
  for (let m = 1; m < inp.settlements && centres.length; m++) {
    const d = travelFrom(g, centres);
    const options = [...Array(n).keys()].filter(i => free(i) && terrain[i] !== 'hills' && d[i] >= MINOR_SPACING && d[i] < Infinity && fits(i, 'town-core', false));
    if (!options.length) break;
    // Better sites are likelier, but any spaced-out one may grow a town.
    options.sort((a, b) => inp.siteScore[b] - inp.siteScore[a] || a - b);
    const pick = options[Math.floor(rng() ** 2 * options.length)];
    fix(pick, 'town-core', 'minor');
    centres.push(pick);
  }

  // Rural anchors: as far from every centre as possible.
  const ruralOk = (i: number) => free(i) && fits(i, 'rural', false);
  const farthest = (from: number[]) => {
    const d = from.length ? travelFrom(g, from) : Array<number>(n).fill(0);
    let best = -1;
    for (let i = 0; i < n; i++) if (ruralOk(i) && (best < 0 || (d[i] === Infinity ? 1e12 : d[i]) > (d[best] === Infinity ? 1e12 : d[best]))) best = i;
    return { best, d };
  };
  const r1 = farthest(centres);
  const rural: number[] = [];
  if (r1.best >= 0) {
    fix(r1.best, 'rural', 'rural');
    rural.push(r1.best);
    const r2 = farthest([...centres, r1.best]);
    if (r2.best >= 0 && r2.d[r2.best] >= 0.75 * Math.min(r1.d[r1.best], 1e12)) { fix(r2.best, 'rural', 'rural'); rural.push(r2.best); }
  }

  // Expected rank from travel to each centre (falling with distance), held down near Rural anchors.
  const fromCentre = centres.map(c => ({ rank: RANK[types[c]!], d: travelFrom(g, [c]) }));
  const nearRural = rural.length ? travelFrom(g, rural) : Array<number>(n).fill(Infinity);
  const expected = (i: number) => {
    let e = 1;
    for (const c of fromCentre) e = Math.max(e, c.rank - c.d[i] / STEP);
    return nearRural[i] <= RURAL_REACH ? Math.min(e, 2) : e;
  };

  // Fill outward from the anchors, nearest first.
  const seeds = [...Array(n).keys()].filter(i => types[i] !== null);
  const dist = seeds.length ? travelFrom(g, seeds) : Array<number>(n).fill(Infinity);
  let overflows = 0;
  const order = [...Array(n).keys()].filter(free).sort((a, b) => dist[a] - dist[b] || a - b);
  for (const i of order) {
    const e = expected(i);
    let cands = TYPES.filter(t => fits(i, t));
    // Squeezed only by budgets (often at the edge of the core): go over budget rather than
    // leave a forced Undeveloped sliver that the repair would then push into the core.
    if (cands.length === 1 && cands[0] === 'undeveloped' && !fits(i, 'undeveloped')) cands = [];
    if (!cands.length) {
      const over = TYPES.filter(t => t !== 'undeveloped' && fits(i, t, false));
      if (over.length) { cands = [over.sort((a, b) => Math.abs(RANK[a] - e) - Math.abs(RANK[b] - e) || RANK[a] - RANK[b])[0]]; overflows++; }
    }
    // Dense types taper as their budget runs low, so the core's edge steps down on its own.
    const left = (t: DistrictType) => (cap[t] === Infinity ? 1 : Math.max(0, 1 - used[t] / (cap[t] * total || 1)));
    const weights = cands.map(t => (t === 'undeveloped' ? UNDEVELOPED_WEIGHT : Math.exp(-((RANK[t] - e) ** 2) / (2 * (RANK[t] > e ? SIGMA_UP : SIGMA_DOWN) ** 2)) * Math.sqrt(left(t)) + 1e-9));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!cands.length || sum <= 0) { place(i, 'undeveloped'); continue; }
    let r = rng() * sum, k = 0;
    while (k < cands.length - 1 && (r -= weights[k]) > 0) k++;
    place(i, cands[k]);
  }

  // Repair: step the denser free district of each broken pair down a rank.
  const final = types as DistrictType[];
  let repairs = 0;
  for (;;) {
    let changed = false;
    for (const [a, b] of tableViolations(final, g, inp.isWidePatch)) {
      const movable = [a, b].filter(x => !fixed[x] && RANK[final[x]] > 0);
      if (!movable.length) continue;
      const x = movable.sort((p, q) => RANK[final[q]] - RANK[final[p]] || p - q)[0];
      // Down to the next type with budget left (Rural and Undeveloped always have room).
      used[final[x]] -= area[x];
      let r = RANK[final[x]] - 1;
      while (r > 1 && used[TYPES[r]] + area[x] > cap[TYPES[r]] * total + 1e-9) r--;
      final[x] = TYPES[r];
      used[final[x]] += area[x];
      repairs++;
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return { types: final, anchor, repairs, overflows };
}

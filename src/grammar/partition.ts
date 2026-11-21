// Checks the subtractive invariant: children partition their parent volume.
// Works in height bands (metres above ground): between consecutive height
// breakpoints, the children present must tile the parent's footprint exactly
// (no gap, no overlap, no spill). Covers footprint splits, vertical splits and mixes.

import type { Slab } from '../doc/types.js';
import { difference, union } from './clipper.js';
import { area } from './polygon.js';

const top = (s: Slab) => s.height.high ?? Infinity;
const fmt = (h: number) => (h === Infinity ? '∞' : String(Math.round(h * 1000) / 1000));
const m2 = (a: number) => `${Math.round(a * 100) / 100} m²`;

export function checkPartition(parent: Slab, children: Slab[], relTol = 1e-6): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const pLow = parent.height.low, pHigh = top(parent);
  const pArea = area(parent.footprint);
  const tol = relTol * Math.max(pArea, 1);

  children.forEach((c, i) => {
    if (c.height.low < pLow - 1e-9 || top(c) > pHigh + 1e-9) {
      problems.push(`height: child ${i} spans ${fmt(c.height.low)}–${fmt(top(c))}, outside parent ${fmt(pLow)}–${fmt(pHigh)}`);
    }
  });

  const breaks = [...new Set([pLow, pHigh, ...children.flatMap(c => [c.height.low, top(c)])])]
    .filter(h => h >= pLow && h <= pHigh)
    .sort((a, b) => a - b);

  for (let k = 0; k < breaks.length - 1; k++) {
    const a = breaks[k], b = breaks[k + 1];
    const label = `band ${fmt(a)}–${fmt(b)}`;
    const presentIdx = children.map((c, i) => (c.height.low <= a + 1e-9 && top(c) >= b - 1e-9 ? i : -1)).filter(i => i >= 0);
    const present = presentIdx.map(i => children[i]);
    const merged = present.reduce((acc, c) => union(acc, c.footprint), [] as Slab['footprint']);
    const unionArea = area(merged);
    const sum = present.reduce((s, c) => s + area(c.footprint), 0);
    const spill = area(difference(merged, parent.footprint));

    if (sum - unionArea > tol) problems.push(`${label}: overlap ${m2(sum - unionArea)} (children ${presentIdx.join(',')})`);
    if (spill > tol) problems.push(`${label}: spill ${m2(spill)} outside the parent (children ${presentIdx.join(',')})`);
    const covered = unionArea - spill;
    if (pArea - covered > tol) problems.push(`${label}: gap ${m2(pArea - covered)} not covered by any child`);
  }

  return { ok: problems.length === 0, problems };
}

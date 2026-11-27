// Each sub-district's step: the field's value rounded into its type's range (or the user's pin),
// then a chance of Undeveloped that rises as the field falls and is higher in sparser types. An
// open pick is refused when it would cut a developed sub-district off from the arterials (the
// collectors along sub-district borders are its only way out) or take a district's last
// developed piece. Pins are applied first and never refused: the owner's call beats the rules.

import type { Developed } from '../blocks/rules.js';
import { clampStep, OPEN } from './rules.js';

export interface SubInfo {
  type: Developed; district: string; field: number;
  /** touches an arterial */
  arterial: boolean;
  /** this sub-district's own draw in [0, 1) */
  draw: number;
  pin?: number;
}

export function assignSteps(subs: SubInfo[], neighbours: number[][], openLand: number): { steps: number[]; openRefused: number } {
  const steps = subs.map(s => s.pin ?? clampStep(s.type, s.field));
  // Developed sub-districts that reach an arterial through developed ones.
  const reached = () => {
    const seen = new Set<number>();
    const stack = subs.flatMap((s, i) => (s.arterial && steps[i] > 0 ? [i] : []));
    for (const i of stack) seen.add(i);
    while (stack.length) for (const j of neighbours[stack.pop()!]) if (steps[j] > 0 && !seen.has(j)) { seen.add(j); stack.push(j); }
    return seen.size;
  };
  let openRefused = 0;
  subs.forEach((s, i) => {
    if (s.pin !== undefined || steps[i] === 0) return;
    if (s.draw >= OPEN[s.type] * Math.max(0, 1 - s.field / 9) * openLand) return;
    const lastOfDistrict = !subs.some((o, j) => j !== i && o.district === s.district && steps[j] > 0);
    const before = reached(), was = steps[i];
    steps[i] = 0;
    // Allowed to lose only itself from the reached set (if it was reached at all).
    if (lastOfDistrict || reached() < before - 1) { steps[i] = was; openRefused++; }
  });
  return { steps, openRefused };
}

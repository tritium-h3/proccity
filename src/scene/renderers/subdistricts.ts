// Sub-districts: the terrain tinted with each district's colour, paler as the density step falls
// within its type (level 1 full colour), Undeveloped sub-districts left as natural ground, and the
// arterials as ribbons on top. Tinted, so no triangles.

import { walk } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import type { Developed } from '../../stages/blocks/rules.js';
import type { DistrictType } from '../../stages/districts/rules.js';
import { STEPS } from '../../stages/subdistricts/rules.js';
import { addArterials } from './arterials.js';
import type { StageRenderer } from './index.js';
import { DISTRICT_COLOUR, rgbaOf, tintedTerrain, type Rgba } from './tint.js';

const ALPHA = 0.85;
const PALEST = 0.55; // share of white mixed into a type's sparsest level

const towardsWhite = ([r, g, b, a]: Rgba, k: number): Rgba => [r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k, a].map(Math.round) as Rgba;

export const renderSubdistricts: StageRenderer = (nodes, ctx) => {
  const polys: { footprint: RegionNode['geometry']['footprint']; rgba: Rgba }[] = [];
  // Arterial strips in their district's colour, under the ribbons (as the arterials view).
  const byId = new Map<string, RegionNode>();
  walk(ctx.tree, n => byId.set(n.id, n));
  walk(ctx.tree, n => {
    if (n.kind !== 'arterial') return;
    const hex = DISTRICT_COLOUR[byId.get(n.id.slice(0, n.id.lastIndexOf('/')))?.attrs.type as DistrictType];
    if (hex) polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(hex, ALPHA) });
  });
  for (const n of nodes) {
    const t = n.attrs.district as Developed, step = Number(n.attrs.step);
    const hex = DISTRICT_COLOUR[t];
    if (n.kind !== 'subdistrict' || step === 0 || !hex) continue;
    const levels = STEPS[t], i = Math.max(0, levels.indexOf(step));
    polys.push({ footprint: n.geometry.footprint, rgba: towardsWhite(rgbaOf(hex, ALPHA), levels.length > 1 ? (PALEST * i) / (levels.length - 1) : 0) });
  }
  return addArterials(tintedTerrain(ctx, polys, nodes, 2048), ctx);
};

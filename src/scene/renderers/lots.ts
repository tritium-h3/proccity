// Lots: the blocks view (zone colours, streets in their shades, arterial ribbons), with each lot's
// zone colour nudged lighter or darker, stable per lot, so neighbouring lots read apart, and open
// ground in a muted green. Tinted into the ground at 4096 px (2.4 m a pixel at 10 km: a 9 m lot is
// four pixels), so lots add no triangles.

import { walk } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import type { Zone } from '../../stages/blocks/rules.js';
import { addArterials } from './arterials.js';
import { ZONE_COLOUR } from './blocks.js';
import type { StageRenderer } from './index.js';
import { rgbaOf, tintedTerrain, type Rgba } from './tint.js';

const ARTERIAL = '#1c1c1e', COLLECTOR = '#4c4c52', LOCAL = '#a8a8ac', OPEN = '#9aa67e', UNZONED = '#d8d4c8';
const ALPHA = 0.9;
const JITTER = 0.06;

/** A stable value in [−1, 1] from a lot's id. */
function jitterOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
const nudge = ([r, g, b, a]: Rgba, k: number): Rgba =>
  [r, g, b].map(c => Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k))).concat(a) as Rgba;

export const renderLots: StageRenderer = (nodes, ctx) => {
  const polys: { footprint: RegionNode['geometry']['footprint']; rgba: Rgba }[] = [];
  const byId = new Map<string, RegionNode>();
  walk(ctx.tree, n => {
    byId.set(n.id, n);
    if (n.kind === 'arterial') polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(ARTERIAL, ALPHA) });
    else if (n.kind === 'collector') polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(COLLECTOR, 1) });
    else if (n.kind === 'local') polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(LOCAL, 1) });
    // Blocks without lots (unzoned) keep their blocks-view look.
    else if (n.kind === 'block' && !n.children.length) polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(UNZONED, ALPHA) });
  });
  for (const n of nodes) {
    if (n.kind === 'open') { polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(OPEN, ALPHA) }); continue; }
    if (n.kind !== 'lot') continue;
    const zone = byId.get(n.id.slice(0, n.id.lastIndexOf('/')))?.attrs.zone as Zone | undefined;
    polys.push({ footprint: n.geometry.footprint, rgba: nudge(rgbaOf(ZONE_COLOUR[zone!] ?? UNZONED, ALPHA), JITTER * jitterOf(n.id)) });
  }
  return addArterials(tintedTerrain(ctx, polys, nodes, 4096), ctx);
};

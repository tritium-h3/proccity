// Blocks: the terrain tinted by each block's zone, with collectors and local roads tinted in as
// asphalt (4096 px over the site: 2.4 m a pixel at 10 km, so a 12 m road is five pixels), and the
// arterials as ribbons on top. Blocks add no triangles.

import type { RegionNode } from '../../doc/types.js';
import { walk } from '../../doc/tree.js';
import type { Zone } from '../../stages/blocks/rules.js';
import { addArterials } from './arterials.js';
import type { StageRenderer } from './index.js';
import { rgbaOf, tintedTerrain } from './tint.js';

// Residential yellows, commercial reds, office blues; mixes in between; darker as density rises
// (Low, High, Midrise, Urban core).
export const ZONE_COLOUR: Record<Zone, string> = {
  LR: '#f2e08a', HR: '#e6c84e', MR: '#d1a62a', UR: '#a8801a',
  LC: '#f0a090', HC: '#e06a58', MC: '#c03c34',
  LO: '#a6c4ee', HO: '#6c96e0', MO: '#3a64c0', UO: '#24388e',
  HCR: '#eda060', MCR: '#cf7a34', UCR: '#a85e22',
  HCO: '#b884d4', UCO: '#7c54b0', UCOR: '#8a5a7c',
};
const UNZONED = '#d8d4c8';
const STREET = '#6a6a6e';
const ALPHA = 0.9;

export const renderBlocks: StageRenderer = (nodes, ctx) => {
  const polys: { footprint: RegionNode['geometry']['footprint']; rgba: [number, number, number, number] }[] = [];
  // Arterial strips first (under their ribbons), so they don't show the ground's colour as a fringe.
  walk(ctx.tree, n => { if (n.kind === 'arterial') polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(STREET, ALPHA) }); });
  for (const n of nodes) {
    if (n.kind === 'block') polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(ZONE_COLOUR[n.attrs.zone as Zone] ?? UNZONED, ALPHA) });
    else if (n.kind === 'local' || n.kind === 'collector') polys.push({ footprint: n.geometry.footprint, rgba: rgbaOf(STREET, ALPHA) });
  }
  return addArterials(tintedTerrain(ctx, polys, nodes, 4096), ctx);
};

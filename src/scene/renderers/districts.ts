// Districts are drawn as the terrain, coloured by district type (tint.ts). The owner is happy
// for the colour to replace the ground's own (the terrain view shows that); shading, relief and
// water stay. Undeveloped shows the natural ground.

import type { DistrictType } from '../../stages/districts/rules.js';
import type { StageRenderer } from './index.js';
import { DISTRICT_COLOUR, rgbaOf, tintedTerrain } from './tint.js';

const ALPHA = 0.85;

export const renderDistricts: StageRenderer = (nodes, ctx) => {
  const polys = nodes.flatMap(n => {
    const hex = DISTRICT_COLOUR[n.attrs.type as DistrictType];
    return hex ? [{ footprint: n.geometry.footprint, rgba: rgbaOf(hex, ALPHA) }] : [];
  });
  return tintedTerrain(ctx, polys, nodes);
};

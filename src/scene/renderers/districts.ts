// Districts are drawn as the terrain, coloured by district type: the types are baked into a
// texture over the site that the ground shader mixes in, so districts add no triangles and the
// colour follows the ground exactly. The owner is happy for the colour to replace the ground's
// own (the terrain view shows that); shading, relief and water stay. Undeveloped shows the
// natural ground.

import * as THREE from 'three/webgpu';
import { walk } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import { bounds, containsPoint } from '../../grammar/polygon.js';
import type { DistrictType } from '../../stages/districts/rules.js';
import { rasterise } from '../rasterise.js';
import type { StageRenderer } from './index.js';
import { buildTerrain } from './terrain.js';

const PX = 1024;
const ALPHA = 0.85;
const COLOUR: Record<DistrictType, string | null> = {
  undeveloped: null,
  rural: '#c9b458', suburban: '#8fbf6a', 'town-core': '#d9884a', 'town-business': '#e0a03c',
  'low-urban': '#c86a8a', urban: '#a04aa8', financial: '#4a5ad0',
};

export const renderDistricts: StageRenderer = (nodes, ctx) => {
  const terrainNodes: RegionNode[] = [];
  walk(ctx.tree, n => { if (n.stage === 'terrain') terrainNodes.push(n); });
  const b = bounds(ctx.tree.geometry.footprint);
  const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  // The palette is sRGB hex, and the texture is tagged sRGB, so the bytes go straight in.
  const polys = nodes.flatMap(n => {
    const hex = COLOUR[n.attrs.type as DistrictType];
    if (!hex) return [];
    const v = parseInt(hex.slice(1), 16);
    return [{ footprint: n.geometry.footprint, rgba: [v >> 16, (v >> 8) & 255, v & 255, Math.round(ALPHA * 255)] as [number, number, number, number] }];
  });
  const tex = new THREE.DataTexture(rasterise(polys, b.minX, b.minZ, size, PX), PX, PX, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;

  const base = buildTerrain(terrainNodes, { tint: { texture: tex, minX: b.minX, minZ: b.minZ, size } });
  const pickables = base.pickables.map(p => ({
    mesh: p.mesh,
    nodeIdAt: (pt: [number, number]) => nodes.find(n => containsPoint(n.geometry.footprint, pt))?.id ?? p.nodeIdAt?.(pt) ?? null,
  }));
  // Materials don't dispose their textures: without this each rebuild (every slider drag)
  // stranded another 4 MB texture on the GPU.
  base.object.userData.dispose = () => tex.dispose();
  return { object: base.object, pickables };
};

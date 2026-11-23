// Shared by stages drawn as the terrain with colour baked on top (districts, arterials): their
// regions are rasterised into a texture over the site that the ground shader mixes in, so they
// add no triangles and follow the ground exactly.

import * as THREE from 'three/webgpu';
import { walk } from '../../doc/tree.js';
import type { MultiPolygon, Point2, RegionNode } from '../../doc/types.js';
import { bounds, containsPoint } from '../../grammar/polygon.js';
import type { DistrictType } from '../../stages/districts/rules.js';
import { rasterise } from '../rasterise.js';
import type { RenderContext, Rendered } from './index.js';
import { buildTerrain } from './terrain.js';

export const DISTRICT_COLOUR: Record<DistrictType, string | null> = {
  undeveloped: null,
  rural: '#c9b458', suburban: '#8fbf6a', 'town-core': '#d9884a', 'town-business': '#e0a03c',
  'low-urban': '#c86a8a', urban: '#a04aa8', financial: '#4a5ad0',
};

export type Rgba = [number, number, number, number];
/** sRGB hex + alpha as texture bytes (the texture is tagged sRGB, so bytes go straight in). */
export const rgbaOf = (hex: string, alpha: number): Rgba => {
  const v = parseInt(hex.slice(1), 16);
  return [v >> 16, (v >> 8) & 255, v & 255, Math.round(alpha * 255)];
};

/** The terrain, tinted by `polys` (later ones paint over earlier), picking `pick` nodes first. */
export function tintedTerrain(ctx: RenderContext, polys: { footprint: MultiPolygon; rgba: Rgba }[], pick: RegionNode[], px = 1024): Rendered {
  const terrainNodes: RegionNode[] = [];
  walk(ctx.tree, n => { if (n.stage === 'terrain') terrainNodes.push(n); });
  const b = bounds(ctx.tree.geometry.footprint);
  const size = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const tex = new THREE.DataTexture(rasterise(polys, b.minX, b.minZ, size, px), px, px, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const base = buildTerrain(terrainNodes, { tint: { texture: tex, minX: b.minX, minZ: b.minZ, size } });
  const pickables = base.pickables.map(p => ({
    mesh: p.mesh,
    nodeIdAt: (pt: Point2) => pick.find(n => containsPoint(n.geometry.footprint, pt))?.id ?? p.nodeIdAt?.(pt) ?? null,
  }));
  // Materials don't dispose their textures: without this each rebuild (every slider drag)
  // stranded another texture on the GPU.
  base.object.userData.dispose = () => tex.dispose();
  return { object: base.object, pickables, ground: base.ground };
}

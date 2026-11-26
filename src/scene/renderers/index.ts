// How each stage's regions look, keyed by stage id. Kept out of the stage
// modules so the generation worker never bundles Three.js.

import type * as THREE from 'three/webgpu';
import type { Point2, RegionNode } from '../../doc/types.js';
import { renderArterials } from './arterials.js';
import { renderBlocks } from './blocks.js';
import { renderDistricts } from './districts.js';
import { renderSite } from './site.js';
import { renderTerrain } from './terrain.js';

export interface RenderContext {
  tree: RegionNode; isCurrent: boolean;
  /** ground heights are drawn × this; anything built on the ground keeps its own height */
  exaggeration: number;
}
export interface PickableMesh {
  mesh: THREE.Mesh;
  /** face-based lookup (merged slab meshes) */
  nodeIdForFace?(faceIndex: number): string;
  /** point-based lookup (terrain: the region containing the ground point) */
  nodeIdAt?(point: Point2): string | null;
}
export interface Rendered {
  object: THREE.Object3D; pickables: PickableMesh[];
  /** the terrain as drawn (x, y, z positions and triangle indices), for draping things on it */
  ground?: { pos: ArrayLike<number>; tris: ArrayLike<number> };
}
export type StageRenderer = (nodes: RegionNode[], ctx: RenderContext) => Rendered;

export const RENDERERS: Record<string, StageRenderer> = {
  site: renderSite,
  terrain: renderTerrain,
  districts: renderDistricts,
  arterials: renderArterials,
  blocks: renderBlocks,
};

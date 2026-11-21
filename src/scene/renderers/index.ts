// How each stage's regions look, keyed by stage id. Kept out of the stage
// modules so the generation worker never bundles Three.js.

import type * as THREE from 'three/webgpu';
import type { RegionNode } from '../../doc/types.js';
import { renderSite } from './site.js';

export interface RenderContext { tree: RegionNode; isCurrent: boolean }
export interface PickableMesh { mesh: THREE.Mesh; nodeIdForFace(faceIndex: number): string }
export interface Rendered { object: THREE.Object3D; pickables: PickableMesh[] }
export type StageRenderer = (nodes: RegionNode[], ctx: RenderContext) => Rendered;

export const RENDERERS: Record<string, StageRenderer> = {
  site: renderSite,
};

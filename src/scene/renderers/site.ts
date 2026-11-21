import * as THREE from 'three/webgpu';
import { slabMesh } from '../slabMesh.js';
import type { StageRenderer } from './index.js';

const GROUND = new THREE.Color(0x3a3b3e);

export const renderSite: StageRenderer = nodes => {
  const pick = slabMesh(nodes, () => GROUND, { lift: 0 });
  pick.mesh.castShadow = false;
  return { object: pick.mesh, pickables: [pick] };
};

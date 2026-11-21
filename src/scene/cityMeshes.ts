// Turns generated City data into Three.js meshes.
//
// Every building is the same unit cube, so they are drawn as one InstancedMesh:
// one draw call for the whole skyline, each instance scaled and placed by its
// own matrix. Block pavements get the same treatment.

import * as THREE from 'three/webgpu';
import type { City } from '../city/generate.js';

const BUILDING_COLOURS = [0xc9c2b6, 0xb7b2aa, 0x9fa6ad, 0xd6cfc2, 0x8d939a, 0xbfae98].map(c => new THREE.Color(c));

export function createCityMeshes(city: City): THREE.Group {
  const group = new THREE.Group();

  // Unit cube with its base at y=0, so scale.y is the building height.
  const box = new THREE.BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);

  const buildings = new THREE.InstancedMesh(
    box,
    new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 }),
    city.buildings.length,
  );
  buildings.castShadow = true;
  buildings.receiveShadow = true;

  const m = new THREE.Matrix4();
  const colour = new THREE.Color();
  city.buildings.forEach((b, i) => {
    m.makeScale(b.width, b.height, b.depth).setPosition(b.x, 0, b.z);
    buildings.setMatrixAt(i, m);
    const base = BUILDING_COLOURS[Math.floor(b.tint * BUILDING_COLOURS.length)];
    buildings.setColorAt(i, colour.copy(base).offsetHSL(0, 0, (b.tint - 0.5) * 0.08));
  });
  buildings.computeBoundingSphere();
  group.add(buildings);

  const slab = new THREE.BoxGeometry(1, 1, 1);
  slab.translate(0, 0.5, 0);
  const pavements = new THREE.InstancedMesh(
    slab,
    new THREE.MeshStandardMaterial({ color: 0x6f6d68, roughness: 1 }),
    city.blocks.length,
  );
  pavements.receiveShadow = true;
  city.blocks.forEach((r, i) => {
    pavements.setMatrixAt(i, m.makeScale(r.width, 0.25, r.depth).setPosition(r.x, 0, r.z));
  });
  pavements.computeBoundingSphere();
  group.add(pavements);

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(city.width, city.depth).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x2c2d30, roughness: 1 }),
  );
  road.receiveShadow = true;
  group.add(road);

  return group;
}

export function disposeGroup(group: THREE.Object3D): void {
  group.traverse(obj => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose();
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(mat => mat.dispose());
    }
  });
}

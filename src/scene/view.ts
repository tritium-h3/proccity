// Turns a ViewState into Three.js objects: the site always, plus the current
// stage's regions (the newest leaves); earlier stages are hidden.

import * as THREE from 'three/webgpu';
import { findById, walk } from '../doc/tree.js';
import type { RegionNode } from '../doc/types.js';
import type { Stage } from '../stages/types.js';
import { RENDERERS, type PickableMesh } from './renderers/index.js';

export interface ViewState {
  tree: RegionNode;
  stages: Stage[];
  generatedThrough: number;
  currentStage: number;
  selectedId: string | null;
}

export interface BuiltView { group: THREE.Group; pickables: PickableMesh[]; dispose(): void }

function nodesOfStage(tree: RegionNode, stageId: string): RegionNode[] {
  const out: RegionNode[] = [];
  walk(tree, n => { if (n.stage === stageId) out.push(n); });
  return out;
}

export function buildView(v: ViewState): BuiltView {
  const group = new THREE.Group();
  const pickables: PickableMesh[] = [];
  const add = (stageId: string, nodes: RegionNode[], isCurrent: boolean) => {
    const render = RENDERERS[stageId];
    if (!render || nodes.length === 0) return;
    const r = render(nodes, { tree: v.tree, isCurrent });
    group.add(r.object);
    pickables.push(...r.pickables);
  };

  add('site', [v.tree], v.currentStage < 0);
  const current = v.stages[v.currentStage];
  if (current && v.currentStage <= v.generatedThrough) add(current.id, nodesOfStage(v.tree, current.id), true);

  return {
    group,
    pickables,
    dispose() {
      group.traverse(o => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.LineLoop) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        }
      });
    },
  };
}

/** Outline of a region's footprint, drawn at its top (or just above ground when open). */
export function outline(tree: RegionNode, id: string, colour: number, opacity: number): THREE.Group | null {
  const node = findById(tree, id);
  if (!node) return null;
  const y = (node.geometry.height.high ?? 0) + 0.3;
  const group = new THREE.Group();
  for (const [outer] of node.geometry.footprint) {
    if (!outer) continue;
    const g = new THREE.BufferGeometry().setFromPoints(outer.map(([x, z]) => new THREE.Vector3(x, y, z)));
    group.add(new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity })));
  }
  return group;
}

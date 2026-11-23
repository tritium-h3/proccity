// Turns a ViewState into Three.js objects: the site always, plus the current
// stage's regions (the newest leaves); earlier stages are hidden.

import * as THREE from 'three/webgpu';
import { findById, walk } from '../doc/tree.js';
import { groundHeightAt } from '../doc/ground.js';
import type { Point2, RegionNode } from '../doc/types.js';
import type { Stage } from '../stages/types.js';
import { RENDERERS, type PickableMesh } from './renderers/index.js';
import { waterSurfaceAt } from './renderers/terrain.js';

export interface ViewState {
  tree: RegionNode;
  stages: Stage[];
  generatedThrough: number;
  currentStage: number;
  selectedId: string | null;
  /** vertical exaggeration of the ground (display only): structures keep their real heights
   *  and sit on the stretched ground */
  exaggeration: number;
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
    const r = render(nodes, { tree: v.tree, isCurrent, exaggeration: v.exaggeration });
    group.add(r.object);
    pickables.push(...r.pickables);
  };

  // The current stage's regions partition the site, so they cover it completely:
  // drawing the site ground underneath as well only z-fights with them.
  const current = v.stages[v.currentStage];
  const currentNodes = current && v.currentStage <= v.generatedThrough ? nodesOfStage(v.tree, current.id) : [];
  if (currentNodes.length) add(current.id, currentNodes, true);
  else add('site', [v.tree], true);

  return {
    group,
    pickables,
    dispose() {
      group.traverse(o => {
        // Renderers attach userData.dispose for what materials don't own (baked textures).
        if (typeof o.userData.dispose === 'function') o.userData.dispose();
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        }
      });
    },
  };
}

export { groundHeightAt };

/** Split long edges so a draped line follows the ground. */
function densify(ring: Point2[], step: number): Point2[] {
  const out: Point2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let t = 0; t < n; t++) out.push([a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n]);
  }
  return out;
}

/** Outline of a region's footprint: at its top when capped, draped 1 m over the ground when open. */
export function outline(tree: RegionNode, id: string, colour: number, opacity: number, exaggeration = 1): THREE.Group | null {
  const node = findById(tree, id);
  if (!node) return null;
  const { high } = node.geometry.height;
  const group = new THREE.Group();
  for (const [outer] of node.geometry.footprint) {
    if (!outer) continue;
    // Drape points every site/250 (8 m at 2 km): a fixed 8 m meant thousands of height lookups
    // per outline at 30 km, and the hover outline was rebuilt every frame while orbiting.
    const siteSpan = Math.max(...tree.geometry.footprint[0][0].map(p => Math.abs(p[0]))) * 2;
    const ring = high === null ? densify(outer, Math.max(8, siteSpan / 250)) : outer;
    // A closed Line, not LineLoop: WebGPURenderer doesn't support LineLoop.
    // Over water the ground is the bed; draw on the water surface instead, or it's hidden.
    const water = waterSurfaceAt(node);
    // Ground (and water) stretch with the exaggeration; heights above the ground don't.
    const k = exaggeration;
    const y = (x: number, z: number) => high !== null ? groundHeightAt(tree, x, z) * k + high + 0.3
      : Math.max(groundHeightAt(tree, x, z), water ? water([x, z]) : -Infinity) * k + 1;
    const pts = [...ring, ring[0]].map(([x, z]) => new THREE.Vector3(x, y(x, z), z));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity })));
  }
  return group;
}

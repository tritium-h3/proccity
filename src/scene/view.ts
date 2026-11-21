// Turns a ViewState into Three.js objects: the site always, plus the current
// stage's regions (the newest leaves); earlier stages are hidden.

import * as THREE from 'three/webgpu';
import { findById, walk } from '../doc/tree.js';
import { decodeHeights, sampleHeight } from '../doc/heightfield.js';
import type { Heightfield, Point2, RegionNode } from '../doc/types.js';
import type { Stage } from '../stages/types.js';
import { RENDERERS, type PickableMesh } from './renderers/index.js';
import { waterSurfaceAt } from './renderers/terrain.js';

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
        if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        }
      });
    },
  };
}

const decoded = new WeakMap<Heightfield, Float32Array>();

/** Ground elevation (m above sea level) at a point: the site's height map, or 0 without one. */
export function groundHeightAt(tree: RegionNode, x: number, z: number): number {
  const hf = tree.data?.heightfield;
  if (!hf) return 0;
  let h = decoded.get(hf);
  if (!h) { h = decodeHeights(hf.heights); decoded.set(hf, h); }
  return sampleHeight(hf, h, x, z);
}

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
export function outline(tree: RegionNode, id: string, colour: number, opacity: number): THREE.Group | null {
  const node = findById(tree, id);
  if (!node) return null;
  const { high } = node.geometry.height;
  const group = new THREE.Group();
  for (const [outer] of node.geometry.footprint) {
    if (!outer) continue;
    const ring = high === null ? densify(outer, 8) : outer;
    // A closed Line, not LineLoop: WebGPURenderer doesn't support LineLoop.
    // Over water the ground is the bed; draw on the water surface instead, or it's hidden.
    const water = waterSurfaceAt(node);
    const y = (x: number, z: number) => high !== null ? groundHeightAt(tree, x, z) + high + 0.3
      : Math.max(groundHeightAt(tree, x, z), water ? water([x, z]) : -Infinity) + 1;
    const pts = [...ring, ring[0]].map(([x, z]) => new THREE.Vector3(x, y(x, z), z));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    group.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity })));
  }
  return group;
}

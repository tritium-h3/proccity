// THROWAWAY renderers for the debug stages. Delete with them.

import * as THREE from 'three/webgpu';
import { ancestry } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import { resolveAttr } from '../../stages/settings.js';
import { footprintEdges, slabMesh } from '../slabMesh.js';
import type { RenderContext, StageRenderer } from './index.js';

const HEX: Record<string, number> = {
  red: 0xd9534f, amber: 0xe0a030, green: 0x5cb85c, teal: 0x3aa6a0, blue: 0x4a7fd6, violet: 0x8e6bd1,
};

const colourOf = (ctx: RenderContext) => (n: RegionNode) =>
  new THREE.Color(HEX[String(resolveAttr(ancestry(ctx.tree, n.id), 'colour', {}))] ?? 0x888888);

export const renderDebugGrid: StageRenderer = (nodes, ctx) => {
  const group = new THREE.Group();
  const pick = slabMesh(nodes, colourOf(ctx), { lift: 0.05 });
  group.add(pick.mesh, footprintEdges(nodes, 0.1, 0x0d0f14, 0.6));
  return { object: group, pickables: [pick] };
};

export const renderDebugSplit: StageRenderer = (nodes, ctx) => {
  const group = new THREE.Group();
  const base = colourOf(ctx);
  const buildable = nodes.filter(n => n.kind === 'buildable');
  // Ground under the boxes: the strips, flat, so each strip reads as a plot.
  const strips = nodes.filter(n => n.kind === 'strip');
  const ground = slabMesh(strips.map(s => ({ ...s, geometry: { ...s.geometry, height: { ...s.geometry.height, high: null } } })),
    n => base(n).multiplyScalar(0.45), { lift: 0.05 });
  const boxes = slabMesh(buildable, base, { lift: 0 });
  group.add(ground.mesh, boxes.mesh, footprintEdges(strips, 0.1, 0x0d0f14, 0.6));
  return { object: group, pickables: [boxes, ground] };
};

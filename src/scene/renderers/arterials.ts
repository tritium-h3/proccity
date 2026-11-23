// Arterials: the terrain tinted with each superblock's district colour, and the roads baked on
// top as asphalt, so roads on land add no triangles. Bridges are real decks over the river, a
// handful of triangles each, level with the higher bank plus a metre.

import * as THREE from 'three/webgpu';
import { groundHeightAt } from '../../doc/ground.js';
import { walk } from '../../doc/tree.js';
import type { RegionNode } from '../../doc/types.js';
import type { DistrictType } from '../../stages/districts/rules.js';
import { flatSurface } from '../../stages/terrain/ground.js';
import type { StageRenderer } from './index.js';
import { DISTRICT_COLOUR, rgbaOf, tintedTerrain } from './tint.js';

const PX = 2048;            // finer than districts: a 25 m road is ~25 px wide
const ASPHALT = '#3a3a3e';
const DECK = 0x55555a;

export const renderArterials: StageRenderer = (nodes, ctx) => {
  const byId = new Map<string, RegionNode>();
  walk(ctx.tree, n => byId.set(n.id, n));
  const parentOf = (n: RegionNode) => byId.get(n.id.slice(0, n.id.lastIndexOf('/')));
  const blocks = nodes.flatMap(n => {
    if (n.kind !== 'superblock') return [];
    const hex = DISTRICT_COLOUR[parentOf(n)?.attrs.type as DistrictType];
    return hex ? [{ footprint: n.geometry.footprint, rgba: rgbaOf(hex, 0.85) }] : [];
  });
  const roads = nodes.filter(n => n.kind === 'arterial').map(n => ({ footprint: n.geometry.footprint, rgba: rgbaOf(ASPHALT, 0.95) }));
  const bridges = nodes.filter(n => n.kind === 'bridge');
  const out = tintedTerrain(ctx, [...blocks, ...roads], [...bridges, ...nodes.filter(n => n.kind !== 'bridge')], PX);

  // Bridge decks.
  const pos: number[] = [];
  for (const b of bridges) {
    const fp = b.geometry.footprint;
    const top = Math.max(...fp.flat(2).map(([x, z]) => groundHeightAt(ctx.tree, x, z))) + 1;
    const g = flatSurface(fp);
    for (const [i, j, k] of g.triangles) {
      const [a, bb, c] = [g.points[i], g.points[j], g.points[k]];
      const ccw = (bb[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (bb[1] - a[1]) > 0;
      for (const p of ccw ? [a, c, bb] : [a, bb, c]) pos.push(p[0], top, p[1]);
    }
  }
  if (pos.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const deck = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color: DECK, roughness: 0.8 }));
    deck.castShadow = true;
    deck.receiveShadow = true;
    out.object.add(deck);
    // The shared lookup already checks bridges first.
    out.pickables.unshift({ mesh: deck, nodeIdAt: out.pickables[0].nodeIdAt });
  }
  return out;
};

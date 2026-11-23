// Arterials: the terrain tinted with each superblock's district colour, and the roads as
// ribbons draped on the ground as drawn. At 30 km a 25 m road is under 2 pixels of any baked
// texture, so roads are geometry: about 2 triangles per sample, samples every site/300 (100 m at
// 30 km). Bridges are decks over the river, level with the higher bank plus a metre.

import * as THREE from 'three/webgpu';
import { groundHeightAt } from '../../doc/ground.js';
import { walk } from '../../doc/tree.js';
import type { Point2, RegionNode } from '../../doc/types.js';
import { bounds, containsPoint } from '../../grammar/polygon.js';
import type { DistrictType } from '../../stages/districts/rules.js';
import { flatSurface } from '../../stages/terrain/ground.js';
import { heightSampler } from '../heightSampler.js';
import type { StageRenderer } from './index.js';
import { DISTRICT_COLOUR, rgbaOf, tintedTerrain } from './tint.js';

const ASPHALT = 0x3a3a3e;
const DECK = 0x55555a;
// Above the drawn ground: its shader displaces up to 0.75 m, and the sampler interpolates.
const LIFT = 2;

/** Resample a polyline so no step is longer than `step`, keeping its own vertices. */
function resample(line: Point2[], step: number): Point2[] {
  const out: Point2[] = [line[0]];
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * (k / n), a[1] + (b[1] - a[1]) * (k / n)]);
  }
  return out;
}

export const renderArterials: StageRenderer = (nodes, ctx) => {
  const byId = new Map<string, RegionNode>();
  walk(ctx.tree, n => byId.set(n.id, n));
  const parentOf = (n: RegionNode) => byId.get(n.id.slice(0, n.id.lastIndexOf('/')));
  const blocks = nodes.flatMap(n => {
    // Road strips take their district's colour too (under the ribbons): the texture is ~29 m a
    // pixel at 30 km, and an untinted 25 m strip showed as a pale fringe beside every road.
    if (n.kind !== 'superblock' && n.kind !== 'arterial') return [];
    const hex = DISTRICT_COLOUR[parentOf(n)?.attrs.type as DistrictType];
    return hex ? [{ footprint: n.geometry.footprint, rgba: rgbaOf(hex, 0.85) }] : [];
  });
  const bridges = nodes.filter(n => n.kind === 'bridge');
  const out = tintedTerrain(ctx, blocks, [...bridges, ...nodes.filter(n => n.kind !== 'bridge')]);
  const pick = out.pickables[0]?.nodeIdAt;

  // Road ribbons, draped on the drawn ground.
  const sb = bounds(ctx.tree.geometry.footprint);
  const size = Math.max(sb.maxX - sb.minX, sb.maxZ - sb.minZ);
  const width = Number(nodes.find(n => n.kind === 'arterial')?.attrs.width ?? 25);
  const heightAt = out.ground ? heightSampler(out.ground.pos, out.ground.tris, { minX: sb.minX, minZ: sb.minZ, size }, size / 1500) : (x: number, z: number) => groundHeightAt(ctx.tree, x, z);
  // Over a bridge a ribbon runs at the deck: draped on the drawn ground it dived to the riverbed
  // and showed through the water as a dark strip beside every deck.
  const deckTop = new Map(bridges.map(b => [b, Math.max(...b.geometry.footprint.flat(2).map(([x, z]) => heightAt(x, z))) + 1]));
  const pos: number[] = [], idx: number[] = [];
  for (const road of ctx.tree.data?.roads ?? []) {
    const ownBridges = bridges.filter(b => b.attrs.road === road.id);
    const yAt = (x: number, z: number) => {
      const b = ownBridges.find(br => containsPoint(br.geometry.footprint, [x, z]));
      return b ? deckTop.get(b)! + 0.3 : heightAt(x, z) + LIFT;
    };
    const line = resample(road.points, Math.max(20, size / 300));
    const base = pos.length / 3;
    line.forEach((p, i) => {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len;
      for (const side of [-1, 1]) {
        const x = p[0] + nx * side * width / 2, z = p[1] + nz * side * width / 2;
        pos.push(x, yAt(x, z), z);
      }
    });
    for (let i = 0; i + 1 < line.length; i++) {
      const l0 = base + 2 * i, r0 = l0 + 1, l1 = l0 + 2, r1 = l0 + 3;
      idx.push(l0, l1, r0, r0, l1, r1);
    }
  }
  if (idx.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardNodeMaterial({ color: ASPHALT, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const ribbons = new THREE.Mesh(geo, mat);
    ribbons.receiveShadow = true;
    out.object.add(ribbons);
    if (pick) out.pickables.unshift({ mesh: ribbons, nodeIdAt: pick });
    if (import.meta.env?.DEV) console.info(`[proccity] arterial ribbons: ${idx.length / 3} triangles`);
  }

  // Bridge decks.
  const deck: number[] = [];
  for (const b of bridges) {
    const fp = b.geometry.footprint;
    const top = deckTop.get(b)!;
    const g = flatSurface(fp);
    for (const [i, j, k] of g.triangles) {
      const [a, bb, c] = [g.points[i], g.points[j], g.points[k]];
      const ccw = (bb[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (bb[1] - a[1]) > 0;
      for (const p of ccw ? [a, c, bb] : [a, bb, c]) deck.push(p[0], top, p[1]);
    }
  }
  if (deck.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color: DECK, roughness: 0.8 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.object.add(mesh);
    if (pick) out.pickables.unshift({ mesh, nodeIdAt: pick });
  }
  return out;
};

// Draws the terrain stage: a lit ground mesh from the site's height map, coloured by the
// region each grid point falls in, plus translucent water surfaces at their levels.
// Picking is by ground point (water first), not by face.

import * as THREE from 'three/webgpu';
import { decodeHeights } from '../../doc/heightfield.js';
import type { MultiPolygon, Point2, RegionNode, Ring } from '../../doc/types.js';
import { containsPoint } from '../../grammar/polygon.js';
import { rasterize } from '../../stages/terrain/field.js';
import type { PickableMesh, StageRenderer } from './index.js';

const LAND: Record<string, number> = { flat: 0xa7b48a, slope: 0x7f8f5a, hills: 0x5f6b45, sea: 0x6b6250, river: 0x6b6250, pond: 0x6b6250 };
const WATER: Record<string, number> = { sea: 0x3f6f8f, river: 0x4f86a0, pond: 0x4f86a0 };
const WATER_KINDS = new Set(['sea', 'river', 'pond']);

/** Triangles for a footprint at per-vertex heights. */
function surface(mp: MultiPolygon, y: (p: Point2) => number): number[] {
  const pos: number[] = [];
  for (const [outer, ...holes] of mp) {
    if (!outer || outer.length < 3) continue;
    const all: Ring = [...outer, ...holes.flat()];
    const tris = THREE.ShapeUtils.triangulateShape(outer.map(([x, z]) => new THREE.Vector2(x, z)), holes.map(hh => hh.map(([x, z]) => new THREE.Vector2(x, z))));
    for (const [a, b, c] of tris) {
      // Order for an upward face: with x right and z down-screen, (a, c, b) faces +y for CCW rings.
      for (const idx of [a, c, b]) pos.push(all[idx][0], y(all[idx]), all[idx][1]);
    }
  }
  return pos;
}

/** River surface: linear in arc length from sourceSurface to mouthSurface, at the nearest course point. */
function riverSurface(river: RegionNode): (p: Point2) => number {
  const course = river.data?.course ?? [];
  const src = Number(river.attrs.sourceSurface ?? 0), mouth = Number(river.attrs.mouthSurface ?? 0);
  const cum = [0];
  for (let i = 1; i < course.length; i++) cum.push(cum[i - 1] + Math.hypot(course[i][0] - course[i - 1][0], course[i][1] - course[i - 1][1]));
  const L = cum[cum.length - 1] || 1;
  return p => {
    let best = 0, bd = Infinity;
    course.forEach((q, i) => { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < bd) { bd = d; best = i; } });
    const t = cum[best] / L;
    return src + (mouth - src) * t;
  };
}

export const renderTerrain: StageRenderer = (nodes, ctx) => {
  const group = new THREE.Group();
  const hf = ctx.tree.data?.heightfield;
  if (!hf) return { object: group, pickables: [] };
  const h = decodeHeights(hf.heights);
  const grid = { cols: hf.cols, rows: hf.rows, cell: hf.cell, origin: hf.origin };

  // Region label per grid point → vertex colour. Unlabelled (edge rounding) falls back to slope.
  const colour = new Float32Array(hf.cols * hf.rows * 3);
  const fallback = new THREE.Color(LAND.slope);
  for (let k = 0; k < hf.cols * hf.rows; k++) colour.set([fallback.r, fallback.g, fallback.b], k * 3);
  const ordered = [...nodes].sort((a, b) => Number(WATER_KINDS.has(a.kind)) - Number(WATER_KINDS.has(b.kind))); // water last wins
  for (const n of ordered) {
    const c = new THREE.Color(LAND[n.kind] ?? LAND.slope);
    rasterize(grid, n.geometry.footprint).forEach((v, k) => { if (v) colour.set([c.r, c.g, c.b], k * 3); });
  }

  const pos = new Float32Array(hf.cols * hf.rows * 3);
  for (let j = 0; j < hf.rows; j++) for (let i = 0; i < hf.cols; i++) {
    const k = j * hf.cols + i;
    pos.set([hf.origin[0] + i * hf.cell, h[k], hf.origin[1] + j * hf.cell], k * 3);
  }
  const index: number[] = [];
  for (let j = 0; j < hf.rows - 1; j++) for (let i = 0; i < hf.cols - 1; i++) {
    const a = j * hf.cols + i, b = a + 1, c = a + hf.cols, d = c + 1;
    index.push(a, c, b, b, c, d); // faces +y
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colour, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
  ground.castShadow = true;
  ground.receiveShadow = true;
  group.add(ground);

  const waterMeshes: THREE.Mesh[] = [];
  for (const n of nodes.filter(nn => WATER_KINDS.has(nn.kind))) {
    const y = n.kind === 'river' ? riverSurface(n) : () => Number(n.attrs.surface ?? 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(surface(n.geometry.footprint, y), 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: WATER[n.kind], transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0 }));
    m.receiveShadow = true;
    m.renderOrder = 1;
    waterMeshes.push(m);
    group.add(m);
  }

  // Point lookup: water regions first (their surface hides the bed), then land.
  const byPriority = [...nodes].sort((a, b) => Number(WATER_KINDS.has(b.kind)) - Number(WATER_KINDS.has(a.kind)));
  const nodeIdAt = (p: Point2) => byPriority.find(n => containsPoint(n.geometry.footprint, p))?.id ?? null;
  const pickables: PickableMesh[] = [...waterMeshes, ground].map(mesh => ({ mesh, nodeIdAt }));
  return { object: group, pickables };
};

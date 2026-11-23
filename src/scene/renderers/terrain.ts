// Draws terrain v2: one ground mesh from every region's stored triangulation, plus water
// surfaces. All fine detail is cosmetic and lives in a TSL node material (works on both
// the WebGPU and WebGL 2 backends):
//  - colour by region kind, blended with noise so region edges look ragged, not straight
//  - micro-relief: noise bump, plus up to ±NOISE_MAX vertex displacement
//  - a ragged wet-sand band near sea level, so the simple coastline reads as rough
// Per-pixel noise is read from a baked seamless tile (noiseTile.ts), a few texture reads
// instead of about a dozen procedural noise evaluations, the main cost of orbiting.
// None of it touches the saved geometry.

import * as THREE from 'three/webgpu';
import {
  attribute, bumpMap, float, max, mix, mx_noise_float, positionLocal, positionWorld, pow, texture, time, vec2, vec3, vec4,
} from 'three/tsl';
import type { Point2, RegionNode } from '../../doc/types.js';
import { containsPoint } from '../../grammar/polygon.js';
import { riverSurfaceAt } from '../../stages/terrain/elevation.js';
import { flatSurface } from '../../stages/terrain/ground.js';
import { noiseTile } from '../noiseTile.js';
import { faceNormals, phongSubdivide, smoothNormals } from '../smoothMesh.js';
import type { PickableMesh, Rendered, StageRenderer } from './index.js';

// The 2 m cosmetic budget, split between curving the surface and noise displacement.
const CURVE_MAX = 1.25;
const NOISE_MAX = 0.75;
// Only edges that curving would move at least this much are split: everywhere else (flats,
// gentle slopes, water edges) the stored triangles are drawn as they are.
const CURVE_MIN = 0.3;

const WATER_KINDS = new Set(['sea', 'river', 'pond']);
// Blend channels: flat, slope, hills, bed (under water).
const CHANNEL: Record<string, number> = { flat: 0, slope: 1, hills: 2, sea: 3, river: 3, pond: 3 };
const PALETTE = [0xa7b48a, 0x7f8f5a, 0x5f6b45, 0x6b6250].map(c => new THREE.Color(c));
const SAND = new THREE.Color(0xc8b98c);
const WATER_COLOUR: Record<string, number> = { sea: 0x3f6f8f, river: 0x4f86a0, pond: 0x4f86a0 };
const vkey = (x: number, z: number) => `${Math.round(x * 100)},${Math.round(z * 100)}`;

/** The water surface over a water region at a point, or null for land. */
export function waterSurfaceAt(node: RegionNode): ((p: Point2) => number) | null {
  if (node.kind === 'river' && node.data?.course && node.data.profile) {
    const { course, profile } = node.data;
    return p => riverSurfaceAt(course, profile, p);
  }
  if (node.kind === 'sea' || node.kind === 'pond') return () => Number(node.attrs.surface ?? 0);
  return null;
}

// One seamless noise tile, shared by every ground material: 256² RGBA, TILE_CYCLES noise
// features across it, four independent channels.
const TILE_SIZE = 256, TILE_CYCLES = 8;
let tile: THREE.DataTexture | null = null;
function noiseTexture(): THREE.DataTexture {
  if (tile) return tile;
  tile = new THREE.DataTexture(noiseTile(TILE_SIZE, TILE_CYCLES), TILE_SIZE, TILE_SIZE, THREE.RGBAFormat);
  tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
  tile.magFilter = THREE.LinearFilter;
  tile.minFilter = THREE.LinearMipmapLinearFilter;
  tile.generateMipmaps = true;
  tile.needsUpdate = true;
  return tile;
}

/** A colour baked over the site (e.g. district types): rgb replaces the ground colour by alpha. */
export interface GroundTint { texture: THREE.DataTexture; minX: number; minZ: number; size: number }

// Cosmetic noise was tuned at 2 km; `scale` = site size / 2000 keeps its features in proportion.
function groundMaterial(tint: GroundTint | undefined, scale: number, exaggeration: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const xz = positionWorld.xz;
  // Four independent noises (about -1..1) at `freq` features per metre; `offset` shifts the
  // tile so different uses don't line up.
  const N = (freq: number, offset: number) => texture(noiseTexture(), xz.mul(freq / scale / TILE_CYCLES).add(offset)).mul(2).sub(1);

  // Ragged region edges: jitter each channel's weight with its own noise, then sharpen, so
  // the boundary between two kinds wanders instead of following the polygon edge.
  const w = attribute<'vec4'>('weights', 'vec4');
  const jitter = N(0.03, 0).add(N(0.1, 0.37).mul(0.5)).mul(0.3);
  const s = pow(max(w.add(jitter), vec4(0)), vec4(4));
  const total = s.x.add(s.y).add(s.z).add(s.w).add(1e-4);
  const c = (i: number) => vec3(PALETTE[i].r, PALETTE[i].g, PALETTE[i].b);
  const misc = N(0.1, 0.71);
  let colour = c(0).mul(s.x).add(c(1).mul(s.y)).add(c(2).mul(s.z)).add(c(3).mul(s.w)).div(total);
  colour = colour.mul(float(1).add(misc.x.mul(0.08)));                         // colour variation
  const wet = float(1).sub(positionWorld.y.div(exaggeration).add(misc.y.mul(0.8)).sub(0.6).div(0.9).clamp(0, 1)); // wet sand below ~1.5 m (real height)
  colour = mix(colour, vec3(SAND.r, SAND.g, SAND.b), wet.mul(float(1).sub(s.w.div(total))));
  if (tint) {
    const t = texture(tint.texture, xz.sub(vec2(tint.minX, tint.minZ)).div(tint.size));
    colour = mix(colour, t.rgb, t.a);
  }
  m.colorNode = colour;

  // Micro-relief: bump from fine noise, and a little real displacement (≤ ±NOISE_MAX).
  // The bump stays procedural (one octave, so one noise per pixel): a bump read from the tile
  // showed a regular cross-hatch grain, since bilinear texture slopes come out faceted.
  m.normalNode = bumpMap(mx_noise_float(vec3(xz.x.mul(0.25 / scale).add(3), float(3), xz.y.mul(0.25 / scale))), float(0.5));
  // No displacement where land meets water (the bed weight is above 0 exactly on vertices
  // shared with a water region): ±1.5 m exceeded the 0.5 m bank freeboard and sank banks.
  const dry = float(1).sub(w.w.mul(20).clamp(0, 1));
  m.positionNode = positionLocal.add(vec3(0, mx_noise_float(vec3(positionLocal.x.mul(0.03), 0, positionLocal.z.mul(0.03))).mul(NOISE_MAX).mul(dry), 0));
  return m;
}

function waterMaterial(hex: number, scale: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color: hex, transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0 });
  const xz = positionWorld.xz;
  m.normalNode = bumpMap(mx_noise_float(vec3(xz.x.mul(0.05 / scale).add(time.mul(0.3)), time.mul(0.1), xz.y.mul(0.05 / scale))), float(0.25));
  return m;
}

export const renderTerrain: StageRenderer = (nodes, ctx) => buildTerrain(nodes, { exaggeration: ctx.exaggeration });

/** The terrain's ground and water, optionally tinted (later stages reuse it as their base). */
export function buildTerrain(nodes: RegionNode[], opts: { tint?: GroundTint; exaggeration?: number }): Rendered {
  const vk = opts.exaggeration ?? 1;
  const t0 = performance.now();
  const group = new THREE.Group();
  // Old v1 cities have no ground data: draw their regions flat at 0 so they still show.
  const groundOf = new Map(nodes.map(n => [n, n.data?.ground ?? flatSurface(n.geometry.footprint)]));
  const withGround = nodes;
  if (!withGround.length) return { object: group, pickables: [] };
  let extent = 0;
  for (const n of withGround) for (const p of n.geometry.footprint.flat(2)) extent = Math.max(extent, Math.abs(p[0]), Math.abs(p[1]));
  const scale = Math.max(0.25, (2 * extent) / 2000);
  // The curve's lift scales with how much steeper the ground got: relief grew about 4× when the
  // site grew 15×, so with the square root of the scale.

  // Ground: every region's triangles in one mesh, vertices shared by key so normals and the
  // colour blend run smoothly across region boundaries.
  const index = new Map<string, number>();
  const pos: number[] = [], weights: number[] = [], counts: number[] = [];
  const tris: number[] = [];
  for (const n of withGround) {
    const ch = CHANNEL[n.kind] ?? 1;
    const g = groundOf.get(n)!;
    const local = g.points.map(([x, z, y]) => {
      const k = vkey(x, z);
      let i = index.get(k);
      if (i === undefined) {
        i = pos.length / 3;
        index.set(k, i);
        pos.push(x, y * vk, z);
        weights.push(0, 0, 0, 0);
        counts.push(0);
      }
      weights[i * 4 + ch] += 1;
      counts[i] += 1;
      return i;
    });
    for (const [a, b, c] of g.triangles) {
      // Order for an upward face: (a, c, b) when the plan-view triangle is CCW.
      const [ax, az] = g.points[a], [bx, bz] = g.points[b], [cx, cz] = g.points[c];
      const ccw = (bx - ax) * (cz - az) - (cx - ax) * (bz - az) > 0;
      tris.push(local[a], ccw ? local[c] : local[b], ccw ? local[b] : local[c]);
    }
  }
  for (let i = 0; i < counts.length; i++) for (let k = 0; k < 4; k++) weights[i * 4 + k] /= counts[i];

  // Smooth shading: soften normals, curve the surface by one subdivision (Phong), soften again.
  const n0 = smoothNormals(pos, tris, faceNormals(pos, tris), 2);
  const sub = phongSubdivide(pos, weights, tris, n0, { maxDy: CURVE_MAX * Math.sqrt(scale), minDy: CURVE_MIN * Math.sqrt(scale) });
  const n1 = smoothNormals(sub.pos, sub.tris, faceNormals(sub.pos, sub.tris), 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(sub.pos, 3));
  geo.setAttribute('weights', new THREE.Float32BufferAttribute(sub.weights, 4));
  geo.setAttribute('normal', new THREE.BufferAttribute(n1, 3));
  geo.setIndex(sub.tris);
  const ground = new THREE.Mesh(geo, groundMaterial(opts.tint, scale, vk));
  ground.castShadow = true;
  ground.receiveShadow = true;
  group.add(ground);

  // Water surfaces: each water region's outline, triangulated on its own and lifted to its
  // surface. The bed's triangles (with their interior points) were twice what a level
  // surface needs.
  const waterMeshes: THREE.Mesh[] = [];
  for (const n of withGround.filter(nn => WATER_KINDS.has(nn.kind))) {
    const surface = waterSurfaceAt(n);
    if (!surface) continue;
    const g = flatSurface(n.geometry.footprint);
    const wp: number[] = [];
    for (const [a, b, c] of g.triangles) {
      const [ax, az] = g.points[a], [bx, bz] = g.points[b], [cx, cz] = g.points[c];
      const ccw = (bx - ax) * (cz - az) - (cx - ax) * (bz - az) > 0;
      for (const i of ccw ? [a, c, b] : [a, b, c]) {
        const [x, z] = g.points[i];
        wp.push(x, surface([x, z]) * vk, z);
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
    wg.computeVertexNormals();
    const mesh = new THREE.Mesh(wg, waterMaterial(WATER_COLOUR[n.kind], scale));
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    waterMeshes.push(mesh);
    group.add(mesh);
  }

  // Point lookup: water regions first (their surface hides the bed), then land.
  const byPriority = [...nodes].sort((a, b) => Number(WATER_KINDS.has(b.kind)) - Number(WATER_KINDS.has(a.kind)));
  const nodeIdAt = (p: Point2) => byPriority.find(n => containsPoint(n.geometry.footprint, p))?.id ?? null;
  const pickables: PickableMesh[] = [...waterMeshes, ground].map(mesh => ({ mesh, nodeIdAt }));

  if (import.meta.env?.DEV) console.info(`[proccity] terrain mesh: ${sub.tris.length / 3} triangles (${tris.length / 3} stored), built in ${(performance.now() - t0).toFixed(1)} ms`);
  return { object: group, pickables, ground: { pos: sub.pos, tris: sub.tris } };
}

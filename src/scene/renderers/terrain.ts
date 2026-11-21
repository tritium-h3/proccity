// Draws terrain v2: one ground mesh from every region's stored triangulation, plus water
// surfaces. All fine detail is cosmetic and lives in a TSL node material (works on both
// the WebGPU and WebGL 2 backends):
//  - colour by region kind, blended with noise so region edges look ragged, not straight
//  - micro-relief: noise bump, plus up to ±1.5 m vertex displacement
//  - a ragged wet-sand band near sea level, so the simple coastline reads as rough
// None of it touches the saved geometry.

import * as THREE from 'three/webgpu';
import {
  attribute, bumpMap, float, max, mix, mx_noise_float, positionLocal, positionWorld, pow, time, vec3, vec4,
} from 'three/tsl';
import type { Point2, RegionNode } from '../../doc/types.js';
import { containsPoint } from '../../grammar/polygon.js';
import { riverSurfaceAt } from '../../stages/terrain/elevation.js';
import { flatSurface } from '../../stages/terrain/ground.js';
import type { PickableMesh, StageRenderer } from './index.js';

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

function groundMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const xz = positionWorld.xz;
  const n = (scale: number, offset: number) => mx_noise_float(vec3(xz.x.mul(scale).add(offset), float(offset), xz.y.mul(scale)));

  // Ragged region edges: jitter each channel's weight with its own noise, then sharpen, so
  // the boundary between two kinds wanders instead of following the polygon edge.
  const w = attribute<'vec4'>('weights', 'vec4');
  const jitter = vec4(n(0.03, 0), n(0.03, 17), n(0.03, 31), n(0.03, 47)).mul(0.22);
  const s = pow(max(w.add(jitter), vec4(0)), vec4(4));
  const total = s.x.add(s.y).add(s.z).add(s.w).add(1e-4);
  const c = (i: number) => vec3(PALETTE[i].r, PALETTE[i].g, PALETTE[i].b);
  let colour = c(0).mul(s.x).add(c(1).mul(s.y)).add(c(2).mul(s.z)).add(c(3).mul(s.w)).div(total);
  colour = colour.mul(float(1).add(n(0.12, 5).mul(0.08)));                    // colour variation
  const wet = float(1).sub(positionWorld.y.add(n(0.08, 9).mul(0.8)).sub(0.6).div(0.9).clamp(0, 1)); // wet sand below ~1.5 m
  colour = mix(colour, vec3(SAND.r, SAND.g, SAND.b), wet.mul(float(1).sub(s.w.div(total))));
  m.colorNode = colour;

  // Micro-relief: bump from fine noise, and a little real displacement (≤ ±1.5 m).
  m.normalNode = bumpMap(n(0.25, 3).add(n(0.9, 11).mul(0.3)), float(0.6));
  // No displacement where land meets water (the bed weight is above 0 exactly on vertices
  // shared with a water region): ±1.5 m exceeded the 0.5 m bank freeboard and sank banks.
  const dry = float(1).sub(w.w.mul(20).clamp(0, 1));
  m.positionNode = positionLocal.add(vec3(0, mx_noise_float(vec3(positionLocal.x.mul(0.03), 0, positionLocal.z.mul(0.03))).mul(1.5).mul(dry), 0));
  return m;
}

function waterMaterial(hex: number): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ color: hex, transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0 });
  const xz = positionWorld.xz;
  m.normalNode = bumpMap(mx_noise_float(vec3(xz.x.mul(0.05).add(time.mul(0.3)), time.mul(0.1), xz.y.mul(0.05))), float(0.25));
  return m;
}

export const renderTerrain: StageRenderer = nodes => {
  const t0 = performance.now();
  const group = new THREE.Group();
  // Old v1 cities have no ground data: draw their regions flat at 0 so they still show.
  const groundOf = new Map(nodes.map(n => [n, n.data?.ground ?? flatSurface(n.geometry.footprint)]));
  const withGround = nodes;
  if (!withGround.length) return { object: group, pickables: [] };

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
        pos.push(x, y, z);
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

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('weights', new THREE.Float32BufferAttribute(weights, 4));
  geo.setIndex(tris);
  geo.computeVertexNormals();
  const ground = new THREE.Mesh(geo, groundMaterial());
  ground.castShadow = true;
  ground.receiveShadow = true;
  group.add(ground);

  // Water surfaces: each water region's own triangles, lifted to its surface.
  const waterMeshes: THREE.Mesh[] = [];
  for (const n of withGround.filter(nn => WATER_KINDS.has(nn.kind))) {
    const surface = waterSurfaceAt(n);
    if (!surface) continue;
    const g = groundOf.get(n)!;
    const wp: number[] = [];
    for (const [a, b, c] of g.triangles) {
      const [ax, az] = g.points[a], [bx, bz] = g.points[b], [cx, cz] = g.points[c];
      const ccw = (bx - ax) * (cz - az) - (cx - ax) * (bz - az) > 0;
      for (const i of ccw ? [a, c, b] : [a, b, c]) {
        const [x, z] = g.points[i];
        wp.push(x, surface([x, z]), z);
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
    wg.computeVertexNormals();
    const mesh = new THREE.Mesh(wg, waterMaterial(WATER_COLOUR[n.kind]));
    mesh.receiveShadow = true;
    mesh.renderOrder = 1;
    waterMeshes.push(mesh);
    group.add(mesh);
  }

  // Point lookup: water regions first (their surface hides the bed), then land.
  const byPriority = [...nodes].sort((a, b) => Number(WATER_KINDS.has(b.kind)) - Number(WATER_KINDS.has(a.kind)));
  const nodeIdAt = (p: Point2) => byPriority.find(n => containsPoint(n.geometry.footprint, p))?.id ?? null;
  const pickables: PickableMesh[] = [...waterMeshes, ground].map(mesh => ({ mesh, nodeIdAt }));

  if (import.meta.env?.DEV) console.info(`[proccity] terrain mesh: ${tris.length / 3} triangles, built in ${(performance.now() - t0).toFixed(1)} ms`);
  return { object: group, pickables };
};

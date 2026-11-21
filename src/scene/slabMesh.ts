// Builds one merged mesh for many slab regions, with per-vertex colour and a
// face → node lookup for picking. Open-topped slabs draw as flat footprints;
// capped slabs are extruded (walls + roof). Ground is flat (y = 0) until the
// terrain stage exists.

import * as THREE from 'three/webgpu';
import type { RegionNode, Ring } from '../doc/types.js';
import type { PickableMesh } from './renderers/index.js';

type V3 = [number, number, number];

export function slabMesh(
  nodes: RegionNode[],
  colourOf: (n: RegionNode) => THREE.Color,
  opts: { lift: number },
): PickableMesh {
  const pos: number[] = [];
  const col: number[] = [];
  const faceStarts: number[] = []; // first triangle index of each node
  const ids: string[] = [];

  const tri = (a: V3, b: V3, c: V3, want: V3, colour: THREE.Color) => {
    // Order vertices so the face normal points along `want` (keeps FrontSide correct).
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const ordered = n[0] * want[0] + n[1] * want[1] + n[2] * want[2] >= 0 ? [a, b, c] : [a, c, b];
    for (const p of ordered) {
      pos.push(...p);
      col.push(colour.r, colour.g, colour.b);
    }
  };

  const cap = (outer: Ring, holes: Ring[], y: number, colour: THREE.Color) => {
    const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
    const holeVs = holes.map(h => h.map(([x, z]) => new THREE.Vector2(x, z)));
    const all = [...outer, ...holes.flat()];
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holeVs)) {
      const p = (idx: number): V3 => [all[idx][0], y, all[idx][1]];
      tri(p(i), p(j), p(k), [0, 1, 0], colour);
    }
  };

  for (const node of nodes) {
    faceStarts.push(pos.length / 9);
    ids.push(node.id);
    const colour = colourOf(node);
    const { low, high } = node.geometry.height;
    for (const [outer, ...holes] of node.geometry.footprint) {
      if (!outer || outer.length < 3) continue;
      if (high === null) {
        cap(outer, holes, opts.lift, colour);
        continue;
      }
      cap(outer, holes, high, colour);
      for (const ring of [outer, ...holes]) {
        for (let i = 0; i < ring.length; i++) {
          const [ax, az] = ring[i];
          const [bx, bz] = ring[(i + 1) % ring.length];
          // Outer rings are CCW and holes CW in (x, z), so (dz, -dx) points out of the solid.
          const want: V3 = [bz - az, 0, -(bx - ax)];
          const a0: V3 = [ax, low, az], b0: V3 = [bx, low, bz], a1: V3 = [ax, high, az], b1: V3 = [bx, high, bz];
          tri(a0, b0, b1, want, colour);
          tri(a0, b1, a1, want, colour);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return {
    mesh,
    nodeIdForFace(faceIndex) {
      // Last node whose first face is <= faceIndex.
      let lo = 0, hi = faceStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (faceStarts[mid] <= faceIndex) lo = mid; else hi = mid - 1;
      }
      return ids[lo];
    },
  };
}

/** Thin outlines of each footprint, to show where regions divide. */
export function footprintEdges(nodes: RegionNode[], y: number, colour: number, opacity = 0.35): THREE.LineSegments {
  const pts: number[] = [];
  for (const n of nodes) for (const poly of n.geometry.footprint) for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      pts.push(ax, y, az, bx, y, bz);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity }));
}

// Render-time smoothing for the terrain mesh (cosmetic only; the saved city is untouched).
// Plain arrays, no Three.js, so it's testable:
//  - faceNormals / smoothNormals: area-weighted vertex normals, then Laplacian-smoothed over
//    the mesh so light rolls over creases instead of breaking at them
//  - phongSubdivide: split every triangle into four; each new edge midpoint is lifted towards
//    the curved surface implied by its endpoints' normals (Phong tessellation), in y only and
//    by at most maxDy, and left straight on edges touching water so banks can't sink

/** Area-weighted vertex normals (unnormalised face normals summed per vertex), normalised. */
export function faceNormals(pos: number[], tris: number[]): Float32Array {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; } // terrain faces up
    for (const v of [a, b, c]) { n[v * 3] += nx; n[v * 3 + 1] += ny; n[v * 3 + 2] += nz; }
  }
  return normalise(n);
}

function normalise(n: Float32Array): Float32Array {
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/** Average each vertex normal with its mesh neighbours', `iterations` times. */
export function smoothNormals(pos: number[], tris: number[], normals: Float32Array, iterations: number): Float32Array {
  const count = pos.length / 3;
  const nbrs: Set<number>[] = Array.from({ length: count }, () => new Set());
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    nbrs[a].add(b).add(c); nbrs[b].add(a).add(c); nbrs[c].add(a).add(b);
  }
  let n: Float32Array = Float32Array.from(normals);
  for (let it = 0; it < iterations; it++) {
    const next = new Float32Array(n.length);
    for (let v = 0; v < count; v++) {
      let x = n[v * 3], y = n[v * 3 + 1], z = n[v * 3 + 2];
      for (const u of nbrs[v]) { x += n[u * 3]; y += n[u * 3 + 1]; z += n[u * 3 + 2]; }
      next[v * 3] = x; next[v * 3 + 1] = y; next[v * 3 + 2] = z;
    }
    n = normalise(next);
  }
  return n;
}

export interface Subdivided {
  pos: number[]; weights: number[]; tris: number[]; normals: Float32Array;
  /** for each new (midpoint) vertex: its edge's endpoints, and its straight-line height */
  parents: [number, number][]; linearY: number[];
}

export function phongSubdivide(pos: number[], weights: number[], tris: number[], normals: Float32Array, o: { maxDy: number }): Subdivided {
  const outPos = [...pos], outW = [...weights];
  const outN: number[] = Array.from(normals);
  const parents: [number, number][] = [], linearY: number[] = [];
  const mid = new Map<string, number>();
  const touchesWater = (v: number) => weights[v * 4 + 3] > 0;

  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const hit = mid.get(key);
    if (hit !== undefined) return hit;
    const P = (v: number) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];
    const N = (v: number) => [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
    const pa = P(a), pb = P(b), m = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
    let y = m[1];
    if (!touchesWater(a) && !touchesWater(b)) {
      // Phong: project the midpoint onto each endpoint's tangent plane and average (y only).
      const proj = (p: number[], n: number[]) => {
        const d = (m[0] - p[0]) * n[0] + (m[1] - p[1]) * n[1] + (m[2] - p[2]) * n[2];
        return m[1] - d * n[1];
      };
      const phong = (proj(pa, N(a)) + proj(pb, N(b))) / 2;
      y = m[1] + Math.max(-o.maxDy, Math.min(o.maxDy, 0.75 * (phong - m[1])));
    }
    const v = outPos.length / 3;
    outPos.push(m[0], y, m[2]);
    for (let k = 0; k < 4; k++) outW.push((weights[a * 4 + k] + weights[b * 4 + k]) / 2);
    const nx = normals[a * 3] + normals[b * 3], ny = normals[a * 3 + 1] + normals[b * 3 + 1], nz = normals[a * 3 + 2] + normals[b * 3 + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    outN.push(nx / l, ny / l, nz / l);
    parents.push([a, b]); linearY.push(m[1]);
    mid.set(key, v);
    return v;
  };

  const outT: number[] = [];
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    outT.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { pos: outPos, weights: outW, tris: outT, normals: Float32Array.from(outN), parents, linearY };
}

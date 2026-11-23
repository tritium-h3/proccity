// The routing grid: a raster over the site holding what a road cares about at each cell
// (elevation, what kind of ground, how far to a district border or a placed road, and which
// way those run), and the cost of one step between neighbouring cells. Arterials follow the
// terrain because grade along the heading costs (steeply past Max grade, but never
// infinitely), prefer district borders because they're cheap corridors, and keep clear of
// each other because running alongside a placed road costs.

import type { MultiPolygon, Point2 } from '../../doc/types.js';

export const LAND = 0, HILLS = 1, RIVER = 2, BLOCKED = 3;

export interface Grid {
  minX: number; minZ: number; cell: number; w: number; h: number;
  elev: Float32Array; kind: Uint8Array;
  /** m to the nearest district border, and the angle of that border's normal */
  border: Float32Array; borderNormal: Float32Array;
  /** angle of the river bank's normal (river cells): the way straight across */
  riverNormal: Float32Array;
  /** m to the nearest placed road, and the angle of that road's normal */
  road: Float32Array; roadNormal: Float32Array;
}
export interface GridInput {
  bounds: { minX: number; minZ: number; size: number };
  elevAt(x: number, z: number): number;
  kindAt(x: number, z: number): number;
  districts: MultiPolygon[];
  river?: MultiPolygon;
}
export interface CostParams { maxGrade: number; roadWidth: number; usableWidth: number }

const BORDER_BAND = 40;   // m beside a border where running parallel costs
const EDGE_SCALE = 125;   // m: about half a district; cost rises gently towards its edges
// Cost on a district border. At 0.5 roads traced every jag of the (Voronoi) borders.
const CORRIDOR = 0.75;
const ROAD_REACH = 160;   // m: how far a placed road's influence is recorded (≥ max usable width)

export const cellOf = (g: Grid, x: number, z: number) => {
  const i = Math.min(g.w - 1, Math.max(0, Math.floor((x - g.minX) / g.cell)));
  const j = Math.min(g.h - 1, Math.max(0, Math.floor((z - g.minZ) / g.cell)));
  return j * g.w + i;
};
export const centreOf = (g: Grid, c: number): Point2 => [g.minX + ((c % g.w) + 0.5) * g.cell, g.minZ + (Math.floor(c / g.w) + 0.5) * g.cell];

type Seg = [number, number, number, number];
const segsOf = (mp: MultiPolygon): Seg[] => mp.flatMap(poly => poly.flatMap(ring => ring.map((p, i) => {
  const q = ring[(i + 1) % ring.length];
  return [p[0], p[1], q[0], q[1]] as Seg;
})));

/** For every cell within `reach` of a segment: the distance to the nearest, and its normal. */
function nearest(g: Grid, segs: Seg[], reach: number, dist: Float32Array, normal: Float32Array, only?: (c: number) => boolean) {
  for (const [ax, az, bx, bz] of segs) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-9) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len, n = Math.atan2(ux, -uz);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - g.minX) / g.cell)), i1 = Math.min(g.w - 1, Math.floor((Math.max(ax, bx) + reach - g.minX) / g.cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - g.minZ) / g.cell)), j1 = Math.min(g.h - 1, Math.floor((Math.max(az, bz) + reach - g.minZ) / g.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * g.w + i;
      if (only && !only(c)) continue;
      const x = g.minX + (i + 0.5) * g.cell, z = g.minZ + (j + 0.5) * g.cell;
      const t = Math.max(0, Math.min(len, (x - ax) * ux + (z - az) * uz));
      const d = Math.hypot(x - (ax + ux * t), z - (az + uz * t));
      if (d < dist[c]) { dist[c] = d; normal[c] = n; }
    }
  }
}

export function buildGrid(inp: GridInput, cell: number): Grid {
  const { minX, minZ, size } = inp.bounds;
  const w = Math.ceil(size / cell), h = w, n = w * h;
  const g: Grid = {
    minX, minZ, cell, w, h,
    elev: new Float32Array(n), kind: new Uint8Array(n),
    border: new Float32Array(n).fill(Infinity), borderNormal: new Float32Array(n),
    riverNormal: new Float32Array(n),
    road: new Float32Array(n).fill(Infinity), roadNormal: new Float32Array(n),
  };
  for (let c = 0; c < n; c++) {
    const [x, z] = centreOf(g, c);
    g.elev[c] = inp.elevAt(x, z);
    g.kind[c] = inp.kindAt(x, z);
  }
  nearest(g, inp.districts.flatMap(segsOf), BORDER_BAND + EDGE_SCALE, g.border, g.borderNormal);
  if (inp.river) {
    const scratch = new Float32Array(n).fill(Infinity);
    nearest(g, segsOf(inp.river), size, scratch, g.riverNormal, c => g.kind[c] === RIVER);
  }
  return g;
}

export function markRoad(g: Grid, line: Point2[]): void {
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < line.length; i++) segs.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
  nearest(g, segs, ROAD_REACH, g.road, g.roadNormal);
}

/** How square-on a heading meets a line with the given normal: 1 straight across, 0 along. */
const across = (heading: number, normal: number) => Math.abs(Math.cos(heading - normal));

export function stepCost(g: Grid, a: number, b: number, heading: number, p: CostParams): number {
  if (g.kind[a] === BLOCKED || g.kind[b] === BLOCKED) return Infinity;
  const [ax, az] = centreOf(g, a), [bx, bz] = centreOf(g, b);
  const len = Math.hypot(bx - ax, bz - az);
  const grade = Math.abs(g.elev[b] - g.elev[a]) / len, m = p.maxGrade;
  const gradeF = grade <= m ? 1 + 2 * (grade / m) ** 2 : 3 + 40 * ((grade - m) / m) ** 2;
  const k = g.kind[b];
  const base = k === RIVER ? 30 * (1 + 4 * (1 - across(heading, g.riverNormal[b]))) : k === HILLS ? 1.5 : 1;
  const d = g.border[b];
  const borderF = d <= p.roadWidth / 2 ? CORRIDOR : d < BORDER_BAND ? 1 + 3 * (1 - across(heading, g.borderNormal[b])) : 1;
  const edgeF = 1 + 0.3 * Math.max(0, Math.min(1, 1 - d / EDGE_SCALE));
  const r = g.road[b];
  const roadF = r > p.roadWidth / 2 && r < p.usableWidth ? 1 + 3 * (1 - across(heading, g.roadNormal[b])) : 1;
  return len * base * gradeF * borderF * edgeF * roadF;
}

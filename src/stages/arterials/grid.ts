// The routing grid: a raster over the site holding what a road cares about at each cell
// (elevation, what kind of ground, how far to a district border or a placed road, and which
// way those run), and the cost of one step between neighbouring cells. Arterials follow the
// terrain because grade along the heading costs (steeply past Max grade, but never
// infinitely), prefer district borders because they're cheap corridors, and keep clear of
// each other because running alongside a placed road costs.

import type { GroundSurface, MultiPolygon, Point2 } from '../../doc/types.js';

export const LAND = 0, HILLS = 1, RIVER = 2, BLOCKED = 3, WILD = 4;
/** Ground a road may run on. WILD is Undeveloped land other than hills. */
export const isUsable = (k: number) => k === LAND || k === HILLS || k === WILD;

export interface Grid {
  minX: number; minZ: number; cell: number; w: number; h: number;
  elev: Float32Array; kind: Uint8Array;
  /** m to the nearest district border, and the angle of that border's normal */
  border: Float32Array; borderNormal: Float32Array;
  /** the nearest point on that border (x, z), so a road beside a border can be moved onto it */
  borderFootX: Float32Array; borderFootZ: Float32Array;
  /** angle of the river bank's normal (river cells): the way straight across */
  riverNormal: Float32Array;
  /** m to the nearest placed road, and the angle of that road's normal */
  road: Float32Array; roadNormal: Float32Array;
  /** m to the nearest water edge (land cells), and that edge's normal */
  bank: Float32Array; bankNormal: Float32Array;
  /** m to the nearest Undeveloped land (other cells), recorded out to GridScale.wildReach */
  wild: Float32Array;
  /** distances the costs use (m), scaled with the city: see GridScale */
  band: number; edgeScale: number; roadReach: number; bankExtra: number;
}
/** Distances that scale with the city. Defaults are the 2 km-scale values (20 m cells). */
export interface GridScale {
  band?: number; edgeScale?: number; roadReach?: number; riverReach?: number; bankExtra?: number;
  /** how far from water and Undeveloped land distances are recorded (default: band) */
  bankReach?: number; wildReach?: number;
}
export interface GridInput {
  bounds: { minX: number; minZ: number; size: number };
  elevAt(x: number, z: number): number;
  kindAt(x: number, z: number): number;
  districts: MultiPolygon[];
  river?: MultiPolygon;
  /** edges a road shouldn't run along (all water, and the site's own edge): running beside
   *  one costs, so bands don't spill lengthwise over water (they became long "bridges" along
   *  the river) or hug the edge of the map; crossing is free */
  water?: MultiPolygon;
  /** Undeveloped districts (hills included): costly to cross, and kept clear of road ends */
  wild?: MultiPolygon[];
  /** border segments to leave out, e.g. the site's own edge (roads hugged it) */
  skipSegment?(a: Point2, b: Point2): boolean;
  /** faster than kindAt: footprints painted in order over BLOCKED (later wins) */
  kinds?: { footprint: MultiPolygon; kind: number }[];
  /** faster than elevAt: triangulated surfaces painted in order (later wins) */
  surfaces?: GroundSurface[];
}
export interface CostParams { maxGrade: number; roadWidth: number; usableWidth: number }

const BORDER_BAND = 40;   // m beside a border where running parallel costs (2 cells)
const EDGE_SCALE = 125;   // m: about half a district; cost rises gently towards its edges
// Cost on a district border. At 0.5 roads traced every jag of the (Voronoi) borders.
const CORRIDOR = 0.75;
const ROAD_REACH = 160;   // m: how far a placed road's influence is recorded (≥ max usable width)
const RIVER_REACH = 100;  // m: river cells are never farther than this from a bank
// Undeveloped land (hills included) costs this much more to cross: roads still cross it when
// it's the way, but at 1× (1.5× on hills) 8–14% of the network ran through it.
const WILD_COST = 3;

export const cellOf = (g: Grid, x: number, z: number) => {
  const i = Math.min(g.w - 1, Math.max(0, Math.floor((x - g.minX) / g.cell)));
  const j = Math.min(g.h - 1, Math.max(0, Math.floor((z - g.minZ) / g.cell)));
  return j * g.w + i;
};
export const centreOf = (g: Grid, c: number): Point2 => [g.minX + ((c % g.w) + 0.5) * g.cell, g.minZ + (Math.floor(c / g.w) + 0.5) * g.cell];

type Seg = [number, number, number, number];
const segsOf = (mp: MultiPolygon, skip?: (a: Point2, b: Point2) => boolean): Seg[] => mp.flatMap(poly => poly.flatMap(ring => ring.flatMap((p, i) => {
  const q = ring[(i + 1) % ring.length];
  return skip?.(p, q) ? [] : [[p[0], p[1], q[0], q[1]] as Seg];
})));

/** Call fn for every cell whose centre is inside the footprint (even-odd, so holes stay out). */
function eachCellIn(g: Grid, mp: MultiPolygon, fn: (c: number) => void) {
  const rings = mp.flat();
  let zMin = Infinity, zMax = -Infinity;
  for (const r of rings) for (const p of r) { zMin = Math.min(zMin, p[1]); zMax = Math.max(zMax, p[1]); }
  const j0 = Math.max(0, Math.floor((zMin - g.minZ) / g.cell - 0.5)), j1 = Math.min(g.h - 1, Math.ceil((zMax - g.minZ) / g.cell));
  for (let j = j0; j <= j1; j++) {
    const z = g.minZ + (j + 0.5) * g.cell;
    const xs: number[] = [];
    for (const r of rings) for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
      const [ax, az] = r[k], [bx, bz] = r[i];
      if ((az > z) !== (bz > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let t = 0; t + 1 < xs.length; t += 2) {
      const i0 = Math.max(0, Math.ceil((xs[t] - g.minX) / g.cell - 0.5)), i1 = Math.min(g.w - 1, Math.ceil((xs[t + 1] - g.minX) / g.cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) fn(j * g.w + i);
    }
  }
}

/** Write each surface's elevation at the cell centres its triangles cover. */
function paintSurface(g: Grid, s: GroundSurface) {
  for (const [ia, ib, ic] of s.triangles) {
    const [ax, az, ay] = s.points[ia], [bx, bz, by] = s.points[ib], [cx, cz, cy] = s.points[ic];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - g.minX) / g.cell - 0.5)), i1 = Math.min(g.w - 1, Math.ceil((Math.max(ax, bx, cx) - g.minX) / g.cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - g.minZ) / g.cell - 0.5)), j1 = Math.min(g.h - 1, Math.ceil((Math.max(az, bz, cz) - g.minZ) / g.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = g.minX + (i + 0.5) * g.cell, z = g.minZ + (j + 0.5) * g.cell;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
      g.elev[j * g.w + i] = u * ay + v * by + (1 - u - v) * cy;
    }
  }
}

/** For every cell within `reach` of a segment: the distance to the nearest, and its normal. */
function nearest(g: Grid, segs: Seg[], reach: number, dist: Float32Array, normal: Float32Array | null, only?: (c: number) => boolean, foot?: [Float32Array, Float32Array]) {
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
      if (d < dist[c]) {
        dist[c] = d;
        if (normal) normal[c] = n;
        if (foot) { foot[0][c] = ax + ux * t; foot[1][c] = az + uz * t; }
      }
    }
  }
}

export function buildGrid(inp: GridInput, cell: number, sc: GridScale = {}): Grid {
  const { minX, minZ, size } = inp.bounds;
  const w = Math.ceil(size / cell), h = w, n = w * h;
  const g: Grid = {
    minX, minZ, cell, w, h,
    elev: new Float32Array(n), kind: new Uint8Array(n),
    border: new Float32Array(n).fill(Infinity), borderNormal: new Float32Array(n),
    borderFootX: new Float32Array(n), borderFootZ: new Float32Array(n),
    riverNormal: new Float32Array(n),
    road: new Float32Array(n).fill(Infinity), roadNormal: new Float32Array(n),
    bank: new Float32Array(n).fill(Infinity), bankNormal: new Float32Array(n),
    wild: new Float32Array(n).fill(Infinity),
    band: sc.band ?? BORDER_BAND, edgeScale: sc.edgeScale ?? EDGE_SCALE, roadReach: sc.roadReach ?? ROAD_REACH, bankExtra: sc.bankExtra ?? 10,
  };
  if (inp.kinds) {
    g.kind.fill(BLOCKED);
    for (const { footprint, kind } of inp.kinds) eachCellIn(g, footprint, c => { g.kind[c] = kind; });
  } else for (let c = 0; c < n; c++) { const [x, z] = centreOf(g, c); g.kind[c] = inp.kindAt(x, z); }
  if (inp.surfaces) {
    g.elev.fill(NaN);
    for (const sf of inp.surfaces) paintSurface(g, sf);
    for (let c = 0; c < n; c++) if (Number.isNaN(g.elev[c])) { const [x, z] = centreOf(g, c); g.elev[c] = inp.elevAt(x, z); }
  } else for (let c = 0; c < n; c++) { const [x, z] = centreOf(g, c); g.elev[c] = inp.elevAt(x, z); }
  nearest(g, inp.districts.flatMap(d => segsOf(d, inp.skipSegment)), g.band + g.edgeScale, g.border, g.borderNormal, undefined, [g.borderFootX, g.borderFootZ]);
  if (inp.river) {
    const scratch = new Float32Array(n).fill(Infinity);
    nearest(g, segsOf(inp.river), sc.riverReach ?? RIVER_REACH, scratch, g.riverNormal, c => g.kind[c] === RIVER);
  }
  if (inp.water) nearest(g, segsOf(inp.water), Math.max(g.band, sc.bankReach ?? 0), g.bank, g.bankNormal, c => isUsable(g.kind[c]));
  if (inp.wild?.length) {
    const wild = inp.wild;
    nearest(g, wild.flatMap(w => segsOf(w)), sc.wildReach ?? g.band, g.wild, null);
    for (const w of wild) eachCellIn(g, w, c => { g.wild[c] = 0; });
  }
  return g;
}

export function markRoad(g: Grid, line: Point2[]): void {
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < line.length; i++) segs.push([line[i][0], line[i][1], line[i + 1][0], line[i + 1][1]]);
  nearest(g, segs, g.roadReach, g.road, g.roadNormal);
}

/** Forget every placed road and mark these instead (after a road was cut back). */
export function remarkRoads(g: Grid, lines: Point2[][]): void {
  g.road.fill(Infinity);
  for (const line of lines) markRoad(g, line);
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
  const base = k === RIVER ? 30 * (1 + 4 * (1 - across(heading, g.riverNormal[b]))) : k === HILLS || k === WILD ? WILD_COST : 1;
  const d = g.border[b];
  // "On" a border or road means within half a road width, or three-quarters of a cell when cells
  // are bigger (at 100 m cells a 12.5 m test missed whole chains of cells).
  const on = Math.max(p.roadWidth / 2, 0.75 * g.cell);
  const borderF = d <= on ? CORRIDOR : d < g.band ? 1 + 3 * (1 - across(heading, g.borderNormal[b])) : 1;
  const edgeF = 1 + 0.3 * Math.max(0, Math.min(1, 1 - d / g.edgeScale));
  const r = g.road[b];
  // Running alongside a placed road costs, and running along on top of it costs more (it was
  // free, and two roads stacked on one corridor for kilometres). Crossing it doesn't.
  const roadF = r < p.usableWidth ? 1 + (r <= on ? 8 : 3) * (1 - across(heading, g.roadNormal[b])) : 1;
  // Beside water, running along the bank costs (a band there spills over the water).
  const bankF = g.bank[b] < p.roadWidth / 2 + g.bankExtra ? 1 + 3 * (1 - across(heading, g.bankNormal[b])) : 1;
  return len * base * gradeF * borderF * edgeF * roadF * bankF;
}

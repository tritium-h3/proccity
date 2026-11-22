// Elevations for terrain v2, built up from the water: flats take levels from the water they
// follow, slopes and hills rise with distance, and every vertex that touches water or a
// flat is clamped so water can never sit above its banks.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { offsetPolygons } from '../../grammar/clipper.js';
import { containsPoint } from '../../grammar/polygon.js';
import type { Cell } from './cells.js';
import { vkey } from './cells.js';
import type { Classified, RegionGroup } from './rules.js';

export interface Levels {
  /** vkey → elevation (m above sea level) for every cell vertex */
  vertex: Map<string, number>;
  /** per cell: elevation of its centre (seed) point */
  centre: number[];
  flatLevel: (number | null)[];
  pondSurface: (number | null)[];
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0 || 1), 0), 1);
  return t * t * (3 - 2 * t);
};

/** River surface at a point: the profile value at the nearest course point. */
export function riverSurfaceAt(course: Point2[], profile: number[], p: Point2): number {
  let best = 0, bd = Infinity;
  course.forEach((q, i) => { const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (d < bd) { bd = d; best = i; } });
  return profile[best];
}

export function computeLevels(cells: Cell[], c: Classified, groups: RegionGroup[], o: {
  relief: number; hilliness: number; flatWidth: number;
  course: Point2[] | null; profile: number[] | null;
  sea: MultiPolygon | null; river: MultiPolygon | null;
  overrides: { group: number; elevation: number }[];
}, rng: () => number): Levels {
  const maxHop = Math.max(1, ...cells.map(cell => cell.hop));
  const surfaceAt = (p: Point2) => (o.course && o.profile ? riverSurfaceAt(o.course, o.profile, p) : 0);
  // Land beside the river is built up from the river, not from sea level: a slope or hill
  // cell along the upper river otherwise sat tens of metres below it (a levee carrying the
  // water). Floor: half a metre above the highest river surface at any of its corners.
  // Applies by distance from the river (riverHop), whatever water is nearest: a cell nearest
  // the sea but beside the upper river otherwise sat far below it (and dragged a nearby pond
  // down with it).
  const riverFloor = (cell: Cell) => (o.course && Number.isFinite(cell.riverHop)
    ? Math.max(...cell.poly[0].map(surfaceAt)) + 0.5 + cell.riverHop : 0);
  const base = cells.map(cell => Math.max(1, riverFloor(cell),
    o.relief * smoothstep(0, maxHop, cell.hop) + (rng() - 0.5) * 2 * 0.15 * o.hilliness * o.relief));

  // Flat levels.
  const groupOf = new Int32Array(cells.length);
  groups.forEach((g, gi) => g.cells.forEach(ci => { groupOf[ci] = gi; }));
  const override = new Map(o.overrides.map(x => [x.group, x.elevation]));
  const shelfLevel = new Map<number, number>();
  groups.forEach((g, gi) => {
    if (g.kind === 'flat' && g.flatType === 'shelf') shelfLevel.set(gi, Math.round(g.cells.reduce((s, ci) => s + base[ci], 0) / g.cells.length));
  });
  const flatLevel = cells.map((cell, i) => {
    if (c.kind[i] !== 'flat') return null;
    const ov = override.get(groupOf[i]);
    if (ov !== undefined) return ov;
    // Coastal flats sit just above the sea, but never below the river beside them.
    if (c.flatType[i] === 'coastal') return Math.max(2 + cell.hop, riverFloor(cell));
    if (c.flatType[i] === 'river') {
      // At least half a metre above the river surface at every corner of the cell: the
      // surface falls along the river, so the seed's level alone left the upstream end of a
      // long cell below the water.
      const highest = Math.max(...cell.poly[0].map(surfaceAt));
      return Math.max(surfaceAt(cell.seed) + 1.5 + cell.hop, highest + 0.5);
    }
    return shelfLevel.get(groupOf[i])!;
  });

  // Ponds: one level per pond, half a metre below the lowest land cell around the whole pond.
  const levelOf = (i: number) => flatLevel[i] ?? base[i];
  const pondSurface: (number | null)[] = cells.map(() => null);
  for (const g of groups) {
    if (g.kind !== 'pond') continue;
    const inPond = new Set(g.cells);
    const around = [...new Set(g.cells.flatMap(ci => cells[ci].neighbours))].filter(n => !inPond.has(n)).map(levelOf);
    // Never below the river beside it (via its cells' river floor); if that's above its lowest
    // neighbour, the bank rule lifts those corners, so the water never tops its rim.
    const floor = Math.max(0, ...g.cells.map(ci => riverFloor(cells[ci])));
    const surface = Math.max(1, (around.length ? Math.min(...around) : Math.min(...g.cells.map(ci => base[ci]))) - 0.5, floor - 0.5);
    for (const ci of g.cells) pondSurface[ci] = surface;
  }

  // Vertex elevations.
  const incident = new Map<string, { p: Point2; cells: number[] }>();
  cells.forEach((cell, i) => {
    for (const ring of cell.poly) for (const p of ring) {
      const k = vkey(p);
      const e = incident.get(k) ?? { p, cells: [] };
      if (!e.cells.includes(i)) e.cells.push(i);
      incident.set(k, e);
    }
  });
  // Banks: every vertex within BAND of the river or sea sits exactly half a metre above that
  // water (set, not just raised), whatever cell it belongs to. Dense bank vertices at
  // per-cell heights, and corners a hair inland of the bank, made micro-cliffs along the water.
  const BAND = 2;
  const bank = o.river ? offsetPolygons(o.river, BAND) : null;
  const shore = o.sea ? offsetPolygons(o.sea, BAND) : null;
  // Smooth height field over position: blends nearby cells' base heights by distance
  // (Gaussian, about one cell wide). Per-cell averages made near-vertical facets wherever
  // irregular cells put close vertices among very different cells.
  const sigma = Math.max(30, Math.sqrt(cells.reduce((t, c) => t + c.area, 0) / Math.max(1, cells.length)) * 0.8);
  const G = sigma * 2.5;
  const seedGrid = new Map<string, number[]>();
  cells.forEach((cell, i) => {
    const k = `${Math.floor(cell.seed[0] / G)},${Math.floor(cell.seed[1] / G)}`;
    (seedGrid.get(k) ?? seedGrid.set(k, []).get(k)!).push(i);
  });
  const field = (p: Point2): number => {
    const gx = Math.floor(p[0] / G), gz = Math.floor(p[1] / G);
    let ws = 0, vs = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const i of seedGrid.get(`${gx + dx},${gz + dz}`) ?? []) {
        const d2 = (cells[i].seed[0] - p[0]) ** 2 + (cells[i].seed[1] - p[1]) ** 2;
        const w = Math.exp(-d2 / (sigma * sigma));
        ws += w; vs += w * base[i];
      }
    }
    return ws > 1e-12 ? vs / ws : 0;
  };

  // Vertex heights, then a cap: a flat can't stand above what its own edge allows. A small
  // flat whose every edge corner is pulled down to a lower neighbour's level otherwise kept
  // its centre at its own level, making a pyramid "fin" (31 m on a 1,300 m² shelf).
  // Lowering one flat can lower corners it shares, so repeat until nothing changes.
  let blended: (p: Point2, target: number) => number = (_p, t) => t;
  const computeVertices = (): Map<string, number> => {
    const vertex = new Map<string, number>();
    const free: { k: string; p: Point2; inc: number[] }[] = [];
    for (const [k, { p, cells: inc }] of incident) {
      const flats = inc.map(i => flatLevel[i]).filter((v): v is number => v !== null);
      const ponds = inc.map(i => pondSurface[i]).filter((v): v is number => v !== null);
      let e: number;
      if (ponds.length && ponds.length === inc.length) {
        // Shared only by pond cells: the pond's bed.
        e = Math.min(...ponds) - 2;
      } else if (flats.length || ponds.length) {
        // The lowest touching level, but never below any touching pond's bank.
        e = Math.min(...flats, ...ponds.map(s => s + 0.5));
        if (ponds.length) e = Math.max(e, Math.max(...ponds) + 0.5);
      } else {
        e = NaN; // free: blended from the pinned heights around it, below
      }
      // Only vertices of water-touching cells can lie in a bank band.
      const onBank = !!bank && inc.some(i => cells[i].touchesRiver) && containsPoint(bank, p);
      const onShore = !!shore && inc.some(i => cells[i].touchesSea) && containsPoint(shore, p);
      if (onBank || onShore) e = Math.max(onBank ? surfaceAt(p) + 0.5 : -Infinity, onShore ? 0.5 : -Infinity);
      // A pond's bank still holds inside a shore/river band (a pond corner can sit within 2 m of
      // the sea without the pond touching it).
      if (ponds.length && ponds.length !== inc.length) e = Math.max(e, Math.max(...ponds) + 0.5);
      if (Number.isNaN(e)) free.push({ k, p, inc });
      else vertex.set(k, e);
    }

    // Free (slope/hills) vertices rise from the pinned edges around them (flats, ponds, banks)
    // to the field over about a cell's distance: "slopes rise from the edge of flats". Jumping
    // straight to the field made cliffs at every flat and pond edge.
    const RISE = sigma * 1.5;
    const pinGrid = new Map<string, [number, number, number][]>();
    for (const [k, e] of vertex) {
      const p = incident.get(k)!.p;
      const gk = `${Math.floor(p[0] / RISE)},${Math.floor(p[1] / RISE)}`;
      (pinGrid.get(gk) ?? pinGrid.set(gk, []).get(gk)!).push([p[0], p[1], e]);
    }
    blended = (p: Point2, target: number): number => {
      const gx = Math.floor(p[0] / RISE), gz = Math.floor(p[1] / RISE);
      let best: [number, number, number] | null = null, bd = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const q of pinGrid.get(`${gx + dx},${gz + dz}`) ?? []) {
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d < bd) { bd = d; best = q; }
        }
      }
      if (!best || bd >= RISE) return target;
      return best[2] + (target - best[2]) * smoothstep(0, RISE, bd);
    };
    for (const { k, p, inc } of free) {
      // Never below the river floor of the cells it belongs to.
      vertex.set(k, Math.max(blended(p, field(p)), ...inc.map(i => riverFloor(cells[i]))));
    }

    return vertex;
  };
  let vertex = computeVertices();
  const groupOfCell = new Int32Array(cells.length).fill(-1);
  groups.forEach((g, gi) => g.cells.forEach(ci => { groupOfCell[ci] = gi; }));
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    groups.forEach((g, gi) => {
      if (g.kind !== 'flat') return;
      let edgeMax = -Infinity;
      for (const ci of g.cells) for (const p of cells[ci].poly[0]) {
        const inc = incident.get(vkey(p))!.cells;
        if (inc.some(j => groupOfCell[j] !== gi) || cells[ci].touchesEdge) edgeMax = Math.max(edgeMax, vertex.get(vkey(p))!);
      }
      if (!Number.isFinite(edgeMax)) return;
      for (const ci of g.cells) {
        if (flatLevel[ci]! > edgeMax + 1e-9) { flatLevel[ci] = edgeMax; changed = true; }
      }
    });
    if (!changed) break;
    vertex = computeVertices();
  }

  const centre = cells.map((cell, i) => {
    if (pondSurface[i] !== null) return pondSurface[i]! - 2;
    if (flatLevel[i] !== null) return flatLevel[i]!;
    // Hills get a summit bump, scaled to the cell (a full bump on a small cell was a spike).
    const bump = c.kind[i] === 'hills' ? Math.min(0.1 * o.hilliness * o.relief, 0.3 * Math.sqrt(cell.area)) : 0;
    return Math.max(blended(cell.seed, field(cell.seed)), riverFloor(cell)) + bump;
  });

  return { vertex, centre, flatLevel, pondSurface };
}

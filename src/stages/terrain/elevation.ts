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
  const base = cells.map(cell =>
    Math.max(1, o.relief * smoothstep(0, maxHop, cell.hop) + (rng() - 0.5) * 2 * 0.15 * o.hilliness * o.relief));
  const surfaceAt = (p: Point2) => (o.course && o.profile ? riverSurfaceAt(o.course, o.profile, p) : 0);

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
    if (c.flatType[i] === 'coastal') return 2 + cell.hop;
    if (c.flatType[i] === 'river') {
      // At least half a metre above the river surface at every corner of the cell: the
      // surface falls along the river, so the seed's level alone left the upstream end of a
      // long cell below the water.
      const highest = Math.max(...cell.poly[0].map(surfaceAt));
      return Math.max(surfaceAt(cell.seed) + 1.5 + cell.hop, highest + 0.5);
    }
    return shelfLevel.get(groupOf[i])!;
  });

  // Ponds: half a metre below the lowest bordering cell's level.
  const levelOf = (i: number) => flatLevel[i] ?? base[i];
  const pondSurface = cells.map((cell, i) => {
    if (c.kind[i] !== 'pond') return null;
    const around = cell.neighbours.filter(n => c.kind[n] !== 'pond').map(levelOf);
    return Math.max(1, (around.length ? Math.min(...around) : base[i]) - 0.5);
  });

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
  const vertex = new Map<string, number>();
  for (const [k, { p, cells: inc }] of incident) {
    const flats = inc.map(i => flatLevel[i]).filter((v): v is number => v !== null);
    const ponds = inc.map(i => pondSurface[i]).filter((v): v is number => v !== null);
    let e: number;
    if (flats.length || ponds.length) {
      // The lowest touching level, but never below any touching pond's bank.
      e = Math.min(...flats, ...ponds.map(s => s + 0.5));
      if (ponds.length) e = Math.max(e, Math.max(...ponds) + 0.5);
    } else {
      e = inc.reduce((s, i) => s + base[i], 0) / inc.length;
    }
    // Only vertices of water-touching cells can lie in a bank band.
    const onBank = !!bank && inc.some(i => cells[i].touchesRiver) && containsPoint(bank, p);
    const onShore = !!shore && inc.some(i => cells[i].touchesSea) && containsPoint(shore, p);
    if (onBank || onShore) e = Math.max(onBank ? surfaceAt(p) + 0.5 : -Infinity, onShore ? 0.5 : -Infinity);
    vertex.set(k, e);
  }

  const centre = cells.map((_, i) => {
    if (pondSurface[i] !== null) return pondSurface[i]! - 2;
    if (flatLevel[i] !== null) return flatLevel[i]!;
    return base[i] + (c.kind[i] === 'hills' ? 0.1 * o.hilliness * o.relief : 0);
  });

  return { vertex, centre, flatLevel, pondSurface };
}

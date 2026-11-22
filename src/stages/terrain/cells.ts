// Land cells: a Voronoi division of the land left after water carves the site. Cells are
// the units the rule table classifies; same-kind neighbours later merge into regions.

import { Delaunay } from 'd3-delaunay';
import { createNoise2D } from 'simplex-noise';
import type { MultiPolygon, Point2, Polygon } from '../../doc/types.js';
import { intersect, offsetPolygons, union } from '../../grammar/clipper.js';
import { area, bounds, containsPoint } from '../../grammar/polygon.js';

export interface Cell {
  id: number;
  seed: Point2;
  /** clipped to land; outer ring CCW */
  poly: Polygon;
  area: number;
  /** cells sharing an edge longer than about 1 m */
  neighbours: number[];
  /** shared edge length (m) with each neighbour, aligned with `neighbours` */
  edge: number[];
  /** every cell it touches at all, even at a single corner */
  adjacent: number[];
  touchesSea: boolean;
  touchesRiver: boolean;
  /** any contact with the sea / river, even at a corner (the strict pond rule) */
  nearSea: boolean;
  nearRiver: boolean;
  /** touches the outer edge of the site */
  touchesEdge: boolean;
  /** graph distance from water (0 = touches it); from the site edge on a dry site */
  hop: number;
  nearest: 'sea' | 'river' | 'none';
  /** graph distance from the river specifically (Infinity with no river) */
  riverHop: number;
}

/** Vertex identity: coordinate rounded to 1 cm. Shared cell corners must agree through this. */
export const vkey = (p: Point2) => `${Math.round(p[0] * 100)},${Math.round(p[1] * 100)}`;

function centroid(ring: Point2[]): Point2 {
  let a = 0, x = 0, z = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; x += (ring[j][0] + ring[i][0]) * f; z += (ring[j][1] + ring[i][1]) * f;
  }
  if (a === 0) return ring[0];
  return [x / (3 * a), z / (3 * a)];
}

/** A point inside the polygon: its centroid if inside, else the midpoint of a vertex-to-centroid chord. */
function interiorPoint(poly: Polygon): Point2 {
  const c = centroid(poly[0]);
  if (containsPoint([poly], c)) return c;
  for (const v of poly[0]) {
    const m: Point2 = [(v[0] + c[0]) / 2, (v[1] + c[1]) / 2];
    if (containsPoint([poly], m)) return m;
  }
  return poly[0][0];
}

/** Length of shared boundary between two polygons, approximated by growing one by 0.5 m. */
function shared(a: MultiPolygon, b: MultiPolygon): number {
  return area(intersect(offsetPolygons(a, 0.5), b)) / 0.5;
}

const touches = (poly: Polygon, water: MultiPolygon | null) =>
  !!water && water.length > 0 && area(intersect(offsetPolygons([poly], 1), water)) > 0.5;
const nearAtAll = (poly: Polygon, water: MultiPolygon | null) =>
  !!water && water.length > 0 && area(intersect(offsetPolygons([poly], 1), water)) > 1e-6;

/** Split a (convex-ish) ring by a straight line through `centre` at `angle`. Returns both
 *  pieces and the two new points with the edge each lies on, or null if the line doesn't
 *  cross exactly twice, lands within SNAP of a corner, or leaves a piece under 1 m². */
function cutRing(ring: Point2[], centre: Point2, angle: number, snap: number):
  { a: Point2[]; b: Point2[]; tees: { t: Point2; from: Point2; to: Point2 }[] } | null {
  const dx = Math.cos(angle), dz = Math.sin(angle);
  const side = ring.map(p => dx * (p[1] - centre[1]) - dz * (p[0] - centre[0]));
  if (side.some(v => v === 0)) return null;
  const cross: number[] = [];
  for (let i = 0; i < ring.length; i++) if ((side[i] > 0) !== (side[(i + 1) % ring.length] > 0)) cross.push(i);
  if (cross.length !== 2) return null;
  const at = (i: number): Point2 => {
    const p = ring[i], q = ring[(i + 1) % ring.length], t = side[i] / (side[i] - side[(i + 1) % ring.length]);
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  const [i, j] = cross;
  const t1 = at(i), t2 = at(j);
  const tooClose = (t: Point2, k: number) => [ring[k], ring[(k + 1) % ring.length]].some(c => Math.hypot(c[0] - t[0], c[1] - t[1]) < snap);
  if (tooClose(t1, i) || tooClose(t2, j)) return null;
  const a: Point2[] = [t1], b: Point2[] = [t2];
  for (let k = i + 1; k <= j; k++) a.push(ring[k]);
  a.push(t2);
  for (let k = j + 1; k <= i + ring.length; k++) b.push(ring[k % ring.length]);
  b.push(t1);
  if (area([[a]]) < 1 || area([[b]]) < 1) return null;
  return { a, b, tees: [{ t: t1, from: ring[i], to: ring[(i + 1) % ring.length] }, { t: t2, from: ring[j], to: ring[(j + 1) % ring.length] }] };
}

export function buildCells(
  land: MultiPolygon, site: MultiPolygon, sea: MultiPolygon | null, river: MultiPolygon | null,
  cellSize: number, rng: () => number, irregularity = 0.5,
): Cell[] {
  const b = bounds(site);
  const box: [number, number, number, number] = [b.minX, b.minZ, b.maxX, b.maxZ];

  // Random seeds with density varied by low-frequency noise: some areas get many small
  // cells, others a few large ones. No relaxation (it made near-regular, grid-like cells).
  const noise = createNoise2D(rng);
  const span = Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
  const target = Math.max(4, Math.round(((b.maxX - b.minX) * (b.maxZ - b.minZ)) / (cellSize * cellSize)));
  const seeds: Point2[] = [];
  for (let tries = 0; seeds.length < target && tries < target * 40; tries++) {
    const p: Point2 = [b.minX + rng() * (b.maxX - b.minX), b.minZ + rng() * (b.maxZ - b.minZ)];
    const u = (noise(p[0] / (span * 0.35), p[1] / (span * 0.35)) + 1) / 2;
    if (rng() < 0.1 + 0.9 * u * u) seeds.push(p);
  }
  const v = Delaunay.from(seeds).voronoi(box);

  // Collapse Voronoi corners closer than SNAP into one point. Voronoi diagrams often have
  // very short edges; their two corners border different cells, get different heights, and
  // render as near-vertical slivers. Snapping before clipping keeps the cells a partition,
  // since every cell sees the same snapped corners.
  const SNAP = 3;
  const reps: Point2[] = [];
  const repGrid = new Map<string, number[]>();
  // Which box edges a point lies on (bit flags); corners are on two.
  const edgesOf = (p: Point2) => (Math.abs(p[0] - b.minX) < 1e-6 ? 1 : 0) | (Math.abs(p[0] - b.maxX) < 1e-6 ? 2 : 0)
    | (Math.abs(p[1] - b.minZ) < 1e-6 ? 4 : 0) | (Math.abs(p[1] - b.maxZ) < 1e-6 ? 8 : 0);
  // Memoised per original corner, so every cell sharing it gets the same result (searching
  // reps per visit could land two cells on different nearby reps).
  const snapped = new Map<string, Point2>();
  const addRep = (p: Point2) => {
    reps.push(p);
    const k = `${Math.floor(p[0] / SNAP)},${Math.floor(p[1] / SNAP)}`;
    repGrid.set(k, [...(repGrid.get(k) ?? []), reps.length - 1]);
  };
  const nearRep = (p: Point2) => {
    const gx = Math.floor(p[0] / SNAP), gz = Math.floor(p[1] / SNAP);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const r of repGrid.get(`${gx + dx},${gz + dz}`) ?? []) if (Math.hypot(reps[r][0] - p[0], reps[r][1] - p[1]) < SNAP) return true;
    }
    return false;
  };
  // The site's corners are fixed reps from the start, so nearby boundary points snap onto
  // them whatever order cells are visited in.
  for (const c of [[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ]] as Point2[]) {
    addRep(c);
    snapped.set(vkey(c), c);
  }
  const snapPoint = (p: Point2): Point2 => {
    const key = vkey(p);
    const hit = snapped.get(key);
    if (hit) return hit;
    const pe = edgesOf(p);
    let result: Point2 | null = null;
    if (pe !== 5 && pe !== 6 && pe !== 9 && pe !== 10) { // box corners never move
      const gx = Math.floor(p[0] / SNAP), gz = Math.floor(p[1] / SNAP);
      search: for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const r of repGrid.get(`${gx + dx},${gz + dz}`) ?? []) {
          if (Math.hypot(reps[r][0] - p[0], reps[r][1] - p[1]) >= SNAP) continue;
          // A boundary corner only snaps along its own boundary edge, never inward: pulling it
          // in would open a gap along the site edge.
          if (pe && (edgesOf(reps[r]) & pe) !== pe) continue;
          result = reps[r];
          break search;
        }
      }
    }
    if (!result) {
      addRep(p);
      result = p;
    }
    snapped.set(key, result);
    return result;
  };
  const snappedRing = (i: number): Point2[] | null => {
    const ring = v.cellPolygon(i);
    if (!ring) return null;
    const out: Point2[] = [];
    for (const p of ring.slice(0, -1) as Point2[]) {
      const q = snapPoint(p);
      if (!out.length || out[out.length - 1] !== q) out.push(q);
    }
    if (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out.length >= 3 ? out : null;
  };

  // Cuts: split a share of cells by random straight lines (sometimes twice), giving wedges,
  // triangles and slivers. Each cut point is inserted into the neighbouring outline too, so
  // shared edges keep matching vertices (no T-junctions).
  type RawCell = { ring: Point2[]; origin: number; seed: Point2 };
  const raw: RawCell[] = [];
  seeds.forEach((sd, i) => { const ring = snappedRing(i); if (ring) raw.push({ ring, origin: i, seed: sd }); });
  const insertTee = (except: RawCell[], t: Point2, from: Point2, to: Point2) => {
    for (const rc of raw) {
      if (except.includes(rc)) continue;
      for (let k = 0; k < rc.ring.length; k++) {
        if (rc.ring[k] === to && rc.ring[(k + 1) % rc.ring.length] === from) { rc.ring.splice(k + 1, 0, t); return; }
      }
    }
  };
  const tryCut = (rc: RawCell): RawCell[] | null => {
    const c = centroid(rc.ring);
    const r = Math.sqrt(area([[rc.ring]])) * 0.25;
    const centre: Point2 = [c[0] + (rng() - 0.5) * r, c[1] + (rng() - 0.5) * r];
    const res = cutRing(rc.ring, centre, rng() * Math.PI, SNAP);
    // A cut point within SNAP of any existing corner would make a micro-edge (and a
    // micro-cliff once heights differ): skip the cut. Accepted cut points become reps.
    if (!res || res.tees.some(t => nearRep(t.t))) return null;
    for (const t of res.tees) addRep(t.t);
    const pieces2 = [{ ring: res.a, origin: rc.origin, seed: interiorPoint([res.a]) }, { ring: res.b, origin: rc.origin, seed: interiorPoint([res.b]) }];
    const idx = raw.indexOf(rc);
    raw.splice(idx, 1, ...pieces2);
    for (const tee of res.tees) insertTee(pieces2, tee.t, tee.from, tee.to);
    return pieces2;
  };
  for (const rc of [...raw]) {
    if (rng() >= 0.6 * irregularity) continue;
    const first = tryCut(rc);
    if (!first) continue;
    for (const piece of first) if (rng() < 0.4 * irregularity) tryCut(piece);
  }

  // Clip each cell to the land; every resulting piece is its own cell.
  type Piece = { seed: Point2; poly: Polygon; area: number; origin: number };
  let pieces: Piece[] = [];
  for (const rc of raw) {
    const clipped = intersect([[rc.ring]], land);
    for (const poly of clipped) {
      const a = area([poly]);
      if (a <= 0) continue;
      pieces.push({ seed: containsPoint([poly], rc.seed) ? rc.seed : interiorPoint(poly), poly, area: a, origin: rc.origin });
    }
  }

  // Slivers under 1 m² join the neighbour they share the most edge with (dropped if isolated).
  const bboxes = () => pieces.map(p => bounds([p.poly]));
  const near = (bb: ReturnType<typeof bounds>[], i: number, j: number) =>
    bb[i].minX <= bb[j].maxX + 2 && bb[j].minX <= bb[i].maxX + 2 && bb[i].minZ <= bb[j].maxZ + 2 && bb[j].minZ <= bb[i].maxZ + 2;
  for (;;) {
    const idx = pieces.findIndex(p => p.area < 1);
    if (idx < 0) break;
    const bb = bboxes();
    let best = -1, bestLen = 0;
    pieces.forEach((p, j) => {
      if (j === idx || !near(bb, idx, j)) return;
      const len = shared([pieces[idx].poly], [p.poly]);
      if (len > bestLen) { bestLen = len; best = j; }
    });
    if (best >= 0) {
      const merged = union([pieces[best].poly], [pieces[idx].poly]);
      // A hair-width gap can leave two polygons; keep the larger as the cell shape.
      const poly = merged.reduce((x, y) => (area([y]) > area([x]) ? y : x));
      pieces[best] = { ...pieces[best], poly, area: area([poly]) };
    }
    pieces = pieces.filter((_, j) => j !== idx);
  }

  // Neighbour graph by shared edge length. Only pieces of the same seed or of Delaunay-adjacent
  // seeds can touch, so only those pairs are measured (the all-pairs check dominated the stage).
  const bb = bboxes();
  const neighbours: number[][] = pieces.map(() => []);
  const edges: number[][] = pieces.map(() => []);
  const adjacent: number[][] = pieces.map(() => []);
  const bySeed = new Map<number, number[]>();
  pieces.forEach((p, i) => bySeed.set(p.origin, [...(bySeed.get(p.origin) ?? []), i]));
  const delaunay = v.delaunay;
  const seen = new Set<string>();
  pieces.forEach((p, i) => {
    const seedsNear = [p.origin, ...delaunay.neighbors(p.origin)];
    for (const sn of seedsNear) for (const j of bySeed.get(sn) ?? []) {
      if (j <= i) continue;
      const key = `${i},${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!near(bb, i, j)) continue;
      const len = shared([pieces[i].poly], [pieces[j].poly]);
      if (len > 0.02) { adjacent[i].push(j); adjacent[j].push(i); }
      if (len > 1) { neighbours[i].push(j); neighbours[j].push(i); edges[i].push(len); edges[j].push(len); }
    }
  });
  const waterBox = (w: MultiPolygon | null) => (w && w.length ? bounds(w) : null);
  const seaBox = waterBox(sea), riverBox = waterBox(river);
  const boxNear = (b1: ReturnType<typeof bounds>, b2: ReturnType<typeof bounds> | null) =>
    !!b2 && b1.minX <= b2.maxX + 2 && b2.minX <= b1.maxX + 2 && b1.minZ <= b2.maxZ + 2 && b2.minZ <= b1.maxZ + 2;

  const inner = offsetPolygons(site, -1);
  const cells: Cell[] = pieces.map((p, id) => ({
    id, seed: p.seed, poly: p.poly, area: p.area, neighbours: neighbours[id], edge: edges[id], adjacent: adjacent[id],
    touchesSea: boxNear(bb[id], seaBox) && touches(p.poly, sea),
    touchesRiver: boxNear(bb[id], riverBox) && touches(p.poly, river),
    nearSea: boxNear(bb[id], seaBox) && nearAtAll(p.poly, sea),
    nearRiver: boxNear(bb[id], riverBox) && nearAtAll(p.poly, river),
    touchesEdge: area(intersect([p.poly], inner)) < p.area - 1e-6,
    hop: Infinity, nearest: 'none', riverHop: Infinity,
  }));

  // Hop distance from the river alone (land beside it rises from it).
  let rf = cells.filter(c => c.touchesRiver);
  for (const c of rf) c.riverHop = 0;
  while (rf.length) {
    const next: Cell[] = [];
    for (const c of rf) for (const n of c.neighbours) if (cells[n].riverHop > c.riverHop + 1) { cells[n].riverHop = c.riverHop + 1; next.push(cells[n]); }
    rf = next;
  }

  // Hop distance (BFS) from water-touching cells; nearest water travels with it (sea wins ties).
  let frontier = cells.filter(c => c.touchesSea || c.touchesRiver);
  if (frontier.length) {
    for (const c of frontier) { c.hop = 0; c.nearest = c.touchesSea ? 'sea' : 'river'; }
  } else {
    // Dry site: distance from the site edge instead.
    frontier = cells.filter(c => c.touchesEdge);
    for (const c of frontier) c.hop = 0;
  }
  while (frontier.length) {
    const next: Cell[] = [];
    for (const c of frontier) {
      for (const n of c.neighbours) {
        const o = cells[n];
        if (o.hop > c.hop + 1) { o.hop = c.hop + 1; o.nearest = c.nearest; next.push(o); }
        else if (o.hop === c.hop + 1 && c.nearest === 'sea' && o.nearest === 'river') o.nearest = 'sea';
      }
    }
    frontier = next;
  }
  for (const c of cells) if (!Number.isFinite(c.hop)) c.hop = 0; // disconnected scraps

  return cells;
}

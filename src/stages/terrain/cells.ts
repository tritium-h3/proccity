// Land cells: a Voronoi division of the land left after water carves the site. Cells are
// the units the rule table classifies; same-kind neighbours later merge into regions.

import { Delaunay } from 'd3-delaunay';
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
  touchesSea: boolean;
  touchesRiver: boolean;
  /** graph distance from water (0 = touches it); from the site edge on a dry site */
  hop: number;
  nearest: 'sea' | 'river' | 'none';
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

export function buildCells(
  land: MultiPolygon, site: MultiPolygon, sea: MultiPolygon | null, river: MultiPolygon | null,
  cellSize: number, rng: () => number,
): Cell[] {
  const b = bounds(site);
  const box: [number, number, number, number] = [b.minX, b.minZ, b.maxX, b.maxZ];

  // Jittered grid seeds, relaxed once (Lloyd) for even cells.
  let seeds: Point2[] = [];
  for (let z = b.minZ + cellSize / 2; z < b.maxZ; z += cellSize) {
    for (let x = b.minX + cellSize / 2; x < b.maxX; x += cellSize) {
      seeds.push([x + (rng() - 0.5) * 0.7 * cellSize, z + (rng() - 0.5) * 0.7 * cellSize]);
    }
  }
  const voronoi = (pts: Point2[]) => Delaunay.from(pts).voronoi(box);
  const v0 = voronoi(seeds);
  seeds = seeds.map((s, i) => {
    const ring = v0.cellPolygon(i);
    return ring ? centroid(ring.slice(0, -1) as Point2[]) : s;
  });
  const v = voronoi(seeds);

  // Clip each Voronoi cell to the land; every resulting piece is its own cell.
  type Piece = { seed: Point2; poly: Polygon; area: number };
  let pieces: Piece[] = [];
  seeds.forEach((s, i) => {
    const ring = v.cellPolygon(i);
    if (!ring) return;
    const clipped = intersect([[ring.slice(0, -1) as Point2[]]], land);
    for (const poly of clipped) {
      const a = area([poly]);
      if (a <= 0) continue;
      pieces.push({ seed: containsPoint([poly], s) ? s : interiorPoint(poly), poly, area: a });
    }
  });

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

  // Neighbour graph by shared edge length.
  const bb = bboxes();
  const neighbours: number[][] = pieces.map(() => []);
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      if (!near(bb, i, j)) continue;
      if (shared([pieces[i].poly], [pieces[j].poly]) > 1) { neighbours[i].push(j); neighbours[j].push(i); }
    }
  }

  const cells: Cell[] = pieces.map((p, id) => ({
    id, seed: p.seed, poly: p.poly, area: p.area, neighbours: neighbours[id],
    touchesSea: touches(p.poly, sea), touchesRiver: touches(p.poly, river),
    hop: Infinity, nearest: 'none',
  }));

  // Hop distance (BFS) from water-touching cells; nearest water travels with it (sea wins ties).
  let frontier = cells.filter(c => c.touchesSea || c.touchesRiver);
  if (frontier.length) {
    for (const c of frontier) { c.hop = 0; c.nearest = c.touchesSea ? 'sea' : 'river'; }
  } else {
    // Dry site: distance from the site edge instead.
    const edge = offsetPolygons(site, -1);
    frontier = cells.filter(c => area(intersect([c.poly], edge)) < c.area - 0.5);
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

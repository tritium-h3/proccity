// Cuts a terrain region into k districts of similar size. Seeds are spread by farthest-point
// sampling, then relaxed (Lloyd) so the pieces even out, then their Voronoi cells are clipped
// to the region. A cell clipped by a concave region can fall into several parts; the stray
// parts join the neighbouring piece they share the most boundary with, so every district is
// one polygon.

import { Delaunay } from 'd3-delaunay';
import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { intersect, offsetPolygons, union } from '../../grammar/clipper.js';
import { area, bounds, centroid, containsPoint } from '../../grammar/polygon.js';

const LLOYD = 2;
const CANDIDATES = 200;

function voronoiPieces(fp: MultiPolygon, seeds: Point2[]): MultiPolygon[] {
  const b = bounds(fp);
  const v = Delaunay.from(seeds).voronoi([b.minX - 1, b.minZ - 1, b.maxX + 1, b.maxZ + 1]);
  return seeds.map((_, i) => {
    const cell = v.cellPolygon(i);
    if (!cell) return [];
    const ring = cell.slice(0, -1).map(([x, z]) => [x, z] as Point2);
    return intersect(fp, [[ring]]);
  });
}

export function cutRegion(fp: MultiPolygon, k: number, rng: () => number): MultiPolygon[] {
  if (k <= 1) return [fp];
  const b = bounds(fp);
  const candidates: Point2[] = [];
  for (let tries = 0; candidates.length < CANDIDATES && tries < CANDIDATES * 50; tries++) {
    const p: Point2 = [b.minX + rng() * (b.maxX - b.minX), b.minZ + rng() * (b.maxZ - b.minZ)];
    if (containsPoint(fp, p)) candidates.push(p);
  }
  if (candidates.length < k) return [fp];

  // Farthest-point sampling.
  let seeds: Point2[] = [candidates[Math.floor(rng() * candidates.length)]];
  const dist = candidates.map(p => Math.hypot(p[0] - seeds[0][0], p[1] - seeds[0][1]));
  while (seeds.length < k) {
    let best = 0;
    for (let i = 1; i < candidates.length; i++) if (dist[i] > dist[best]) best = i;
    const s = candidates[best];
    seeds.push(s);
    candidates.forEach((p, i) => { dist[i] = Math.min(dist[i], Math.hypot(p[0] - s[0], p[1] - s[1])); });
  }

  for (let it = 0; it < LLOYD; it++) {
    seeds = voronoiPieces(fp, seeds).map((piece, i) => (area(piece) > 0 ? centroid(piece) : seeds[i]));
  }

  const pieces = voronoiPieces(fp, seeds).filter(p => area(p) > 0);
  // Stray parts join the touching piece they overlap most (by a thin buffer).
  for (let round = 0; round < 4; round++) {
    let moved = false;
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].length <= 1) continue;
      const parts = [...pieces[i]].sort((x, y) => area([y]) - area([x]));
      pieces[i] = [parts[0]];
      for (const part of parts.slice(1)) {
        const grown = offsetPolygons([part], 0.5);
        let best = -1, bestOverlap = 0;
        pieces.forEach((q, j) => {
          if (j === i) return;
          const o = area(intersect(grown, q));
          if (o > bestOverlap) { bestOverlap = o; best = j; }
        });
        if (best < 0) { pieces[i] = union(pieces[i], [part]); continue; }
        pieces[best] = union(pieces[best], [part]);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pieces;
}

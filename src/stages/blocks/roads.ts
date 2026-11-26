// Which road, if any, a point on a piece's outline lies against. Pieces are cut out by road bands,
// so an outline point beside a road sits half that road's width from its centreline. A spatial
// hash of centreline segments keeps the lookup local (thousands of streets per city).

import type { Point2 } from '../../doc/types.js';
import type { Category } from './rules.js';

export interface RoadLine { points: Point2[]; category: Category; /** half the road's width */ half: number }

const TOL = 1.5; // m: Clipper's offsets and rounding put outlines within millimetres; slack for arcs

export class RoadIndex {
  private cells = new Map<string, { a: Point2; b: Point2; road: RoadLine }[]>();
  constructor(private cell = 50) {}

  add(road: RoadLine): void {
    const r = road.half + TOL;
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i], b = road.points[i + 1];
      const x0 = Math.floor((Math.min(a[0], b[0]) - r) / this.cell), x1 = Math.floor((Math.max(a[0], b[0]) + r) / this.cell);
      const z0 = Math.floor((Math.min(a[1], b[1]) - r) / this.cell), z1 = Math.floor((Math.max(a[1], b[1]) + r) / this.cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = `${x},${z}`;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push({ a, b, road });
      }
    }
  }

  /** The road whose edge passes through p (within a metre and a half), nearest edge first. */
  at(p: Point2): RoadLine | null {
    const list = this.cells.get(`${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)}`);
    if (!list) return null;
    let best: RoadLine | null = null, bestGap = TOL;
    for (const { a, b, road } of list) {
      const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
      const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)) : 0;
      const gap = Math.abs(Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]) - road.half);
      if (gap <= bestGap) { bestGap = gap; best = road; }
    }
    return best;
  }

  /** Is p inside some road's band (not just on its edge)? */
  inside(p: Point2): boolean {
    const list = this.cells.get(`${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)}`);
    return !!list?.some(({ a, b, road }) => {
      const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
      const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)) : 0;
      return Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]) < road.half - TOL;
    });
  }
}

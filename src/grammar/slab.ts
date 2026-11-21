import type { MultiPolygon, Point2, Slab } from '../doc/types.js';
import { area, containsPoint } from './polygon.js';

export function makeSlab(footprint: MultiPolygon, low = 0, high: number | null = null): Slab {
  return { type: 'slab', footprint, height: { ref: 'ground', low, high } };
}

/** Is the point (ground x,z plus height above ground) inside the slab? */
export function slabContains(s: Slab, p: Point2, h = 0): boolean {
  const { low, high } = s.height;
  return h >= low && (high === null || h <= high) && containsPoint(s.footprint, p);
}

export function isEmpty(s: Slab): boolean {
  return area(s.footprint) < 1e-9;
}

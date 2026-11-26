// A cut traced along the direction field: a streamline both ways from a seed until it leaves the
// piece, so a road can bend with the ground.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { containsPoint } from '../../grammar/polygon.js';
import { lineDiff, type Field } from './field.js';

const MAX_TURN = (3 / 2) * Math.PI; // a streamline curling further than this is circling a hilltop

export function traceCut(piece: MultiPolygon, field: Field, seed: Point2, planned: number, step: number, maxLen: number): Point2[] | null {
  if (!containsPoint(piece, seed)) return null;
  const half = (sign: 1 | -1): Point2[] | null => {
    const out: Point2[] = [];
    let p = seed, heading = planned + (sign < 0 ? Math.PI : 0), turned = 0, len = 0;
    const dirAt = (q: Point2, prev: number) => {
      const a = field(q, planned);
      // Of the line's two directions, the one closer to the way we're going.
      return prev + lineDiff(a, prev);
    };
    for (;;) {
      const h1 = dirAt(p, heading);
      const mid: Point2 = [p[0] + Math.cos(h1) * step / 2, p[1] + Math.sin(h1) * step / 2];
      const h2 = dirAt(mid, h1);
      const q: Point2 = [p[0] + Math.cos(h2) * step, p[1] + Math.sin(h2) * step];
      turned += Math.abs(h2 - heading);
      heading = h2;
      len += step;
      if (turned > MAX_TURN || len > maxLen) return null;
      if (!containsPoint(piece, q)) {
        // Bisect to the outline.
        let lo = p, hi = q;
        for (let k = 0; k < 20; k++) {
          const m: Point2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
          if (containsPoint(piece, m)) lo = m; else hi = m;
        }
        out.push(hi);
        return out;
      }
      out.push(q);
      p = q;
    }
  };
  const a = half(-1), b = half(1);
  if (!a || !b) return null;
  return [...a.reverse(), seed, ...b];
}

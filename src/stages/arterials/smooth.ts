// Road centrelines from routes: grid jitter removed, then every corner rounded with a true
// circular arc of the curve radius. Corner-cutting schemes (Chaikin) can't promise a radius;
// a fillet can, except where the road's segments are too short to fit it, and then the arc
// shrinks and the bend shows up in tightBends.

import type { Point2 } from '../../doc/types.js';
import { simplifyLine } from '../../grammar/polygon.js';

// m: grid paths step every 20–45 m, too short to fit a curve radius between corners; dropping
// vertices within this of the line leaves segments long enough for the arcs.
const SIMPLIFY = 12;
const ARC_PER_RADIUS = 6; // arc points per radius of arc length (10 m at a 60 m radius)

export function smoothRoad(line: Point2[], radius: number, simplify = SIMPLIFY): Point2[] {
  const p = simplifyLine(line, simplify);
  if (p.length < 3) return p;
  const out: Point2[] = [p[0]];
  // How far along each segment the previous corner's arc already reaches.
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1]), l2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const u: Point2 = [(b[0] - a[0]) / l1, (b[1] - a[1]) / l1], v: Point2 = [(c[0] - b[0]) / l2, (c[1] - b[1]) / l2];
    const turn = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
    if (turn < 1e-3) { out.push(b); continue; }
    // Tangent length for the radius, capped at half of each adjacent segment.
    const t = Math.min(radius * Math.tan(turn / 2), l1 / 2, l2 / 2);
    const r = t / Math.tan(turn / 2);
    const start: Point2 = [b[0] - u[0] * t, b[1] - u[1] * t];
    const side = Math.sign(u[0] * v[1] - u[1] * v[0]);
    const centre: Point2 = [start[0] - u[1] * r * side, start[1] + u[0] * r * side];
    const a0 = Math.atan2(start[1] - centre[1], start[0] - centre[0]);
    const steps = Math.max(2, Math.ceil((turn * ARC_PER_RADIUS)));
    for (let k = 0; k <= steps; k++) {
      const ang = a0 + side * turn * (k / steps);
      out.push([centre[0] + r * Math.cos(ang), centre[1] + r * Math.sin(ang)]);
    }
  }
  out.push(p[p.length - 1]);
  return out;
}

/** Interior vertices whose bend (circumradius through their neighbours) is tighter than radius. */
export function tightBends(line: Point2[], radius: number): number {
  let n = 0;
  for (let i = 1; i + 1 < line.length; i++) {
    const [a, b, c] = [line[i - 1], line[i], line[i + 1]];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]), ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
    if (cross < 1e-9) continue;
    if ((ab * bc * ca) / (2 * cross) < 0.9 * radius) n++;
  }
  return n;
}

// Gateways: where an arterial crosses a district border. A gateway sits on the border the two
// districts share, clear of its ends (a road at a corner squeezes a sliver), on a straight
// stretch (so the road crosses square-on), and at least the spacing from the district's other
// gateways where that's possible.

import type { MultiPolygon, Point2 } from '../../doc/types.js';

type Seg = [Point2, Point2];
const segsOf = (mp: MultiPolygon): Seg[] => mp.flatMap(poly => poly.flatMap(ring => ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as Seg)));

/** The polylines of boundary two footprints share (within `tol` metres), longest first. */
export function sharedBorder(a: MultiPolygon, b: MultiPolygon, tol: number): Point2[][] {
  const bs = segsOf(b);
  const pieces: Seg[] = [];
  for (const [p, q] of segsOf(a)) {
    const dx = q[0] - p[0], dz = q[1] - p[1], L = Math.hypot(dx, dz);
    if (L < 1e-9) continue;
    const ux = dx / L, uz = dz / L;
    // Intervals of this segment (in metres along it) that some segment of b lies along.
    const spans: [number, number][] = [];
    for (const [r, s] of bs) {
      const off = (pt: Point2) => Math.abs((pt[0] - p[0]) * uz - (pt[1] - p[1]) * ux);
      if (off(r) > tol || off(s) > tol) continue;
      const tr = (r[0] - p[0]) * ux + (r[1] - p[1]) * uz, ts = (s[0] - p[0]) * ux + (s[1] - p[1]) * uz;
      const lo = Math.max(0, Math.min(tr, ts)), hi = Math.min(L, Math.max(tr, ts));
      if (hi - lo > tol) spans.push([lo, hi]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    let cur: [number, number] | null = null;
    const flush = () => { if (cur) pieces.push([[p[0] + ux * cur[0], p[1] + uz * cur[0]], [p[0] + ux * cur[1], p[1] + uz * cur[1]]]); };
    for (const sp of spans) {
      if (cur && sp[0] <= cur[1] + tol) cur[1] = Math.max(cur[1], sp[1]);
      else { flush(); cur = [sp[0], sp[1]]; }
    }
    flush();
  }
  // Chain pieces that meet end to start.
  const near = (u: Point2, v: Point2) => Math.hypot(u[0] - v[0], u[1] - v[1]) <= tol;
  const lines: Point2[][] = [];
  const used = new Array<boolean>(pieces.length).fill(false);
  for (let i = 0; i < pieces.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const line: Point2[] = [pieces[i][0], pieces[i][1]];
    for (let grew = true; grew;) {
      grew = false;
      for (let j = 0; j < pieces.length; j++) {
        if (used[j]) continue;
        if (near(line[line.length - 1], pieces[j][0])) { line.push(pieces[j][1]); used[j] = true; grew = true; }
        else if (near(line[0], pieces[j][1])) { line.unshift(pieces[j][0]); used[j] = true; grew = true; }
      }
    }
    lines.push(line);
  }
  const len = (l: Point2[]) => l.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - l[i][0], q[1] - l[i][1]), 0);
  return lines.sort((x, y) => len(y) - len(x));
}

export interface PlaceOpts {
  /** metres to keep from both ends of the line */
  margin: number;
  /** lower is better (e.g. grade, distance from the line's middle) */
  score(p: Point2, normal: Point2): number;
  /** gateways already on either district */
  avoid: Point2[];
  /** the spacing: how far from every `avoid` point a gateway should be */
  minGap: number;
  /** metres to keep from a bend of more than 15° in the line (default 0) */
  straight?: number;
}
export interface Placed { at: Point2; normal: Point2; crowded: boolean }

/** The best gateway position on a border line, or null when it can't hold the margins. */
export function placeOnBorder(line: Point2[], o: PlaceOpts): Placed | null {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const L = cum[cum.length - 1];
  if (L < 2 * o.margin) return null;
  const bends: number[] = [];
  for (let i = 1; i + 1 < line.length; i++) {
    const h1 = Math.atan2(line[i][1] - line[i - 1][1], line[i][0] - line[i - 1][0]);
    const h2 = Math.atan2(line[i + 1][1] - line[i][1], line[i + 1][0] - line[i][0]);
    let d = Math.abs(h2 - h1); if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > (15 * Math.PI) / 180) bends.push(cum[i]);
  }
  const span = L - 2 * o.margin;
  const n = Math.max(1, Math.min(200, Math.ceil(span / Math.max(1, o.margin / 4))));
  let best: { tier: number; score: number; at: Point2; normal: Point2 } | null = null;
  for (let k = 0; k <= n; k++) {
    const s = o.margin + (span * k) / n;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const a = line[i - 1], b = line[i], seg = cum[i] - cum[i - 1];
    const t = seg > 0 ? (s - cum[i - 1]) / seg : 0;
    const at: Point2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const normal: Point2 = seg > 0 ? [-(b[1] - a[1]) / seg, (b[0] - a[0]) / seg] : [0, 1];
    const spaced = o.avoid.every(p => Math.hypot(p[0] - at[0], p[1] - at[1]) >= o.minGap);
    const straight = !o.straight || bends.every(c => Math.abs(c - s) >= o.straight!);
    const tier = (spaced ? 0 : 2) + (straight ? 0 : 1);
    const score = o.score(at, normal);
    if (!best || tier < best.tier || (tier === best.tier && score < best.score)) best = { tier, score, at, normal };
  }
  return best && { at: best.at, normal: best.normal, crowded: best.tier >= 2 };
}

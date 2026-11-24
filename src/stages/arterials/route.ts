// Least-cost routing over the grid, with heading in the state. Sixteen move directions (the
// eight neighbours plus knight moves); a step may turn by at most maxTurn sectors (two, about
// 45°, unless the stage asks for fewer), and
// turning costs. So a route can't zig-zag, and it bends gradually.

import type { Point2 } from '../../doc/types.js';
import { BLOCKED, centreOf, stepCost, type CostParams, type Grid } from './grid.js';

// Moves in angle order: heading k is MOVES[k].
const MOVES: [number, number][] = [
  [1, 0], [2, 1], [1, 1], [1, 2], [0, 1], [-1, 2], [-1, 1], [-2, 1],
  [-1, 0], [-2, -1], [-1, -1], [-1, -2], [0, -1], [1, -2], [1, -1], [2, -1],
];
const ANGLE = MOVES.map(([dx, dz]) => Math.atan2(dz, dx));
const H = MOVES.length;
const MAX_TURN = 2;

export interface RouteOpts {
  params: CostParams;
  /** extra cost per sector turned, as a share of the step's length */
  turnPenalty?: number;
  /** the heading (rad) the route must leave in, e.g. into the site from an exit */
  startHeading?: number;
  /** cells to go straight along startHeading before routing freely (exits leave square-on) */
  straightStart?: number;
  goal: { cell: number } | { touches: (cell: number) => boolean };
  /** for a `touches` goal: a point to aim at (guides the search; the goal still decides) */
  toward?: Point2;
  /** sectors a step may turn (default 2). The stage sets it from the curve radius: at 100 m
   *  cells two sectors a step let a route make a 90° V in one cell, which no curve could fit. */
  maxTurn?: number;
  /** give up once the cheapest open route costs more than this */
  maxCost?: number;
  /** for a `cell` goal: arrive heading this way (within maxTurn sectors), e.g. square into a
   *  gateway's stub; arriving any way made a sharp turn onto the stub */
  goalHeading?: number;
  /** cells a route may enter (e.g. one district and its edge); others are skipped */
  allow?(cell: number): boolean;
}

/** Binary min-heap of [priority, state]. */
class Heap {
  private p: number[] = [];
  private s: number[] = [];
  get size() { return this.p.length; }
  push(pr: number, st: number) {
    let i = this.p.length;
    this.p.push(pr); this.s.push(st);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (this.p[up] <= this.p[i]) break;
      [this.p[up], this.p[i]] = [this.p[i], this.p[up]];
      [this.s[up], this.s[i]] = [this.s[i], this.s[up]];
      i = up;
    }
  }
  pop(): number {
    const top = this.s[0];
    const lp = this.p.pop()!, ls = this.s.pop()!;
    if (this.p.length) {
      this.p[0] = lp; this.s[0] = ls;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.p.length && this.p[l] < this.p[m]) m = l;
        if (r < this.p.length && this.p[r] < this.p[m]) m = r;
        if (m === i) break;
        [this.p[m], this.p[i]] = [this.p[i], this.p[m]];
        [this.s[m], this.s[i]] = [this.s[i], this.s[m]];
        i = m;
      }
    }
    return top;
  }
}

const nearestHeading = (rad: number) => {
  let best = 0, bd = Infinity;
  ANGLE.forEach((a, k) => { let d = Math.abs(a - rad) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; if (d < bd) { bd = d; best = k; } });
  return best;
};

// Search buffers, reused between calls (a fresh 12 MB per route was a real cost at 5 km). A
// state's cost is valid only when its stamp matches the current search.
let buf: { n: number; cost: Float64Array; prev: Int32Array; stamp: Uint32Array; gen: number } | null = null;

export function route(g: Grid, start: Point2, opts: RouteOpts): Point2[] | null {
  if (opts.straightStart && opts.startHeading !== undefined) {
    // Walk the straight stub, then route on from its end.
    const k = nearestHeading(opts.startHeading);
    const [dx, dz] = MOVES[k];
    let c = Math.min(g.w - 1, Math.max(0, Math.floor((start[0] - g.minX) / g.cell))) + g.w * Math.min(g.h - 1, Math.max(0, Math.floor((start[1] - g.minZ) / g.cell)));
    const stub: Point2[] = [centreOf(g, c)];
    for (let i = 0; i < opts.straightStart; i++) {
      const ni = (c % g.w) + dx, nj = Math.floor(c / g.w) + dz;
      if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h || g.kind[nj * g.w + ni] === BLOCKED) break;
      c = nj * g.w + ni;
      stub.push(centreOf(g, c));
    }
    const rest = route(g, stub[stub.length - 1], { ...opts, straightStart: 0 });
    return rest ? [...stub.slice(0, -1), ...rest] : null;
  }
  const { params } = opts;
  const turn = opts.turnPenalty ?? 0.4;
  const n = g.w * g.h;
  if (!buf || buf.n !== n) buf = { n, cost: new Float64Array(n * H), prev: new Int32Array(n * H), stamp: new Uint32Array(n * H), gen: 0 };
  const b = buf;
  b.gen++;
  const costOf = (st: number) => (b.stamp[st] === b.gen ? b.cost[st] : Infinity);
  const set = (st: number, v: number, from: number) => { b.cost[st] = v; b.prev[st] = from; b.stamp[st] = b.gen; };
  const heap = new Heap();
  const s = (() => { const i = Math.min(g.w - 1, Math.max(0, Math.floor((start[0] - g.minX) / g.cell))), j = Math.min(g.h - 1, Math.max(0, Math.floor((start[1] - g.minZ) / g.cell))); return j * g.w + i; })();
  const goalCell = 'cell' in opts.goal ? opts.goal.cell : -1;
  const touches = 'touches' in opts.goal ? opts.goal.touches : null;
  const aim = goalCell >= 0 ? centreOf(g, goalCell) : opts.toward ?? null;
  const h = (c: number) => { if (!aim) return 0; const [x, z] = centreOf(g, c); return 0.5 * Math.hypot(aim[0] - x, aim[1] - z); };
  const heads = opts.startHeading !== undefined ? [nearestHeading(opts.startHeading)] : [...Array(H).keys()];
  for (const k of heads) { set(s * H + k, 0, -1); heap.push(h(s), s * H + k); }

  const maxTurn = opts.maxTurn ?? MAX_TURN, maxCost = opts.maxCost ?? Infinity;
  const goalK = opts.goalHeading === undefined ? -1 : nearestHeading(opts.goalHeading);
  const headingOk = (k: number) => goalK < 0 || Math.min((k - goalK + H) % H, (goalK - k + H) % H) <= maxTurn;
  let end = -1;
  while (heap.size) {
    const st = heap.pop();
    if (costOf(st) > maxCost) break;
    const c = Math.floor(st / H), k = st % H;
    if ((c === goalCell && headingOk(k)) || (touches && c !== s && touches(c))) { end = st; break; }
    const base = costOf(st);
    const ci = c % g.w, cj = Math.floor(c / g.w);
    for (let dk = -maxTurn; dk <= maxTurn; dk++) {
      const nk = (k + dk + H) % H;
      const [dx, dz] = MOVES[nk];
      const ni = ci + dx, nj = cj + dz;
      if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
      // Don't cut corners past blocked cells (diagonal and knight moves pass two cells).
      if (Math.abs(dx) + Math.abs(dz) > 1) {
        const sx = Math.sign(dx), sz = Math.sign(dz);
        const a = cj * g.w + (ci + sx), b = (cj + sz) * g.w + ci;
        if (g.kind[a] === BLOCKED || g.kind[b] === BLOCKED) continue;
      }
      const nc = nj * g.w + ni;
      if (opts.allow && !opts.allow(nc)) continue;
      const step = stepCost(g, c, nc, ANGLE[nk], params);
      if (!Number.isFinite(step)) continue;
      const len = Math.hypot(dx, dz) * g.cell;
      const nextCost = base + step + turn * len * Math.abs(dk);
      const ns = nc * H + nk;
      if (nextCost < costOf(ns)) { set(ns, nextCost, st); heap.push(nextCost + h(nc), ns); }
    }
  }
  if (end < 0) return null;

  // Walk back, keeping only cells where the heading changes (and the ends).
  const cells: number[] = [];
  const headings: number[] = [];
  for (let st = end; st >= 0; st = b.prev[st]) { cells.push(Math.floor(st / H)); headings.push(st % H); }
  cells.reverse(); headings.reverse();
  const out: Point2[] = [centreOf(g, cells[0])];
  for (let i = 1; i < cells.length - 1; i++) if (headings[i + 1] !== headings[i]) out.push(centreOf(g, cells[i]));
  if (cells.length > 1) out.push(centreOf(g, cells[cells.length - 1]));
  return out;
}

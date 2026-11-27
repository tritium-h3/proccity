// The recursion: a superblock is cut, largest piece first, by roads running from road to road
// across it, until every piece is a block. Each cut is typed when it's made (its width is cut out
// then). Pure; cuts are traced along `ctx.field` where there is one, straight otherwise.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { area, bounds, containsPoint, simplifyLine } from '../../grammar/polygon.js';
import { offsetPolygons, offsetPolyline, union } from '../../grammar/clipper.js';
import { chordsAlong, chordThrough, extend, outlineSamples, sideOf, obb, offsetPath, splitBand, walkToRoad, type Box } from './geometry.js';
import type { Field } from './field.js';
import type { HeightRaster } from './height.js';
import type { RoadIndex } from './roads.js';
import { junctionCost, snapEnds, type Junctions } from './junctions.js';
import { traceCut } from './trace.js';
import { spacing, type SpacingSettings } from '../subdistricts/rules.js';
import type { Family } from './rules.js';

export interface BlockSettings extends SpacingSettings {
  collectorWidth: number; localWidth: number;
  localGrade: number;
}

export interface Street {
  points: Point2[]; category: 'C' | 'L'; width: number;
  /** segments of one street carried on across roads share this (an id local to the division) */
  route?: string;
}


export interface DivideCtx {
  /** how cuts follow the terrain (plan direction or contours) */
  family: Family;
  /** the sub-district's density step: block size and collector spacing */
  step: number;
  s: BlockSettings;
  /** a block must hold one lot of its district's smallest zone */
  minBlockArea: number;
  minDepth: number;
  rng: () => number;
  roads: RoadIndex;
  /** junctions already on each road, shared by every context like `roads` */
  junctions: Junctions;
  /** is p on the superblock's outline against open land (water, Undeveloped land, the site edge)? */
  openAt: (p: Point2) => boolean;
  /** which way cuts should run (terrain-following); none = straight cuts */
  field?: Field;
  /** the ground, for the grade check; none = flat */
  height?: HeightRaster;
}

/** Why a cut's line won't do as a road, or null: a turn over 120° (also on the line simplified as
 *  laid, since a curl over a few steps reads as one hairpin), crossing itself, or a stretch
 *  steeper than `HARD_GRADE` × the Max grade. */
export function badLine(line: Point2[], ctx: DivideCtx): string | null {
  for (const l of [line, simplifyLine(line, KINK_TOL)]) if (sharpTurn(l)) return 'kink';
  if (crosses(simplifyLine(line, 0.5))) return 'crossing';
  if (gradeCost(line, ctx) === Infinity) return 'grade';
  return null;
}

/** The Max grade is a preference, not a rule (the owner, after Town cores on slopes stayed as
 *  single 100 ha blocks): a stretch over it costs its length × how far over, in Max grades, and
 *  only past `HARD_GRADE` × the Max grade is it refused. Measured on the smoothed ground the field
 *  steers by (the raw terrain is big flat facets with creases no road could follow smoothly). */
export function gradeCost(line: Point2[], ctx: DivideCtx): number {
  let cost = 0;
  if (ctx.height) {
    const g = ctx.s.localGrade / 100;
    let prev = line[0], prevH = ctx.height.smoothAt(...prev), run = 0;
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / GRADE_STEP));
      for (let k = 1; k <= n; k++) {
        const q: Point2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
        run += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
        prev = q;
        if (run < GRADE_STEP) continue;
        const h = ctx.height.smoothAt(...q);
        const grade = Math.abs(h - prevH) / run;
        if (grade > g * HARD_GRADE) return Infinity;
        if (grade > g) cost += run * ((grade - g) / g) * GRADE_COST;
        prevH = h; run = 0;
      }
    }
  }
  return cost;
}
const KINK_TOL = 6;
const GRADE_STEP = 20;
export const HARD_GRADE = 3;
// Metres of cost per metre of road one Max grade over it: a little steepness beats an open end.
const GRADE_COST = 2;

function sharpTurn(l: Point2[]): boolean {
  for (let i = 1; i + 1 < l.length; i++) {
    const ax = l[i][0] - l[i - 1][0], az = l[i][1] - l[i - 1][1], bx = l[i + 1][0] - l[i][0], bz = l[i + 1][1] - l[i][1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la > 1e-9 && lb > 1e-9 && (ax * bx + az * bz) / (la * lb) < -0.5) return true;
  }
  return false;
}

function crosses(l: Point2[]): boolean {
  const cross = (o: Point2, a: Point2, b: Point2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i + 1 < l.length; i++) for (let j = i + 2; j + 1 < l.length; j++) {
    const [p, q, r, s] = [l[i], l[i + 1], l[j], l[j + 1]];
    if (cross(p, q, r) * cross(p, q, s) < 0 && cross(r, s, p) * cross(r, s, q) < 0) return true;
  }
  return false;
}

/** The step's block size: depth (short side) and length (long side), and collector spacing. */
export const targets = (ctx: DivideCtx) => spacing(ctx.step, ctx.s);

// A piece is cut while its side exceeds this multiple of the target; below it, it's a block.
const SLACK = 1.4;
const OFFSETS = [0, 0.1, -0.1, 0.2, -0.2];
// The longest run along a roadless edge, in block lengths.
const EDGE_RUN = 2;
// An end on open land, in metres of edge run: a road-to-road cut nearby is preferred.
const OPEN_COST = 100;
// A continuation across a road: its near end within half the road's width (plus this) of where the
// street it carries on would come out, and turning less than MAX_TURN_ACROSS.
const ALIGN = 1; // m
// A local road may end on an arterial only in a piece over this many target blocks (measured: 2
// keeps 40–70 such ends a 10 km city, down from 130–200, without bigger blocks).
const ARTERIAL_FALLBACK = 2;
const MAX_TURN_ACROSS = Math.PI / 6;

interface Plan { origin: Point2; across: number }

/** Where to cut: across the long side while it's long, then along it while the piece is deep.
 *  The position leaves one side near a whole number of targets, so blocks come out near the
 *  target size rather than at powers-of-two fractions of the piece. */
export function plans(box: Box, t: { depth: number; length: number }): Plan[] {
  const out: Plan[] = [];
  const along: Point2 = [Math.cos(box.axis), Math.sin(box.axis)], perp: Point2 = [-along[1], along[0]];
  const add = (dim: number, target: number, dir: Point2, across: number) => {
    const n = Math.max(2, Math.round(dim / target));
    const f = Math.floor(n / 2) / n;
    for (const o of OFFSETS) {
      const g = Math.min(0.85, Math.max(0.15, f + o)) - 0.5;
      out.push({ origin: [box.centre[0] + dir[0] * g * dim, box.centre[1] + dir[1] * g * dim], across });
    }
  };
  const longCut = box.long > SLACK * t.length, deepCut = box.short > SLACK * t.depth;
  if (longCut) add(box.long, t.length, along, box.axis + Math.PI / 2);
  if (deepCut) add(box.short, t.depth, perp, box.axis);
  return out;
}

export interface Item { owner: string; piece: MultiPolygon; ctx: DivideCtx }
export interface Divided { streets: Street[]; strips: MultiPolygon[]; blocks: MultiPolygon[] }
interface Best { run: number; line: Point2[]; walks: (ReturnType<typeof walkToRoad>)[]; split: [MultiPolygon, MultiPolygon, MultiPolygon]; snapped: boolean }

// Lines moved to line up with a street across the road (`snapEnds`), to count them.
const snappedLines = new WeakSet<Point2[]>();
/** Each candidate, preceded by its variant moved to line up with a street ending across the road
 *  within half a block depth: tried first, it wins whenever the piece's rules accept it (most cuts
 *  cost nothing), so jogs become crossroads without a score. */
function* withCrossroads(cands: Iterable<Point2[]>, ctx: DivideCtx, t: { depth: number }): Generator<Point2[]> {
  for (const line of cands) {
    const moved = snapEnds(line, ctx.roads, ctx.junctions, t.depth / 2);
    if (moved) { snappedLines.add(moved); yield moved; }
    yield line;
  }
}

/** Divide the pieces of one superblock (what's left after its border streets). */
export function divideSuperblock(pieces: MultiPolygon[], ctx: DivideCtx): Divided & { stats: Record<string, number> } {
  const out = divideAll(pieces.map(piece => ({ owner: '', piece, ctx })));
  return { ...(out.byOwner.get('') ?? { streets: [], strips: [], blocks: [] }), stats: out.stats };
}

/** Divide every piece of the site in one queue, largest first, each by its own context (step,
 *  family, field, lot size), so a street can carry on from one sub-district into the next. */
export function divideAll(items: Item[]): { byOwner: Map<string, Divided>; stats: Record<string, number> } {
  const byOwner = new Map<string, Divided>();
  const stats: Record<string, number> = { rejectedEnds: 0, rejectedSplit: 0, rejectedSize: 0, collectorsSkipped: 0, rejectedCheck: 0, rejectedThin: 0, rejectedSquare: 0, rejectedAngle: 0, edgeRuns: 0, edgeRunM: 0, openEnds: 0, junctionsClose: 0, continued: 0, localOnArterial: 0, crossroads: 0 };
  let routes = 0;
  const outOf = (owner: string) => {
    let o = byOwner.get(owner);
    if (!o) byOwner.set(owner, (o = { streets: [], strips: [], blocks: [] }));
    return o;
  };
  type Queued = Item & { a: number; b: ReturnType<typeof bounds> };
  const enqueue = (it: Item): Queued => ({ ...it, a: area(it.piece), b: bounds(it.piece) });
  const queue: Queued[] = items.map(enqueue);
  while (queue.length) {
    queue.sort((x, y) => y.a - x.a);
    const it = queue.shift()!;
    if (!tryCut(it)) outOf(it.owner).blocks.push(it.piece);
  }
  for (const it of items) outOf(it.owner);
  return { byOwner, stats };

  /** A collector while the piece is longer than the collector spacing and both halves still hold
   *  a row of blocks each side of a local road; a local road otherwise, or if no collector fits. */
  function tryCut(it: Item): boolean {
    const box = obb(it.piece), t = targets(it.ctx);
    if (box.long > t.collectors) {
      const b = best(it.piece, 'C', candidates(it.piece, box, it.ctx, t), it.ctx);
      if (b) { commit(it, b, 'C'); return true; }
      stats.collectorsSkipped++;
    }
    // Local roads keep off arterials (their junctions stay rare) unless the piece can be cut no
    // other way and is big (over ARTERIAL_FALLBACK target blocks): the owner's notes disfavour a
    // local road meeting an arterial, but allow it. Allowed whenever no other cut fitted, it put
    // 130–200 local ends a city back on the arterials; never, it left Rural blocks too big.
    const b = best(it.piece, 'L', candidates(it.piece, box, it.ctx, t), it.ctx, false)
      ?? (area(it.piece) > ARTERIAL_FALLBACK * t.depth * t.length ? best(it.piece, 'L', candidates(it.piece, box, it.ctx, t), it.ctx, true) : null);
    if (b) { if (b.line.some((_, i, l) => (i === 0 || i === l.length - 1) && it.ctx.roads.at(l[i])?.category === 'A')) stats.localOnArterial++; commit(it, b, 'L'); }
    return !!b;
  }

  /** The best of these cuts. A road may end on open land (water, Undeveloped land, the site edge),
   *  so the city's outskirts stay rough, but at least one end must meet a road. An end on any
   *  other roadless edge turns and follows it inside the piece to the nearest road. A cut from
   *  road to road wins outright; otherwise the cheapest, an open end counting as `OPEN_COST`
   *  metres of edge run, a junction too close to another on the same road its `junctionCost`. */
  function best(piece: MultiPolygon, category: 'C' | 'L', cands: Iterable<Point2[]>, ctx: DivideCtx, onArterial = true): Best | null {
    const t = targets(ctx);
    const w = category === 'C' ? ctx.s.collectorWidth : ctx.s.localWidth, maxRun = EDGE_RUN * t.length;
    const minSide = category === 'C' ? 2 * t.depth + ctx.s.localWidth : 0;
    let top: Best | null = null;
    for (let line of withCrossroads(cands, ctx, t)) {
      const lineIn = line;
      const ends = [line[0], line[line.length - 1]];
      const onRoad = ends.map(e => !!ctx.roads.at(e)), open = ends.map((e, i) => !onRoad[i] && ctx.openAt(e));
      const walks = ends.map((e, i) => (onRoad[i] || open[i] ? null : walkToRoad(piece, e, q => !!ctx.roads.at(q), maxRun)));
      if (walks.some((wk, i) => !wk && !onRoad[i] && !open[i]) || open.every(o => o)) { stats.rejectedEnds++; continue; }
      // Collectors take traffic from arterials and other collectors: both ends on a road, one of
      // them an A or C. Locals may meet arterials, but the arterial's junction spacing disfavours it.
      const cats = ends.map(e => ctx.roads.at(e)?.category);
      if (category === 'C' && (!onRoad.every(o => o) || !cats.some(c => c === 'A' || c === 'C'))) { stats.rejectedEnds++; continue; }
      if (!onArterial && cats.some(c => c === 'A') && category === 'L') { stats.rejectedEnds++; continue; }
      const run = walks.reduce((m, wk) => m + (wk?.length ?? 0), 0) + open.filter(o => o).length * OPEN_COST;
      if (top && run >= top.run) continue;
      // A traced cut meeting its road at a slant gets a short square stub there instead, unless
      // the stub itself is too steep (on very steep ground it points straight up the slope).
      for (const i of [0, 1]) if (onRoad[i] && !squareEnds(piece, line, i === 0 ? [true, false] : [false, true])) {
        const fixed = squareStub(piece, i === 0 ? line : [...line].reverse(), STUB);
        const stubbed = fixed && (i === 0 ? fixed : fixed.reverse());
        if (stubbed && gradeCost(stubbed, ctx) !== Infinity) line = stubbed;
      }
      { const why = badLine(line, ctx); if (why) { stats.rejectedCheck++; stats[`rejected_${why}`] = (stats[`rejected_${why}`] ?? 0) + 1; continue; } }
      const cost = run + gradeCost(line, ctx);
      if (top && cost >= top.run) continue;
      if (!squareEnds(piece, line, onRoad)) { stats.rejectedAngle++; continue; }
      // Along an edge the road lies wholly inside: a band of twice its width centred on the
      // outline, whose outer half falls outside the piece. Its far end overshoots into the road
      // it meets, so no corner is left between them.
      let band = offsetPolyline(extend(line, w), w / 2, 'butt');
      for (const wk of walks) if (wk) band = union(band, offsetPolyline(extendEnd(wk.path, w), w, 'butt'));
      const split = splitBand(piece, band);
      if (!split) { stats.rejectedSplit++; continue; }
      if (![split[1], split[2]].every(side => area(side) >= ctx.minBlockArea && obb(side).short >= ctx.minDepth)) { stats.rejectedSize++; continue; }
      // A lot deep throughout: judged on every side narrow enough that it won't be cut along its
      // length again (later cuts only shorten it, so a thin strip stays thin). A wider side is
      // exempt: an odd superblock's leftover has tails until it's cut down. Width from area and
      // outline: a curved strip's box is far wider than the strip, and it slipped through.
      // A side is judged against the piece it came from: a wedge left by a border street can't be
      // cut into anything better than itself, and refusing that left kilometre-long strips.
      const parent = solidity(piece, ctx.minDepth);
      if (![split[1], split[2]].every(side => rectWidth(side) > SLACK * t.depth || asSolid(solidity(side, ctx.minDepth), parent))) { stats.rejectedThin++; continue; }
      if (minSide && ![split[1], split[2]].every(side => obb(side).short >= minSide)) { stats.rejectedSize++; continue; }
      // Squareness (the owner's ask): no wedge-shaped blocks. Only sides small enough to be blocks
      // are judged (bigger ones are cut again); each fills most of its box, or at least isn't much
      // worse than the piece it came from (superblocks can be odd shapes to begin with).
      const need = Math.min(SQUARE, SQUARE_KEEP * fill(piece));
      if (![split[1], split[2]].every(side => plans(obb(side), t).length > 0 || fill(side) >= need)) { stats.rejectedSquare++; continue; }
      top = { run: cost, line, walks, split, snapped: snappedLines.has(line) || snappedLines.has(lineIn) };
      if (cost === 0) break;
    }
    return top;
  }

  /** Make the cut, then carry the street on across the roads its ends meet (all but `from`, the
   *  end it arrived by). */
  function commit(it: Item, b: Best, category: 'C' | 'L', route = `r${routes++}`, from = -1): void {
    const { ctx } = it, t = targets(ctx), o = outOf(it.owner);
    const { line, walks, split } = b;
    if (b.snapped) stats.crossroads++;
    const w = category === 'C' ? ctx.s.collectorWidth : ctx.s.localWidth;
    const ends = [line[0], line[line.length - 1]];
    stats.openEnds += ends.filter(e => !ctx.roads.at(e) && ctx.openAt(e)).length;
    // Each end where it meets a road becomes a junction on that road.
    ends.forEach((e, i) => {
      const at = ctx.roads.at(e) ? e : walks[i]?.path[walks[i]!.path.length - 1];
      const host = at && ctx.roads.at(at);
      if (!at || !host) return;
      if (junctionCost(ctx.roads, ctx.junctions, at, t) > 0) { stats.junctionsClose++; stats[`close${host.category}`] = (stats[`close${host.category}`] ?? 0) + 1; }
      ctx.junctions.add(host, at);
    });
    // The centreline: the cut, then each edge run half a width inside the outline.
    const offs = walks.map(wk => (wk ? offsetPath(wk.path, (wk.side * w) / 2) : null));
    const points: Point2[] = [...(offs[0] ? [...offs[0]].reverse() : [line[0]]), ...line.slice(1, -1), ...(offs[1] ?? [line[line.length - 1]])];
    o.streets.push({ points, category, width: w, route });
    o.strips.push(split[0]);
    ctx.roads.add({ points: line, category, half: w / 2 });
    for (const wk of walks) if (wk) { ctx.roads.add({ points: wk.path, category, half: w }); stats.edgeRuns++; stats.edgeRunM += Math.round(wk.length); }
    queue.push(enqueue({ owner: it.owner, piece: split[1], ctx }), enqueue({ owner: it.owner, piece: split[2], ctx }));
    ends.forEach((e, i) => {
      if (i === from) return;
      const prev = i === 0 ? line[1] : line[line.length - 2];
      const L = Math.hypot(e[0] - prev[0], e[1] - prev[1]) || 1;
      carryOn(ctx.roads, e, [(e[0] - prev[0]) / L, (e[1] - prev[1]) / L], category, route);
    });
  }

  /** Carry a street on across the road it meets at `e`, heading `dir`, into the piece beyond, if
   *  that piece's own rules accept it there. Across collectors and local roads; across an arterial
   *  only as a collector (the arterial's junctions stay rare). */
  function carryOn(roads: RoadIndex, e: Point2, dir: Point2, category: 'C' | 'L', route: string): void {
    const host = roads.at(e);
    if (!host || (host.category === 'A' && category !== 'C')) return;
    const across = 2 * host.half;
    const out: Point2 = [e[0] + dir[0] * across, e[1] + dir[1] * across];
    const seed: Point2 = [out[0] + dir[0] * ALIGN, out[1] + dir[1] * ALIGN];
    const k = queue.findIndex(q => seed[0] >= q.b.minX && seed[0] <= q.b.maxX && seed[1] >= q.b.minZ && seed[1] <= q.b.maxZ && containsPoint(q.piece, seed));
    if (k < 0) return; // a finished block, open land, or nothing
    const q = queue[k], t = targets(q.ctx), box = obb(q.piece);
    if (!plans(box, t).length) return; // already block-sized
    const heading = Math.atan2(dir[1], dir[0]);
    const aligned = (line: Point2[] | null): Point2[] | null => {
      if (!line || line.length < 2) return null;
      const l = Math.hypot(line[0][0] - out[0], line[0][1] - out[1]) <= Math.hypot(line[line.length - 1][0] - out[0], line[line.length - 1][1] - out[1]) ? line : [...line].reverse();
      if (Math.hypot(l[0][0] - out[0], l[0][1] - out[1]) > host.half + ALIGN) return null;
      const d0 = Math.atan2(l[1][1] - l[0][1], l[1][0] - l[0][0]);
      return Math.abs(lineDiffAngle(d0, heading)) < MAX_TURN_ACROSS ? l : null;
    };
    function* cands(): Generator<Point2[]> {
      if (q.ctx.field) {
        const traced = traceCut(q.piece, q.ctx.field, seed, heading, TRACE_STEP, 3 * box.long);
        const l = aligned(traced && simplifyLine(traced, 1));
        if (l) yield l;
      }
      const c = aligned(chordThrough(q.piece, seed, dir));
      if (c) yield c;
    }
    for (const cat of category === 'C' && box.long > t.collectors ? (['C', 'L'] as const) : (['L'] as const)) {
      const b = best(q.piece, cat, cands(), q.ctx, false);
      if (!b) continue;
      queue.splice(k, 1);
      stats.continued++;
      const near = Math.hypot(b.line[0][0] - out[0], b.line[0][1] - out[1]) <= Math.hypot(b.line[b.line.length - 1][0] - out[0], b.line[b.line.length - 1][1] - out[1]) ? 0 : 1;
      commit(q, b, cat, route, near);
      return;
    }
  }
}

/** Signed difference between two headings, in (−π, π]. */
const lineDiffAngle = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** The cut lines to try, best first: each planned line (every stretch of it across the piece, as
 *  an odd-shaped piece can have several), then lines square off the piece's road edges, nearest
 *  its middle first. A piece with a road on one side only can be cut no other way. */
function* candidates(piece: MultiPolygon, box: Box, ctx: DivideCtx, t: { depth: number; length: number }): Generator<Point2[]> {
  const ps = plans(box, t);
  if (!ps.length) return; // small enough: a block
  for (const p of ps) {
    const dir: Point2 = [Math.cos(p.across), Math.sin(p.across)];
    const chords = chordsAlong(piece, p.origin, dir)
      .sort((a, b) => dist2(mid(a), p.origin) - dist2(mid(b), p.origin));
    for (const c of chords) {
      // Traced along the field from the chord's middle first; the straight chord if that fails.
      if (ctx.field) {
        const traced = traceCut(piece, ctx.field, mid(c), p.across, TRACE_STEP, 3 * box.long);
        if (traced) yield simplifyLine(traced, 1);
      }
      yield c;
    }
  }
  const samples = outlineSamples(piece, t.depth / 2, q => !!ctx.roads.at(q))
    .sort((a, b) => dist2(a.p, box.centre) - dist2(b.p, box.centre))
    .slice(0, ROAD_SQUARE);
  for (const { p, inward } of samples) {
    const start: Point2 = [p[0] + inward[0] * 0.01, p[1] + inward[1] * 0.01];
    const c = chordThrough(piece, start, inward);
    // The chord starting at this road point (the far end is where it leaves the piece).
    if (c) yield dist2(c[0], p) < dist2(c[1], p) ? c : [c[1], c[0]];
  }
}
const mid = (c: Point2[]): Point2 => [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
const dist2 = (a: Point2, b: Point2) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
const ROAD_SQUARE = 8;
const TRACE_STEP = 10;

/** Is the piece a lot deep throughout? Shrunk by half a lot depth it stays one piece, and grown
 *  back it keeps most of its area. Converging streamlines cut wedges and long thin tails that a
 *  box or area test passes. */
export function solid(piece: MultiPolygon, depth: number): boolean {
  const s = solidity(piece, depth);
  return s.cores === 1 && s.ratio >= SOLID;
}

/** How many pieces it shrinks to (by half a lot depth), and how much of it grows back. */
export function solidity(piece: MultiPolygon, depth: number): { cores: number; ratio: number } {
  const core = offsetPolygons(piece, -depth / 2);
  const a = area(piece);
  return { cores: core.length, ratio: core.length && a > 0 ? area(offsetPolygons(core, depth / 2)) / a : 0 };
}

/** The width of the rectangle with this area and outline: a strip's width, however it curves. */
export function rectWidth(piece: MultiPolygon): number {
  let per = 0;
  for (const poly of piece) for (const ring of poly) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) per += Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]);
  const a = area(piece);
  return (per - Math.sqrt(Math.max(0, per * per - 16 * a))) / 4;
}

/** Solid, or at least no worse than its parent (less a little). */
function asSolid(side: { cores: number; ratio: number }, parent: { cores: number; ratio: number }): boolean {
  if (side.cores === 1 && side.ratio >= SOLID) return true;
  return side.cores >= 1 && side.cores <= Math.max(1, parent.cores) && side.ratio >= Math.min(SOLID, parent.ratio - 0.05);
}
const SOLID = 0.85;

/** How much of its oriented box a piece fills (1 for a rectangle, 0.5 for a right triangle). */
export function fill(piece: MultiPolygon): number {
  const b = obb(piece);
  return b.long * b.short > 0 ? area(piece) / (b.long * b.short) : 0;
}
const SQUARE = 0.7, SQUARE_KEEP = 0.9;

/** Does the cut meet the outline at each end (of those in `which`: the road ends) at `MIN_ANGLE` or more? Slanted junctions leave
 *  wedge-shaped blocks. */
export function squareEnds(piece: MultiPolygon, line: Point2[], which: boolean[] = [true, true]): boolean {
  const ends: [Point2, Point2][] = [[line[0], line[1]], [line[line.length - 1], line[line.length - 2]]];
  return ends.every(([e, prev], i) => {
    if (!which[i]) return true; // an open end makes no junction
    let best: [Point2, Point2] | null = null, bd = Infinity;
    for (const poly of piece) for (const r of poly) for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const d = sideOf([a, b], e).d;
      if (d < bd) { bd = d; best = [a, b]; }
    }
    if (!best) return true;
    const ex = best[1][0] - best[0][0], ez = best[1][1] - best[0][1], cx = e[0] - prev[0], cz = e[1] - prev[1];
    const s = Math.abs(ex * cz - ez * cx) / ((Math.hypot(ex, ez) * Math.hypot(cx, cz)) || 1);
    return s >= Math.sin(MIN_ANGLE);
  });
}
const MIN_ANGLE = (50 * Math.PI) / 180;
const STUB = 25; // m

/** Re-aim the first end of a cut square to the outline: a stub `len` long along the inward normal,
 *  then on to the cut where it is half again that far from the end. */
export function squareStub(piece: MultiPolygon, line: Point2[], len: number): Point2[] | null {
  const e = line[0];
  let best: [Point2, Point2] | null = null, bd = Infinity;
  for (const poly of piece) for (const r of poly) for (let i = 0; i < r.length; i++) {
    const d = sideOf([r[i], r[(i + 1) % r.length]], e).d;
    if (d < bd) { bd = d; best = [r[i], r[(i + 1) % r.length]]; }
  }
  if (!best) return null;
  const ex = best[1][0] - best[0][0], ez = best[1][1] - best[0][1], L = Math.hypot(ex, ez) || 1;
  // Rings keep the interior on the left.
  const stub: Point2 = [e[0] - (ez / L) * len, e[1] + (ex / L) * len];
  const k = line.findIndex(p => Math.hypot(p[0] - e[0], p[1] - e[1]) >= 1.5 * len);
  if (k < 1) return null;
  return [e, stub, ...line.slice(k)];
}

/** Extend only the last end of a polyline. */
function extendEnd(line: Point2[], by: number): Point2[] {
  const e = extend(line, by);
  return [line[0], ...e.slice(1)];
}

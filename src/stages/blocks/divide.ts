// The recursion: a superblock is cut, largest piece first, by roads running from road to road
// across it, until every piece is a block. Each cut is typed when it's made (its width is cut out
// then). Pure; the direction of each cut comes from `ctx.cutter`.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { area } from '../../grammar/polygon.js';
import { offsetPolyline, union } from '../../grammar/clipper.js';
import { chordsAlong, chordThrough, extend, outlineSamples, obb, offsetPath, splitBand, walkToRoad, type Box } from './geometry.js';
import type { RoadIndex } from './roads.js';
import type { Category, Family } from './rules.js';

export interface BlockSettings {
  collectorWidth: number; localWidth: number;
  denseDepth: number; denseLength: number; sparseDepth: number; sparseLength: number;
  denseCollectors: number; sparseCollectors: number;
  localGrade: number; culDeSacs: number;
}

export interface Street { points: Point2[]; category: 'C' | 'L'; width: number; culDeSac?: boolean }

/** A candidate cut: a line from boundary to boundary of the piece. */
export interface Cut { line: Point2[] }

export interface DivideCtx {
  family: Family;
  s: BlockSettings;
  /** a block must hold one lot of its district's smallest zone */
  minBlockArea: number;
  minDepth: number;
  rng: () => number;
  roads: RoadIndex;
  /** is p on the superblock's outline against open land (water, Undeveloped land, the site edge)? */
  openAt: (p: Point2) => boolean;
  /** candidate cuts across the piece, best first; `across` is the direction the cut should run */
  cutter: (piece: MultiPolygon, origin: Point2, across: number, ctx: DivideCtx) => Cut | null;
  /** extra acceptance test for a cut's line (grade, kinks); null = fine */
  check?: (line: Point2[], ctx: DivideCtx) => string | null;
}

export const straightCutter: DivideCtx['cutter'] = (piece, origin, across) => {
  const c = chordThrough(piece, origin, [Math.cos(across), Math.sin(across)]);
  return c ? { line: c } : null;
};

/** The family's block size: depth (short side) and length (long side). */
export const targets = (ctx: DivideCtx) => (ctx.family === 'sparse'
  ? { depth: ctx.s.sparseDepth, length: ctx.s.sparseLength, collectors: ctx.s.sparseCollectors }
  : { depth: ctx.s.denseDepth, length: ctx.s.denseLength, collectors: ctx.s.denseCollectors });

// A piece is cut while its side exceeds this multiple of the target; below it, it's a block.
const SLACK = 1.4;
const OFFSETS = [0, 0.1, -0.1, 0.2, -0.2];
// The longest run along a roadless edge, in block lengths.
const EDGE_RUN = 2;
// An end on open land, in metres of edge run: a road-to-road cut nearby is preferred.
const OPEN_COST = 100;

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

/** Divide the pieces of one superblock (what's left after its border streets). */
export function divideSuperblock(pieces: MultiPolygon[], ctx: DivideCtx): { streets: Street[]; strips: MultiPolygon[]; blocks: MultiPolygon[]; stats: Record<string, number> } {
  const streets: Street[] = [], strips: MultiPolygon[] = [], blocks: MultiPolygon[] = [];
  const stats: Record<string, number> = { rejectedEnds: 0, rejectedSplit: 0, rejectedSize: 0, rejectedCheck: 0, edgeRuns: 0, edgeRunM: 0, openEnds: 0 };
  const queue = pieces.map(piece => ({ piece, a: area(piece) }));
  const t = targets(ctx);
  while (queue.length) {
    queue.sort((x, y) => y.a - x.a);
    const { piece } = queue.shift()!;
    const done = tryCut(piece);
    if (!done) blocks.push(piece);
  }
  return { streets, strips, blocks, stats };

  /** Try the plans' cuts. A road may end on open land (water, Undeveloped land, the site edge), so
   *  the city's outskirts stay rough, but at least one end must meet a road. An end on any other
   *  roadless edge turns and follows it inside the piece to the nearest road. A cut from road to
   *  road wins outright; otherwise the cheapest, an open end counting as `OPEN_COST` metres of
   *  edge run. */
  function tryCut(piece: MultiPolygon): boolean {
    const box = obb(piece);
    const w = ctx.s.localWidth, maxRun = EDGE_RUN * t.length;
    let best: { run: number; line: Point2[]; walks: (ReturnType<typeof walkToRoad>)[]; split: [MultiPolygon, MultiPolygon, MultiPolygon] } | null = null;
    for (const line of candidates(piece, box, ctx, t)) {
      const ends = [line[0], line[line.length - 1]];
      const onRoad = ends.map(e => !!ctx.roads.at(e)), open = ends.map((e, i) => !onRoad[i] && ctx.openAt(e));
      const walks = ends.map((e, i) => (onRoad[i] || open[i] ? null : walkToRoad(piece, e, q => !!ctx.roads.at(q), maxRun)));
      if (walks.some((wk, i) => !wk && !onRoad[i] && !open[i]) || open.every(o => o)) { stats.rejectedEnds++; continue; }
      const run = walks.reduce((m, wk) => m + (wk?.length ?? 0), 0) + open.filter(o => o).length * OPEN_COST;
      if (best && run >= best.run) continue;
      if (ctx.check?.(line, ctx)) { stats.rejectedCheck++; continue; }
      // Along an edge the road lies wholly inside: a band of twice its width centred on the
      // outline, whose outer half falls outside the piece. Its far end overshoots into the road
      // it meets, so no corner is left between them.
      let band = offsetPolyline(extend(line, w), w / 2, 'butt');
      for (const wk of walks) if (wk) band = union(band, offsetPolyline(extendEnd(wk.path, w), w, 'butt'));
      const split = splitBand(piece, band);
      if (!split) { stats.rejectedSplit++; continue; }
      if (![split[1], split[2]].every(side => area(side) >= ctx.minBlockArea && obb(side).short >= ctx.minDepth)) { stats.rejectedSize++; continue; }
      best = { run, line, walks, split };
      if (run === 0) break;
    }
    if (!best) return false;
    const { line, walks, split } = best;
    stats.openEnds += [line[0], line[line.length - 1]].filter(e => !ctx.roads.at(e) && ctx.openAt(e)).length;
    const category: Category = 'L';
    // The centreline: the cut, then each edge run half a width inside the outline.
    const offs = walks.map(wk => (wk ? offsetPath(wk.path, (wk.side * w) / 2) : null));
    const points: Point2[] = [...(offs[0] ? [...offs[0]].reverse() : [line[0]]), ...line.slice(1, -1), ...(offs[1] ?? [line[line.length - 1]])];
    streets.push({ points, category: category as 'C' | 'L', width: w });
    strips.push(split[0]);
    ctx.roads.add({ points: line, category, half: w / 2 });
    for (const wk of walks) if (wk) { ctx.roads.add({ points: wk.path, category, half: w }); stats.edgeRuns++; stats.edgeRunM += Math.round(wk.length); }
    queue.push({ piece: split[1], a: area(split[1]) }, { piece: split[2], a: area(split[2]) });
    return true;
  }
}

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
    for (const c of chords) yield c;
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

/** Extend only the last end of a polyline. */
function extendEnd(line: Point2[], by: number): Point2[] {
  const e = extend(line, by);
  return [line[0], ...e.slice(1)];
}

// The recursion: a superblock is cut, largest piece first, by roads running from road to road
// across it, until every piece is a block. Each cut is typed when it's made (its width is cut out
// then). Pure; the direction of each cut comes from `ctx.cutter`.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { area } from '../../grammar/polygon.js';
import { chordThrough, obb, splitBy, type Box } from './geometry.js';
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
  const stats: Record<string, number> = { rejectedEnds: 0, rejectedSplit: 0, rejectedSize: 0, rejectedCheck: 0 };
  const queue = pieces.map(piece => ({ piece, a: area(piece) }));
  const t = targets(ctx);
  while (queue.length) {
    queue.sort((x, y) => y.a - x.a);
    const { piece } = queue.shift()!;
    const done = tryCut(piece);
    if (!done) blocks.push(piece);
  }
  return { streets, strips, blocks, stats };

  function tryCut(piece: MultiPolygon): boolean {
    const box = obb(piece);
    for (const p of plans(box, t)) {
      const cut = ctx.cutter(piece, p.origin, p.across, ctx);
      if (!cut) continue;
      const line = cut.line;
      const ends = [line[0], line[line.length - 1]];
      if (!ends.every(e => ctx.roads.at(e))) { stats.rejectedEnds++; continue; }
      if (ctx.check?.(line, ctx)) { stats.rejectedCheck++; continue; }
      const category: Category = 'L';
      const width = ctx.s.localWidth;
      const split = splitBy(piece, line, width);
      if (!split) { stats.rejectedSplit++; continue; }
      const [strip, a, b] = split;
      if (![a, b].every(side => area(side) >= ctx.minBlockArea && obb(side).short >= ctx.minDepth)) { stats.rejectedSize++; continue; }
      streets.push({ points: line, category: category as 'C' | 'L', width });
      strips.push(strip);
      ctx.roads.add({ points: line, category, half: width / 2 });
      queue.push({ piece: a, a: area(a) }, { piece: b, a: area(b) });
      return true;
    }
    return false;
  }
}

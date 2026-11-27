// Cutting a block into lots (the owner's approach C): street-aware recursive splitting. Where the
// block is deep enough for two rows, the first cut runs along its spine, back to back; then cuts
// run square to the frontage road, spaced by the target frontage. Every cut must leave each piece
// facing an allowed road, so corners become corner lots facing two. Lots stretch to the block's
// middle; past twice their target depth the middle is left as open ground. Lot lines are straight:
// square to the street matters more than the terrain at this size.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { difference, offsetPolygons, offsetPolyline, union } from '../../grammar/clipper.js';
import { area } from '../../grammar/polygon.js';
import { fill, rectWidth } from '../blocks/divide.js';
import { chordThrough, extend, obb, splitBand } from '../blocks/geometry.js';

export interface LotCtx {
  target: { frontage: number; depth: number };
  /** is this outline point against a road the block's zone may face? */
  allowed: (p: Point2) => boolean;
}

const SLACK = 1.4; // cut while a side exceeds this many targets, as blocks do
const OFFSETS = [0, 0.1, -0.1, 0.2, -0.2];
const SAMPLE = 2; // m between outline samples when finding frontage
const SQUARE = 0.7, SQUARE_KEEP = 0.9;
const KERF = 0.01; // m: cuts are a hair-thin band, merged back into one side

interface Run { points: { p: Point2; normal: Point2 }[]; length: number }

/** The runs of a piece's outline along allowed roads, longest first, each a list of samples with
 *  the inward normal there (rings keep the interior on their left). */
function frontage(piece: MultiPolygon, allowed: (p: Point2) => boolean): Run[] {
  const runs: Run[] = [];
  for (const poly of piece) for (const ring of poly) {
    const samples: { p: Point2; normal: Point2; ok: boolean }[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-9) continue;
      const n = Math.max(1, Math.round(L / SAMPLE));
      const normal: Point2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      for (let k = 0; k < n; k++) {
        const p: Point2 = [a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n];
        samples.push({ p, normal, ok: allowed(p) });
      }
    }
    // Start at a change, so a run doesn't wrap round the ring's start.
    const s = Math.max(0, samples.findIndex((x, i) => x.ok !== samples[(i + samples.length - 1) % samples.length].ok));
    let cur: Run | null = null;
    for (let j = 0; j < samples.length; j++) {
      const x = samples[(s + j) % samples.length];
      if (!x.ok) { cur = null; continue; }
      if (!cur) runs.push((cur = { points: [], length: 0 }));
      cur.points.push({ p: x.p, normal: x.normal });
      cur.length += SAMPLE;
    }
  }
  return runs.sort((a, b) => b.length - a.length);
}

/** Split along a line (a chord), the hair-thin kerf joining the first side: an exact partition. */
function split(piece: MultiPolygon, line: [Point2, Point2]): [MultiPolygon, MultiPolygon] | null {
  const band = offsetPolyline(extend(line, 1), KERF / 2, 'butt');
  const s = splitBand(piece, band);
  if (!s) return null;
  return [union(s[1], s[0]), s[2]];
}

export function cutBlock(block: MultiPolygon, ctx: LotCtx): { lots: MultiPolygon[]; open: MultiPolygon | null; refused: number } {
  const { frontage: f, depth: d } = ctx.target;
  const lots: MultiPolygon[] = [];
  let refused = 0, open: MultiPolygon | null = null;
  let start: MultiPolygon[] = [block];

  // Open ground: lots stretch to the middle up to twice their depth; beyond that the middle is
  // left open (the owner chose this over rear lots with access strips).
  if (rectWidth(block) > 4 * d) {
    const inner = offsetPolygons(block, -2 * d);
    if (area(inner) >= f * d) {
      open = inner;
      start = difference(block, inner).map(poly => [poly]);
    }
  }

  const minArea = 0.5 * f * d, minSide = 0.5 * Math.min(f, d);
  const needsCut = (p: MultiPolygon) => rectWidth(p) > SLACK * d || (frontage(p, ctx.allowed)[0]?.length ?? 0) > SLACK * f;
  const ok = (piece: MultiPolygon, sides: [MultiPolygon, MultiPolygon]) => {
    const need = Math.min(SQUARE, SQUARE_KEEP * fill(piece));
    return sides.every(side => area(side) >= minArea && obb(side).short >= minSide
      && (frontage(side, ctx.allowed)[0]?.length ?? 0) >= 0.5 * f
      && (needsCut(side) || fill(side) >= need));
  };

  const queue = start.filter(p => area(p) > 0).map(p => ({ p, a: area(p) }));
  while (queue.length) {
    queue.sort((x, y) => y.a - x.a);
    const { p: piece } = queue.shift()!;
    const got = tryCut(piece);
    if (got) queue.push(...got.map(s => ({ p: s, a: area(s) })));
    else lots.push(piece);
  }
  return { lots, open, refused };

  function tryCut(piece: MultiPolygon): [MultiPolygon, MultiPolygon] | null {
    // Back to back, where there's room for two rows.
    if (rectWidth(piece) > SLACK * d) {
      const box = obb(piece), along: Point2 = [Math.cos(box.axis), Math.sin(box.axis)];
      const c = chordThrough(piece, box.centre, along);
      const s = c && split(piece, c);
      if (s && ok(piece, s)) return s;
      refused++;
    }
    // Square to the street, a whole number of frontages from one end.
    for (const run of frontage(piece, ctx.allowed)) {
      if (run.length <= SLACK * f) break;
      const n = Math.max(2, Math.round(run.length / f)), at = Math.floor(n / 2) / n;
      for (const o of OFFSETS) {
        const k = Math.min(run.points.length - 1, Math.max(0, Math.round((at + o) * run.points.length)));
        const { p, normal } = run.points[k];
        const c = chordThrough(piece, [p[0] + normal[0] * 0.01, p[1] + normal[1] * 0.01], normal);
        const s = c && split(piece, c);
        if (s && ok(piece, s)) return s;
        refused++;
      }
    }
    return null;
  }
}

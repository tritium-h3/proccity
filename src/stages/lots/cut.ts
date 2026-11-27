// Cutting a block into lots (the owner's approach C): street-aware recursive splitting. Where the
// block is deep enough for two rows, the first cut runs along its spine, back to back; then cuts
// run square to the frontage road, spaced by the target frontage. Every cut must leave each piece
// facing an allowed road, so corners become corner lots facing two. Lots stretch to the block's
// middle; past twice their target depth the middle is left as open ground. Lot lines are straight:
// square to the street matters more than the terrain at this size.

import type { MultiPolygon, Point2 } from '../../doc/types.js';
import { difference, offsetPolyline, union } from '../../grammar/clipper.js';
import { area, simplifyLine } from '../../grammar/polygon.js';
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

interface Run { points: { p: Point2; normal: Point2; len: number }[]; length: number }

/** The runs of a piece's outline along allowed roads, longest first, each a list of samples with
 *  the inward normal there (rings keep the interior on their left). */
function frontage(piece: MultiPolygon, allowed: (p: Point2) => boolean): Run[] {
  const runs: Run[] = [];
  for (const poly of piece) for (const ring of poly) {
    const samples: { p: Point2; normal: Point2; ok: boolean; len: number }[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 1e-9) continue;
      const n = Math.max(1, Math.round(L / SAMPLE));
      const normal: Point2 = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
      for (let k = 0; k < n; k++) {
        const p: Point2 = [a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n];
        samples.push({ p, normal, ok: allowed(p), len: L / n });
      }
    }
    // Start at a change, so a run doesn't wrap round the ring's start.
    const s = Math.max(0, samples.findIndex((x, i) => x.ok !== samples[(i + samples.length - 1) % samples.length].ok));
    let cur: Run | null = null;
    for (let j = 0; j < samples.length; j++) {
      const x = samples[(s + j) % samples.length];
      if (!x.ok) { cur = null; continue; }
      if (!cur) runs.push((cur = { points: [], length: 0 }));
      cur.points.push({ p: x.p, normal: x.normal, len: x.len });
      cur.length += x.len;
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

const GRID = 10; // m: cells of the block outline's allowed-stretch index
const ON = 0.05; // m: a point this close to an allowed stretch is on it

/** `allowed`, asked once along the block's outline: a lot's frontage can only lie on the block's
 *  outline (cut lines face no road), so later questions test a point against the allowed stretches
 *  of the block's edges. Asking the road index for every sample of every candidate took two thirds
 *  of the stage's time. */
function outlineMap(block: MultiPolygon, allowed: (p: Point2) => boolean): (p: Point2) => boolean {
  const cells = new Map<string, [Point2, Point2][]>();
  const add = (a: Point2, b: Point2) => {
    for (let x = Math.floor((Math.min(a[0], b[0]) - ON) / GRID); x <= Math.floor((Math.max(a[0], b[0]) + ON) / GRID); x++)
      for (let z = Math.floor((Math.min(a[1], b[1]) - ON) / GRID); z <= Math.floor((Math.max(a[1], b[1]) + ON) / GRID); z++) {
        const k = `${x},${z}`, list = cells.get(k);
        if (list) list.push([a, b]); else cells.set(k, [[a, b]]);
      }
  };
  for (const poly of block) for (const ring of poly) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / SAMPLE));
    // Each stretch of the edge is allowed or not by its middle.
    for (let k = 0; k < n; k++) {
      const p: Point2 = [a[0] + ((b[0] - a[0]) * (k + 0.5)) / n, a[1] + ((b[1] - a[1]) * (k + 0.5)) / n];
      if (allowed(p)) add([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n], [a[0] + ((b[0] - a[0]) * (k + 1)) / n, a[1] + ((b[1] - a[1]) * (k + 1)) / n]);
    }
  }
  return p => (cells.get(`${Math.floor(p[0] / GRID)},${Math.floor(p[1] / GRID)}`) ?? []).some(([a, b]) => {
    const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)) : 0;
    return Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]) <= ON;
  });
}

export function cutBlock(block: MultiPolygon, ctxIn: LotCtx): { lots: MultiPolygon[]; open: MultiPolygon | null; refused: number } {
  const ctx: LotCtx = { ...ctxIn, allowed: outlineMap(block, ctxIn.allowed) };
  const { frontage: f, depth: d } = ctx.target;
  const lots: MultiPolygon[] = [];
  let refused = 0, open: MultiPolygon | null = null;
  let start: MultiPolygon[] = [block];

  // Open ground: lots stretch to the middle up to twice their depth from an allowed road; land
  // beyond that is left open (the owner chose this over rear lots with access strips). Measured
  // from allowed roads, not every edge: a block's far side on a road its zone can't face (or none)
  // otherwise became a lot with no frontage.
  const runs = frontage(block, ctx.allowed);
  if (runs.length) {
    // Runs are 2 m samples: simplified first, or offsetting them dominated the stage.
    const band = union(runs.flatMap(r => offsetPolyline(simplifyLine(r.points.map(x => x.p), 0.5), 2 * d, 'round')), []);
    const rest = difference(block, band);
    if (area(rest) >= f * d) {
      const land = difference(block, rest).map(poly => [poly] as MultiPolygon);
      // Bits of the band with no frontage of their own (cut off by the block's shape) go open too.
      const fronted = land.filter(p => (frontage(p, ctx.allowed)[0]?.length ?? 0) >= 0.5 * f);
      const stray = land.filter(p => !fronted.includes(p));
      open = stray.length ? union(rest, stray.flat()) : rest;
      start = fronted;
    }
  }

  const minArea = 0.5 * f * d, minSide = 0.5 * Math.min(f, d);
  // Cheap tests first: frontage samples the road index all round the outline.
  const ok = (piece: MultiPolygon, sides: [MultiPolygon, MultiPolygon]) => {
    if (!sides.every(side => area(side) >= minArea && obb(side).short >= minSide)) return false;
    const need = Math.min(SQUARE, SQUARE_KEEP * fill(piece));
    return sides.every(side => {
      // The target frontage is a minimum (the owner, after seeing lots half that wide): lots
      // stretch rather than narrow.
      const run = frontage(side, ctx.allowed)[0]?.length ?? 0;
      if (run < f - 0.1) return false;
      const final = rectWidth(side) <= SLACK * d && run <= SLACK * f;
      return !final || fill(side) >= need;
    });
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
      // Each row keeps frontage along the spine, half its length at least: repeated spine cuts
      // otherwise left strips the block's length fronting only on its ends.
      const spine = c ? Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) : 0;
      if (s && ok(piece, s) && s.every(side => (frontage(side, ctx.allowed)[0]?.length ?? 0) >= 0.5 * spine)) return s;
      refused++;
    }
    // Square to the street, a whole number of frontages from one end.
    for (const run of frontage(piece, ctx.allowed)) {
      // As many whole frontages as fit, so every lot is 1–2 frontages wide.
      const n = Math.floor(run.length / f);
      if (n < 2) break;
      const at = Math.floor(n / 2) / n;
      for (const o of OFFSETS) {
        // The point that far along the run (by length: a sample's middle was up to half a sample
        // off, enough to leave a lot under the minimum frontage).
        let want = Math.min(0.999, Math.max(0.001, at + o)) * run.length, k = 0;
        while (k < run.points.length - 1 && want > run.points[k].len) want -= run.points[k++].len;
        const { p: mid, normal, len } = run.points[k];
        const shift = want - len / 2; // along the run, from the sample's middle
        const p: Point2 = [mid[0] + normal[1] * shift, mid[1] - normal[0] * shift];
        const c = chordThrough(piece, [p[0] + normal[0] * 0.01, p[1] + normal[1] * 0.01], normal);
        const s = c && split(piece, c);
        if (s && ok(piece, s)) return s;
        refused++;
      }
    }
    return null;
  }
}

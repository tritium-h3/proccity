// Grammar operations on slabs, named after split-grammar operators. Each one
// divides its input: the pieces partition what they came from.

import type { MultiPolygon, Point2, Slab } from '../doc/types.js';
import { difference, intersect, offsetPolygons, offsetPolyline } from './clipper.js';
import { bounds, rect } from './polygon.js';
import { makeSlab } from './slab.js';

/** Absolute metres, or a relative weight of what remains (`'1r'`). */
export type Size = number | `${number}r`;

const isRel = (s: Size): s is `${number}r` => typeof s === 'string';
const weight = (s: `${number}r`) => Number(s.slice(0, -1));

/** Piece lengths along an extent. With no relative sizes, the last piece absorbs any slack. */
function resolveSizes(extent: number, sizes: Size[]): number[] {
  const abs = sizes.reduce<number>((t, s) => t + (isRel(s) ? 0 : s), 0);
  if (abs > extent + 1e-9) throw new Error(`split: absolute sizes (${abs}) exceed extent (${extent})`);
  const rel = sizes.filter(isRel);
  const totalW = rel.reduce((t, s) => t + weight(s), 0);
  const lengths = sizes.map(s => (isRel(s) ? ((extent - abs) * weight(s)) / totalW : s));
  if (rel.length === 0 && lengths.length) lengths[lengths.length - 1] += extent - abs;
  return lengths;
}

export function split(s: Slab, axis: 'x' | 'z' | 'y', sizes: Size[]): Slab[] {
  const { low, high } = s.height;

  if (axis === 'y') {
    if (high === null) {
      const relIdx = sizes.findIndex(isRel);
      if (sizes.filter(isRel).length !== 1 || relIdx !== sizes.length - 1) {
        throw new Error('open slab: only a final relative size may be open');
      }
      let at = low;
      return sizes.map((size, i) => {
        if (i === sizes.length - 1) return makeSlab(structuredClone(s.footprint), at, null);
        const piece = makeSlab(structuredClone(s.footprint), at, at + (size as number));
        at += size as number;
        return piece;
      });
    }
    let at = low;
    return resolveSizes(high - low, sizes).map((len, i, all) => {
      const top = i === all.length - 1 ? high : at + len;
      const piece = makeSlab(structuredClone(s.footprint), at, top);
      at = top;
      return piece;
    });
  }

  const b = bounds(s.footprint);
  if (!Number.isFinite(b.minX)) return sizes.map(() => makeSlab([], low, high));
  const [start, end] = axis === 'x' ? [b.minX, b.maxX] : [b.minZ, b.maxZ];
  let at = start;
  return resolveSizes(end - start, sizes).map((len, i, all) => {
    const to = i === all.length - 1 ? end : at + len;
    // Strips overhang the footprint on the cross axis so edge geometry is never clipped off.
    const strip = axis === 'x' ? rect(at, b.minZ - 1, to, b.maxZ + 1) : rect(b.minX - 1, at, b.maxX + 1, to);
    at = to;
    return makeSlab(intersect(s.footprint, strip), low, high);
  });
}

export function cut(s: Slab, cutter: MultiPolygon): { inside: Slab; outside: Slab } {
  const { low, high } = s.height;
  return {
    inside: makeSlab(intersect(s.footprint, cutter), low, high),
    outside: makeSlab(difference(s.footprint, cutter), low, high),
  };
}

export function inset(s: Slab, d: number): { inner: Slab; border: Slab } {
  const { low, high } = s.height;
  const inner = offsetPolygons(s.footprint, -d);
  return { inner: makeSlab(inner, low, high), border: makeSlab(difference(s.footprint, inner), low, high) };
}

export function band(line: Point2[], width: number): MultiPolygon {
  return offsetPolyline(line, width / 2);
}

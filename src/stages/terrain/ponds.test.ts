import { describe, it, expect } from 'vitest';
import type { Point2 } from '../../doc/types.js';
import { union } from '../../grammar/clipper.js';
import { area, containsPoint, signedArea } from '../../grammar/polygon.js';
import type { Cell } from './cells.js';
import { vkey } from './cells.js';
import { roundPonds } from './ponds.js';

/** A grid of square cells, `n` by `n`, each `s` metres; only the fields roundPonds reads. */
function grid(n: number, s: number): Cell[] {
  const cells: Cell[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x0 = i * s, z0 = j * s;
    const ring: Point2[] = [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
    cells.push({ id: cells.length, seed: [x0 + s / 2, z0 + s / 2], poly: [ring], area: s * s } as Cell);
  }
  return cells;
}

/** Turning angle (degrees) at each vertex of a ring, ignoring in-line points. */
function turns(ring: Point2[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
    const u = Math.atan2(b[1] - a[1], b[0] - a[0]), v = Math.atan2(c[1] - b[1], c[0] - b[0]);
    let d = Math.abs(v - u) * 180 / Math.PI;
    if (d > 180) d = 360 - d;
    out.push(d);
  }
  return out;
}

/** Vertices lying inside another cell's edge without being one of its vertices. */
function tJunctions(cells: Cell[]): string[] {
  const bad: string[] = [];
  for (const c of cells) {
    const own = new Set(c.poly[0].map(vkey));
    const ring = c.poly[0];
    for (const d of cells) {
      if (d === c) continue;
      for (const p of d.poly[0]) {
        if (own.has(vkey(p))) continue;
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
          const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2;
          if (t <= 1e-6 || t >= 1 - 1e-6) continue;
          if (Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]) < 0.005) bad.push(`${vkey(p)} on cell ${c.id}`);
        }
      }
    }
  }
  return bad;
}

const pondOutline = (cells: Cell[], pond: Set<number>) => union(cells.filter(c => pond.has(c.id)).map(c => c.poly), []);

describe('roundPonds', () => {
  // 5×5 grid of 100 m cells; an L-shaped pond of three cells has five convex corners, one
  // concave corner, and two seams between pond cells meeting the outline.
  const pond = new Set([12, 13, 17]);
  const make = () => { const cells = grid(5, 100); roundPonds(cells, i => pond.has(i), 30); return cells; };

  it('still partitions the land exactly', () => {
    const cells = make();
    const sum = cells.reduce((t, c) => t + area([c.poly]), 0);
    expect(sum).toBeCloseTo(250_000, 3);
    expect(area(union(cells.map(c => c.poly), []))).toBeCloseTo(250_000, 3);
    for (const c of cells) {
      expect(signedArea(c.poly[0]), `cell ${c.id}`).toBeGreaterThan(0);
      expect(c.area).toBeCloseTo(area([c.poly]), 6);
    }
  });

  it('leaves no T-junctions', () => {
    expect(tJunctions(make())).toEqual([]);
  });

  it('rounds every corner of the pond, convex and concave', () => {
    const cells = make();
    const outline = pondOutline(cells, pond);
    expect(outline.length).toBe(1);
    expect(Math.max(...turns(outline[0][0]))).toBeLessThan(30);
    // The convex corner at (400, 200) is now land; the concave one at (300, 300) is pond.
    expect(containsPoint(outline, [398, 202])).toBe(false);
    expect(containsPoint(outline, [302, 302])).toBe(true);
  });

  it('only touches cells at the pond', () => {
    const before = grid(5, 100), after = make();
    for (const i of [0, 4, 20, 24]) expect(after[i].poly).toEqual(before[i].poly);
  });

  it('keeps each seed inside its cell', () => {
    for (const c of make()) expect(containsPoint([c.poly], c.seed), `cell ${c.id}`).toBe(true);
  });

  it('holds a point where a pond touches itself, and rounds the rest', () => {
    // Two pond cells meeting only at the corner (200, 200).
    const cells = grid(5, 100), diag = new Set([6, 12]);
    roundPonds(cells, i => diag.has(i), 30);
    expect(cells[6].poly[0].some(p => p[0] === 200 && p[1] === 200)).toBe(true);
    expect(cells[12].poly[0].some(p => p[0] === 200 && p[1] === 200)).toBe(true);
    expect(containsPoint([cells[6].poly], [102, 102])).toBe(false);
    expect(area(union(cells.map(c => c.poly), []))).toBeCloseTo(250_000, 3);
    expect(tJunctions(cells)).toEqual([]);
  });
});

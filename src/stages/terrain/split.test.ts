import { describe, it, expect } from 'vitest';
import { splitGroup, type GraphCell } from './split.js';

const CELL = 1e4;

/** A 4-neighbour grid graph, ids y*w+x; `edgeLen(a, b)` sets a shared edge's length. */
function gridGraph(w: number, h: number, keep: (x: number, y: number) => boolean = () => true,
  edgeLen: (a: number, b: number) => number = () => 100): { cells: GraphCell[]; members: number[] } {
  const cells: GraphCell[] = [];
  const members: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const id = y * w + x;
    const c: GraphCell = { area: CELL, neighbours: [], edge: [] };
    if (keep(x, y)) {
      members.push(id);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || !keep(nx, ny)) continue;
        const n = ny * w + nx;
        c.neighbours.push(n);
        c.edge.push(edgeLen(Math.min(id, n), Math.max(id, n)));
      }
    }
    cells.push(c);
  }
  return { cells, members };
}

function connected(piece: number[], cells: GraphCell[]): boolean {
  const inside = new Set(piece), seen = new Set([piece[0]]), stack = [piece[0]];
  while (stack.length) for (const n of cells[stack.pop()!].neighbours) if (inside.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
  return seen.size === piece.length;
}

function expectPartition(pieces: number[][], members: number[]) {
  expect(pieces.flat().sort((a, b) => a - b)).toEqual([...members].sort((a, b) => a - b));
}

describe('splitGroup', () => {
  it('cuts two blobs at the neck', () => {
    // Two 5×5 blocks (x 0–4 and x 7–11) joined by a corridor at y = 2, x = 5–6.
    const { cells, members } = gridGraph(12, 5, (x, y) => x <= 4 || x >= 7 || y === 2);
    const pieces = splitGroup(members, cells, 25 * CELL);
    expect(pieces).toHaveLength(2);
    expectPartition(pieces, members);
    const left = members.filter(id => id % 12 <= 4), right = members.filter(id => id % 12 >= 7);
    const owner = (id: number) => pieces.findIndex(p => p.includes(id));
    expect(new Set(left.map(owner)).size).toBe(1);
    expect(new Set(right.map(owner)).size).toBe(1);
    expect(owner(left[0])).not.toBe(owner(right[0]));
  });

  it('leaves a group under 1.5 × target alone', () => {
    const { cells, members } = gridGraph(10, 3);
    expect(splitGroup(members, cells, 25 * CELL)).toEqual([members]);
  });

  it('splits a big uniform block into connected pieces near the target', () => {
    const { cells, members } = gridGraph(10, 10);
    const pieces = splitGroup(members, cells, 25 * CELL);
    expect(pieces.length).toBeGreaterThan(1);
    expectPartition(pieces, members);
    for (const p of pieces) {
      expect(p.length).toBeGreaterThanOrEqual(10);
      expect(p.length).toBeLessThanOrEqual(37.5);
      expect(connected(p, cells)).toBe(true);
    }
  });

  it('never makes a piece under 0.4 × target', () => {
    const { cells, members } = gridGraph(6, 6);
    for (const p of splitGroup(members, cells, 25 * CELL)) expect(p.length).toBeGreaterThanOrEqual(10);
  });

  it('keeps the pieces of a ring connected', () => {
    const { cells, members } = gridGraph(8, 8, (x, y) => !(x >= 2 && x <= 5 && y >= 2 && y <= 5));
    const pieces = splitGroup(members, cells, 16 * CELL);
    expect(pieces.length).toBeGreaterThan(1);
    expectPartition(pieces, members);
    for (const p of pieces) {
      expect(connected(p, cells)).toBe(true);
      expect(p.length).toBeGreaterThanOrEqual(6.4);
    }
  });

  it('terminates on a single cell and on a tiny target', () => {
    const one = gridGraph(1, 1);
    expect(splitGroup(one.members, one.cells, 1)).toEqual([[0]]);
    const { cells, members } = gridGraph(4, 4);
    const pieces = splitGroup(members, cells, 1);
    expectPartition(pieces, members);
    for (const p of pieces) expect(connected(p, cells)).toBe(true);
  });

  it('is deterministic', () => {
    const { cells, members } = gridGraph(9, 7);
    expect(splitGroup(members, cells, 12 * CELL)).toEqual(splitGroup(members, cells, 12 * CELL));
  });

  it('handles disconnected input', () => {
    const { cells, members } = gridGraph(5, 2, x => x !== 2);
    const pieces = splitGroup(members, cells, 1);
    expectPartition(pieces, members);
    for (const p of pieces) expect(connected(p, cells)).toBe(true);
  });
});

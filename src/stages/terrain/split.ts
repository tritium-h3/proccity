// Splits a big terrain region at its necks. A region is a group of cells. Its cell graph has
// edges weighted by shared edge length, so a narrow gap between hills is a short cut. While a
// group is over SPLIT_OVER × target it is cut in two along the cut that is shortest relative
// to the smaller side (cut length / sqrt(area)). Small groups are never cut, so they keep
// reaching through gaps. Cuts follow cell edges, so no geometry is made.
//
// Candidate cuts come from a spectral sweep. The graph Laplacian's Fiedler vector orders the
// cells so that bottlenecks fall between consecutive cells. A plain graph-distance order is
// swept too, as a cheap backstop. A group with no legal cut is final and never revisited.
// Pieces only ever shrink, so the loop ends.

export type GraphCell = { area: number; neighbours: number[]; edge: number[] };

/** Groups over this multiple of the target are split. */
export const SPLIT_OVER = 1.5;
/** No piece may be smaller than this multiple of the target. */
export const MIN_PIECE = 0.4;

const byId = (a: number, b: number) => a - b;

/** Connected components of `members`, using only edges inside the set. */
function components(members: number[], cells: GraphCell[]): number[][] {
  const inside = new Set(members), seen = new Set<number>(), out: number[][] = [];
  for (const s of [...members].sort(byId)) {
    if (seen.has(s)) continue;
    const comp = [s], stack = [s];
    seen.add(s);
    while (stack.length) for (const n of cells[stack.pop()!].neighbours) {
      if (inside.has(n) && !seen.has(n)) { seen.add(n); comp.push(n); stack.push(n); }
    }
    out.push(comp.sort(byId));
  }
  return out;
}

const isConnected = (set: number[], cells: GraphCell[]) => components(set, cells).length === 1;

/** Graph distance (hops) from `start` within the piece. */
function hops(piece: number[], cells: GraphCell[], start: number): Map<number, number> {
  const inside = new Set(piece), d = new Map([[start, 0]]), queue = [start];
  for (let q = 0; q < queue.length; q++) for (const n of cells[queue[q]].neighbours) {
    if (inside.has(n) && !d.has(n)) { d.set(n, d.get(queue[q])! + 1); queue.push(n); }
  }
  return d;
}

/** Approximate Fiedler vector by power iteration on cI − L, deflating the constant vector.
 *  The sweep needs only the order of the cells, not an exact vector, so it stops once the order
 *  holds steady between checks. Full convergence took 2,000 rounds per cut on big groups,
 *  since the shift makes the ratio between eigenvalues close to 1. */
function fiedler(piece: number[], cells: GraphCell[], start: number[]): number[] {
  const n = piece.length, idx = new Map(piece.map((c, i) => [c, i]));
  // Compressed adjacency: neighbours of i are nbr[off[i]..off[i+1]), with weights w.
  const off = new Int32Array(n + 1), nbr: number[] = [], w: number[] = [];
  const deg = new Float64Array(n);
  piece.forEach((c, i) => {
    cells[c].neighbours.forEach((nb, k) => {
      const j = idx.get(nb);
      if (j !== undefined) { nbr.push(j); w.push(cells[c].edge[k]); deg[i] += cells[c].edge[k]; }
    });
    off[i + 1] = nbr.length;
  });
  const shift = 2 * Math.max(...deg) + 1;
  let v = Float64Array.from(start), next = new Float64Array(n);
  const normalise = (x: Float64Array) => {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += x[i];
    mean /= n;
    let len = 0;
    for (let i = 0; i < n; i++) { x[i] -= mean; len += x[i] * x[i]; }
    len = Math.sqrt(len) || 1;
    for (let i = 0; i < n; i++) x[i] /= len;
  };
  const order = (x: Float64Array) => Array.from(x.keys()).sort((p, q) => x[p] - x[q] || p - q).join();
  normalise(v);
  let last = order(v);
  for (let it = 1; it <= 1000; it++) {
    for (let i = 0; i < n; i++) {
      let acc = (shift - deg[i]) * v[i];
      for (let k = off[i]; k < off[i + 1]; k++) acc += w[k] * v[nbr[k]];
      next[i] = acc;
    }
    normalise(next);
    [v, next] = [next, v];
    if (it % 25 === 0) {
      const now = order(v);
      if (now === last) break;
      last = now;
    }
  }
  return Array.from(v);
}

/** The best legal cut of a connected piece, or null when there is none. */
function bestCut(piece: number[], cells: GraphCell[], target: number): [number[], number[]] | null {
  const total = piece.reduce((s, c) => s + cells[c].area, 0);
  const minPiece = MIN_PIECE * target;
  if (piece.length < 2 || total < 2 * minPiece) return null;

  // Orders to sweep: the Fiedler order, and graph distance from an extreme cell.
  const d0 = hops(piece, cells, piece[0]);
  const far = piece.reduce((a, c) => (d0.get(c)! > d0.get(a)! || (d0.get(c) === d0.get(a) && c < a) ? c : a), piece[0]);
  const dFar = hops(piece, cells, far);
  const dist = piece.map(c => dFar.get(c)!);
  const f = fiedler(piece, cells, dist);
  const orders = [f, dist].map(key => piece.map((c, i) => ({ c, k: key[i] })).sort((a, b) => a.k - b.k || a.c - b.c).map(e => e.c));

  // Score every prefix of both orders first, then test connectivity best-first: checking each
  // improving prefix as the sweep went was O(n²) on big groups.
  const candidates: { score: number; order: number[]; k: number }[] = [];
  const inside = new Set(piece);
  for (const order of orders) {
    const inPrefix = new Set<number>();
    let area = 0, cut = 0;
    for (let k = 0; k < order.length - 1; k++) {
      const u = order[k];
      inPrefix.add(u);
      area += cells[u].area;
      cells[u].neighbours.forEach((nb, j) => {
        if (!inside.has(nb)) return;
        cut += inPrefix.has(nb) ? -cells[u].edge[j] : cells[u].edge[j];
      });
      const small = Math.min(area, total - area);
      if (small >= minPiece) candidates.push({ score: cut / Math.sqrt(small), order, k });
    }
  }
  candidates.sort((x, y) => x.score - y.score || orders.indexOf(x.order) - orders.indexOf(y.order) || x.k - y.k);
  for (const { order, k } of candidates) {
    const a = order.slice(0, k + 1), b = order.slice(k + 1);
    if (isConnected(a, cells) && isConnected(b, cells)) return [a.sort(byId), b.sort(byId)];
  }
  return null;
}

/** Split a group of cells into pieces of about `target` (m²) at its necks. Pieces are sorted
 *  id lists, ordered by smallest id. A group not over SPLIT_OVER × target comes back whole. */
export function splitGroup(members: number[], cells: GraphCell[], target: number): number[][] {
  const areaOf = (p: number[]) => p.reduce((s, c) => s + cells[c].area, 0);
  if (areaOf(members) <= SPLIT_OVER * target) return [[...members].sort(byId)];
  const queue = components(members, cells), done: number[][] = [];
  while (queue.length) {
    const piece = queue.pop()!;
    const cut = areaOf(piece) > SPLIT_OVER * target ? bestCut(piece, cells, target) : null;
    if (cut) queue.push(...cut);
    else done.push(piece);
  }
  return done.sort((a, b) => a[0] - b[0]);
}

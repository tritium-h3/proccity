// Which districts the arterials link (design: 2026-11-23-arterial-gateways-design.md). Over the
// district graph: the cheapest spanning tree, without Undeveloped districts it merely hangs off;
// the exits; then every developed district with one link gets another (no leaves, so no dead
// ends); then the Redundancy share of the remaining developed–developed links as loops. An
// Undeveloped district ends with no links or with two or more, never one: a road only enters
// the wilds to pass through.

export interface LinkCand { a: number; b: number; cost: number; kind: 'border' | 'river' | 'exit' }
export interface LinkOpts {
  exits: number;
  redundancy: number;
  /** exit candidates (indices) in the order they're preferred, e.g. spread along the edge */
  exitOrder?: number[];
  /** called as each link is chosen (tree, exits, no-leaf links, then loops), so the caller can
   *  place its gateway. A loop it refuses (false) is skipped; a required link is kept anyway. */
  place?(i: number, required: boolean): boolean;
}
export interface Links {
  /** chosen candidate indices, in the order they were placed */
  chosen: number[];
  /** the tree's links (after Undeveloped leaves were dropped) */
  tree: Set<number>;
  /** developed districts left with fewer than two links */
  leaves: number[];
}

/** Districts are 0..n-1; the outside (for exits) is node n. */
export function chooseLinks(n: number, developed: boolean[], cands: LinkCand[], opts: LinkOpts): Links {
  const order = cands.map((_, i) => i).sort((x, y) => cands[x].cost - cands[y].cost || x - y);
  const deg = new Array<number>(n + 1).fill(0);
  const chosen = new Set<number>();
  const placed: number[] = [];
  const add = (i: number) => { chosen.add(i); deg[cands[i].a]++; deg[cands[i].b]++; };
  const drop = (i: number) => { chosen.delete(i); deg[cands[i].a]--; deg[cands[i].b]--; };
  const isDev = (v: number) => v < n && developed[v];
  const other = (i: number, v: number) => (cands[i].a === v ? cands[i].b : cands[i].a);
  const touching = (v: number) => order.filter(i => cands[i].a === v || cands[i].b === v);
  const place = (i: number, required: boolean) => {
    const ok = opts.place ? opts.place(i, required) : true;
    if (ok || required) { add(i); placed.push(i); return true; }
    return false;
  };

  // 1. Kruskal over border and river links.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const tree = new Set<number>();
  for (const i of order) {
    const { a, b, kind } = cands[i];
    if (kind === 'exit') continue;
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    parent[ra] = rb;
    tree.add(i);
    deg[a]++; deg[b]++;
  }
  // Undeveloped districts the tree only hangs off go, repeatedly.
  for (let changed = true; changed;) {
    changed = false;
    for (const i of [...tree]) {
      const { a, b } = cands[i];
      const leaf = [a, b].find(v => !isDev(v) && deg[v] === 1);
      if (leaf === undefined) continue;
      tree.delete(i); deg[a]--; deg[b]--;
      changed = true;
    }
  }
  deg.fill(0);
  for (const i of order) if (tree.has(i)) place(i, true);

  // 2. Exits.
  const exitOrder = opts.exitOrder ?? order.filter(i => cands[i].kind === 'exit');
  let exits = 0;
  for (const i of exitOrder) {
    if (exits >= opts.exits) break;
    if (chosen.has(i) || cands[i].kind !== 'exit') continue;
    place(i, true);
    exits++;
  }

  // 3. No leaves. A developed district with one link takes its cheapest other link: straight to
  //    a developed district (or one already linked), or through an Undeveloped district to a
  //    second link beyond it.
  const fixLeaves = () => {
    for (let guard = 0; guard <= n; guard++) {
      let progress = false;
      for (let v = 0; v < n; v++) {
        if (!isDev(v) || deg[v] !== 1) continue;
        const opts1 = touching(v).filter(i => !chosen.has(i));
        const direct = opts1.find(i => { const u = other(i, v); return u === n || isDev(u) || deg[u] >= 1; });
        if (direct !== undefined) { place(direct, true); progress = true; continue; }
        // Through the wilds: v - u - w, u Undeveloped and unlinked, w anything but v.
        let best: [number, number] | null = null, bestCost = Infinity;
        for (const i of opts1) {
          const u = other(i, v);
          for (const j of touching(u)) {
            if (j === i || chosen.has(j) || other(j, u) === v) continue;
            const c = cands[i].cost + cands[j].cost;
            if (c < bestCost) { bestCost = c; best = [i, j]; }
          }
        }
        if (best) { place(best[0], true); place(best[1], true); progress = true; }
      }
      if (!progress) return;
    }
  };
  fixLeaves();

  // 4. Loops: the Redundancy share of the remaining developed–developed links, cheapest first.
  const spare = order.filter(i => !chosen.has(i) && cands[i].kind !== 'exit' && isDev(cands[i].a) && isDev(cands[i].b));
  let loops = Math.round(opts.redundancy * spare.length);
  for (const i of spare) {
    if (loops <= 0) break;
    if (place(i, false)) loops--;
  }

  // 5. No Undeveloped district with exactly one link; fixing that may make a new developed leaf.
  for (let guard = 0; guard <= n; guard++) {
    const lone = [...chosen].find(i => [cands[i].a, cands[i].b].some(v => v < n && !developed[v] && deg[v] === 1));
    if (lone === undefined) break;
    drop(lone);
    placed.splice(placed.indexOf(lone), 1);
    tree.delete(lone);
    fixLeaves();
  }

  const leaves: number[] = [];
  for (let v = 0; v < n; v++) if (isDev(v) && deg[v] < 2) leaves.push(v);
  return { chosen: placed, tree, leaves };
}

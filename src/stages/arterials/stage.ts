// Arterials: stage 3. A sparse, connected, terrain-following network that links and divides
// the districts. Hubs (the town centres, then points about `spacing` apart) are joined by a
// pruned Delaunay mesh; each link is routed over a cost grid that follows contours, prefers
// district borders and keeps clear of other roads; exits lead off the site; any district still
// untouched gets a short spur. Roads are then cut out of the districts (arterial + superblock
// pieces) and the river (bridge + water).
// Design: docs/superpowers/specs/2026-11-23-arterials-design.md

import { childId } from '../../doc/tree.js';
import { groundHeightAt } from '../../doc/ground.js';
import type { MultiPolygon, Point2, RegionNode, Settings } from '../../doc/types.js';
import { difference, intersect, offsetPolyline, union } from '../../grammar/clipper.js';
import { area, bounds, centroid, containsPoint, simplifyLine } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import type { Stage } from '../types.js';
import { BLOCKED, buildGrid, cellOf, centreOf, HILLS, isUsable, LAND, markRoad, remarkRoads, RIVER, stepCost, WILD, type CostParams } from './grid.js';
import { placeOnBorder, sharedBorder } from './gateways.js';
import { pairGateways } from './inside.js';
import { chooseLinks, type LinkCand } from './links.js';
import { route } from './route.js';
import { smoothRoad, tightBends } from './smooth.js';
import { cutPiece, districtsIn, junctions, loopsOf, pointAt, project, slice } from './loops.js';
import { slivers } from './space.js';

// Distances scale with the city: the routing grid is spacing/35 (20 m at the old 700 m), but at
// most ~300 cells across; other distances are in cells, spacing or district widths.
const CELLS_PER_SPACING = 35, MAX_GRID = 300;
const WATER = new Set(['sea', 'river', 'pond']);
// Links touching Undeveloped land cost this much more: a road there only passes through.
const WILD_LINK = 3;
// Loops must take in at least this many districts (the owner, 2026-11-24: "I don't want rings
// around a single district border").
const LOOP_DISTRICTS = 3;
// A through road this many times longer than the straight line between its gateways has detoured
// to arrive square; a route arriving at an angle is tried instead.
const DETOUR = 2;

interface Road { id: string; points: Point2[]; exit: boolean; required: boolean; how: 'through' | 'border' | 'direct' | 'tee' | 'join' | 'star' | 'bridge' | 'connector' }

/** Metres along a polyline to its point nearest p. */
function perimOn(line: Point2[], p: Point2): number {
  let run = 0, best = 0, bd = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (L * L))) : 0;
    const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
    if (d < bd) { bd = d; best = run + t * L; }
    run += L;
  }
  return best;
}

const segDist = (p: Point2, a: Point2, b: Point2) => {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
};

/** Whether two polylines come within `tol` metres of each other anywhere (crossing counts). */
function roadsTouch(a: Road, b: Road, tol: number): boolean {
  const box = (r: Road) => r.points.reduce((m, p) => [Math.min(m[0], p[0]), Math.min(m[1], p[1]), Math.max(m[2], p[0]), Math.max(m[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  const A = box(a), B = box(b);
  if (A[0] > B[2] + tol || B[0] > A[2] + tol || A[1] > B[3] + tol || B[1] > A[3] + tol) return false;
  const cross = (o: Point2, p: Point2, q: Point2) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  for (let i = 0; i + 1 < a.points.length; i++) for (let j = 0; j + 1 < b.points.length; j++) {
    const [p, q] = [a.points[i], a.points[i + 1]], [r, t] = [b.points[j], b.points[j + 1]];
    if (cross(p, q, r) * cross(p, q, t) < 0 && cross(r, t, p) * cross(r, t, q) < 0) return true;
    if (Math.min(segDist(p, r, t), segDist(q, r, t), segDist(r, p, q), segDist(t, p, q)) <= tol) return true;
  }
  return false;
}

export const arterials: Stage = {
  id: 'arterials',
  title: 'Arterials',
  settings: [
    { key: 'spacing', label: 'Gateway spacing', type: 'number', min: 500, max: 5000, step: 100, default: 2000, unit: 'm', help: 'The closest two gateways (where arterials cross a district border) may be' },
    { key: 'redundancy', label: 'Redundancy', type: 'number', min: 0, max: 1, step: 0.05, default: 0.3, help: 'Share of the remaining district links added as loops' },
    { key: 'borderRoads', label: 'Border roads', type: 'number', min: 0, max: 1, step: 0.05, default: 0.3, help: 'Share of neighbouring gateways joined along the district border rather than across it' },
    { key: 'exits', label: 'Exits', type: 'number', min: 1, max: 8, step: 1, default: 3, help: 'Arterials leading off the site' },
    { key: 'roadWidth', label: 'Road width', type: 'number', min: 15, max: 40, step: 1, default: 25, unit: 'm', help: 'Including verges' },
    { key: 'junctionAngle', label: 'Junction angle', type: 'number', min: 30, max: 90, step: 5, default: 60, unit: '°', help: 'The sharpest angle two arterials may meet at' },
    { key: 'curveRadius', label: 'Curve radius', type: 'number', min: 50, max: 500, step: 10, default: 150, unit: 'm', help: 'The tightest bend an arterial may take' },
    { key: 'maxGrade', label: 'Max grade', type: 'number', min: 2, max: 20, step: 1, default: 8, unit: '%', help: 'Steepest grade an arterial should take (soft)' },
    { key: 'usableWidth', label: 'Usable width', type: 'number', min: 100, max: 800, step: 50, default: 300, unit: 'm', help: 'Narrowest land left between roads, or a road and a district edge' },
  ],

  run({ tree, leaves, settings, rng }) {
    const t0 = performance.now();
    const s = settings as Settings & { spacing: number; redundancy: number; borderRoads: number; exits: number; roadWidth: number; junctionAngle: number; curveRadius: number; maxGrade: number; usableWidth: number };
    const children = new Map<string, RegionNode[]>();
    const dists = leaves.filter(n => n.kind === 'district');
    if (!dists.length) return { children };
    const params: CostParams = { maxGrade: s.maxGrade / 100, roadWidth: s.roadWidth, usableWidth: s.usableWidth };

    // 1. The grid.
    const terrainKids = tree.children;
    const blocked = terrainKids.filter(n => n.kind === 'sea' || n.kind === 'pond').map(n => n.geometry.footprint);
    const river = terrainKids.find(n => n.kind === 'river');
    const hills = dists.filter(d => d.attrs.terrain === 'hills').map(d => d.geometry.footprint);
    // Undeveloped land: dearer to cross, and no road ends in or beside it (the owner).
    const wild = dists.filter(d => d.attrs.type === 'undeveloped').map(d => d.geometry.footprint);
    const sb = bounds(tree.geometry.footprint);
    const size = Math.max(sb.maxX - sb.minX, sb.maxZ - sb.minZ);
    const onSiteEdge = (p: Point2) => Math.min(Math.abs(p[0] - sb.minX), Math.abs(p[0] - sb.maxX), Math.abs(p[1] - sb.minZ), Math.abs(p[1] - sb.maxZ)) < 0.5;
    const cellM = Math.max(s.spacing / CELLS_PER_SPACING, size / MAX_GRID);
    // Sectors (about 22.5°) a route may turn per step: as many as a curve of the Curve radius
    // turns in one cell, at least one. Two per step at 100 m cells made 90° Vs, drawn as hairpins.
    const maxTurn = Math.max(1, Math.min(2, Math.floor(cellM / ((s.curveRadius * Math.PI) / 8))));
    // Road ends (hubs, spur ends) keep this far from water and Undeveloped land: hubs on the
    // flat ground beside a pond or river drew dead ends right up to the shore. A cell more
    // than the Usable width, since a road ends at a cell centre.
    const keepOff = s.usableWidth + cellM;
    const districtWidth = Math.sqrt(dists.reduce((t, d) => t + area(d.geometry.footprint), 0) / dists.length);
    // Kinds painted in order (later wins); elevations from the terrain's own triangles, water
    // first so land wins along shared edges. Point lookups per cell took seconds at 5 km.
    const water = terrainKids.filter(n => n.kind === 'sea' || n.kind === 'pond' || n.kind === 'river').flatMap(n => n.geometry.footprint);
    // District borders that are really shorelines (water on one side) aren't corridors: they
    // drew roads along river banks and pond shores, and snapping a road onto one spilled it
    // over the water.
    const waterBoxes = water.map(poly => ({ poly: [poly] as MultiPolygon, box: bounds([poly]) }));
    const wetAt = (p: Point2) => waterBoxes.some(w => p[0] >= w.box.minX && p[0] <= w.box.maxX && p[1] >= w.box.minZ && p[1] <= w.box.maxZ && containsPoint(w.poly, p));
    const wetSide = (a: Point2, b: Point2) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) return false;
      const nx = -(b[1] - a[1]) / len, nz = (b[0] - a[0]) / len, mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      return wetAt([mx + nx, mz + nz]) || wetAt([mx - nx, mz - nz]);
    };
    const g = buildGrid({
      bounds: { minX: sb.minX, minZ: sb.minZ, size },
      elevAt: (x, z) => groundHeightAt(tree, x, z),
      kindAt: () => LAND,
      kinds: [
        { footprint: tree.geometry.footprint, kind: LAND },
        ...wild.map(footprint => ({ footprint, kind: WILD })),
        ...hills.map(footprint => ({ footprint, kind: HILLS })),
        ...(river ? [{ footprint: river.geometry.footprint, kind: RIVER }] : []),
        ...blocked.map(footprint => ({ footprint, kind: BLOCKED })),
      ],
      surfaces: [...terrainKids.filter(n => WATER.has(n.kind)), ...terrainKids.filter(n => !WATER.has(n.kind))].flatMap(n => (n.data?.ground ? [n.data.ground] : [])),
      districts: dists.map(d => d.geometry.footprint),
      river: river?.geometry.footprint,
      water: [...water, ...tree.geometry.footprint],
      wild,
      // District borders are corridors, but not the site's own edge: roads hugged it.
      skipSegment: (a, b) => (onSiteEdge(a) && onSiteEdge(b)) || wetSide(a, b),
    }, cellM, {
      // Running alongside a border costs out to the Usable width: nearer than that, the strip
      // left between road and border is too thin to use (the owner: roads crept along edges).
      band: Math.max(2 * cellM, s.usableWidth), edgeScale: 0.44 * districtWidth, roadReach: Math.max(8 * cellM, 1.1 * s.usableWidth),
      riverReach: 5 * cellM, bankExtra: cellM / 2, bankReach: keepOff, wildReach: keepOff,
    });
    const usable = (c: number) => isUsable(g.kind[c]);
    // Clear of water and Undeveloped land. The bank field holds the site edge too; that
    // doesn't count here (hubs have their own edge margin).
    const edgeDist = (p: Point2) => Math.min(p[0] - sb.minX, sb.maxX - p[0], p[1] - sb.minZ, sb.maxZ - p[1]);
    const clear = (c: number) => usable(c) && g.wild[c] >= keepOff && (g.bank[c] >= keepOff || edgeDist(centreOf(g, c)) <= g.bank[c] + 1);
    const gradeAt = (c: number) => {
      const i = c % g.w, j = Math.floor(c / g.w);
      let m = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
        m = Math.max(m, Math.abs(g.elev[nj * g.w + ni] - g.elev[c]) / g.cell);
      }
      return m;
    };
    const estimate = (a: Point2, b: Point2) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / g.cell));
      const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
      let cost = 0;
      let prev = cellOf(g, a[0], a[1]);
      for (let k = 1; k <= n; k++) {
        const c = cellOf(g, a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n);
        const st = c === prev ? 0 : stepCost(g, prev, c, heading, params);
        cost += Number.isFinite(st) ? st : 1e4;
        prev = c;
      }
      return cost;
    };
    const lineLength = (l: Point2[]) => l.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - l[i][0], q[1] - l[i][1]), 0);
    const pointAlong = (l: Point2[], at: number): Point2 => {
      let run = 0;
      for (let i = 0; i + 1 < l.length; i++) {
        const seg = Math.hypot(l[i + 1][0] - l[i][0], l[i + 1][1] - l[i][1]);
        if (run + seg >= at && seg > 0) { const t = (at - run) / seg; return [l[i][0] + (l[i + 1][0] - l[i][0]) * t, l[i][1] + (l[i + 1][1] - l[i][1]) * t]; }
        run += seg;
      }
      return l[l.length - 1];
    };

    // 2. The district graph (design: 2026-11-23-arterial-gateways-design.md).
    const n = dists.length;
    const developed = dists.map(d => d.attrs.type !== 'undeveloped');
    const boxes = dists.map(d => bounds(d.geometry.footprint));
    // Each district's own cells (centre inside), plus a margin of the Usable width (at least a
    // cell) its roads may stray into: confined to the district itself, routes couldn't follow
    // the contours (on hilly ground they were barely gentler than straight lines).
    const reach = Math.max(1, Math.round(s.usableWidth / cellM));
    const masks = dists.map((d, k) => {
      const b = boxes[k], own = new Set<number>(), out = new Set<number>();
      const i0 = Math.max(0, Math.floor((b.minX - g.minX) / g.cell)), i1 = Math.min(g.w - 1, Math.floor((b.maxX - g.minX) / g.cell));
      const j0 = Math.max(0, Math.floor((b.minZ - g.minZ) / g.cell)), j1 = Math.min(g.h - 1, Math.floor((b.maxZ - g.minZ) / g.cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (containsPoint(d.geometry.footprint, centreOf(g, j * g.w + i))) own.add(j * g.w + i);
      for (const c of own) for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
        const i = (c % g.w) + di, j = Math.floor(c / g.w) + dj;
        if (i >= 0 && j >= 0 && i < g.w && j < g.h) out.add(j * g.w + i);
      }
      return { own, out };
    });
    // A district's centre: its usable cell nearest the centroid (a concave district's centroid
    // can be outside it), clear of water and the wilds where possible.
    const centres = dists.map((d, k) => {
      const c0 = centroid(d.geometry.footprint);
      let best = -1, bd = Infinity;
      for (const c of masks[k].own) {
        if (!usable(c)) continue;
        const [x, z] = centreOf(g, c);
        const dd = Math.hypot(x - c0[0], z - c0[1]) + (clear(c) || !developed[k] ? 0 : 1e6);
        if (dd < bd) { bd = dd; best = c; }
      }
      return best >= 0 ? centreOf(g, best) : c0;
    });
    const minBorder = 2 * s.usableWidth + s.roadWidth;
    interface Cand extends LinkCand { line?: Point2[]; bridge?: [Point2, Point2] }
    const cands: Cand[] = [];
    // Border links: districts sharing a border long enough to hold a gateway.
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.minX > b.maxX + 1 || b.minX > a.maxX + 1 || a.minZ > b.maxZ + 1 || b.minZ > a.maxZ + 1) continue;
      const line = sharedBorder(dists[i].geometry.footprint, dists[j].geometry.footprint, 1)[0];
      // A shorter border (down to four road widths) is a spare: only to give a district that
      // would otherwise be a leaf its second link.
      if (!line || lineLength(line) < 4 * s.roadWidth) continue;
      const mid = pointAlong(line, lineLength(line) / 2);
      cands.push({ a: i, b: j, kind: 'border', line, spare: lineLength(line) < minBorder, cost: estimate(centres[i], mid) + estimate(mid, centres[j]) });
    }
    // River links: districts facing each other across the river, joined by the shortest bridge
    // between their banks that crosses only river.
    if (river) {
      const rfp = river.geometry.footprint;
      const riverWidth = (2 * area(rfp)) / Math.max(1, rfp.flat().reduce((t, r) => t + lineLength([...r, r[0]]), 0));
      const banks = dists.map(d => sharedBorder(d.geometry.footprint, rfp, 1).flatMap(l => {
        const L = lineLength(l), out: Point2[] = [];
        for (let t = s.usableWidth; t <= L - s.usableWidth; t += g.cell / 2) out.push(pointAlong(l, t));
        return out;
      }));
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        if (!banks[i].length || !banks[j].length) continue;
        let best: [Point2, Point2] | null = null, bd = 4 * riverWidth;
        for (const p of banks[i]) for (const q of banks[j]) {
          const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d >= bd) continue;
          // Only river between: three points along it are all in the river.
          if (![0.25, 0.5, 0.75].every(t => containsPoint(rfp, [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]))) continue;
          bd = d; best = [p, q];
        }
        if (best) cands.push({ a: i, b: j, kind: 'river', bridge: best, cost: estimate(centres[i], best[0]) + estimate(best[0], best[1]) + estimate(best[1], centres[j]) });
      }
    }
    // A road through Undeveloped land is only for passing through: links touching it cost more
    // (WILD_LINK), so the tree goes round where it reasonably can (at 1× a tenth of the network
    // ran through the wilds).
    for (const c of cands) if (!developed[c.a] || !developed[c.b]) c.cost *= WILD_LINK;
    // Exit links: developed districts with enough land on the site edge.
    const siteFp = tree.geometry.footprint;
    for (let i = 0; i < n; i++) {
      if (!developed[i]) continue;
      const line = sharedBorder(dists[i].geometry.footprint, siteFp, 1).find(l => lineLength(l) >= minBorder);
      if (!line) continue;
      const mid = pointAlong(line, lineLength(line) / 2);
      cands.push({ a: i, b: n, kind: 'exit', line, cost: estimate(centres[i], mid) });
    }
    // Exits spread along the boundary: the cheapest first, then each farthest (around the
    // perimeter) from those already in the order.
    const ring = siteFp[0][0], ringLen = lineLength([...ring, ring[0]]);
    const perimPos = (p: Point2) => {
      let run = 0, best = 0, bd = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
        const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (L * L))) : 0;
        const d = Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz);
        if (d < bd) { bd = d; best = run + t * L; }
        run += L;
      }
      return best;
    };
    const exitCands = cands.map((c, i) => i).filter(i => cands[i].kind === 'exit');
    const exitPos = new Map(exitCands.map(i => [i, perimPos(pointAlong(cands[i].line!, lineLength(cands[i].line!) / 2))]));
    const exitOrder: number[] = [];
    {
      const left = [...exitCands].sort((x, y) => cands[x].cost - cands[y].cost);
      while (left.length) {
        let pick = 0;
        if (exitOrder.length) {
          let far = -1;
          left.forEach((c, k) => {
            const d = Math.min(...exitOrder.map(o => { const dd = Math.abs(exitPos.get(c)! - exitPos.get(o)!); return Math.min(dd, ringLen - dd); }));
            if (d > far) { far = d; pick = k; }
          });
        }
        exitOrder.push(left.splice(pick, 1)[0]);
      }
    }

    // 3. Links and their gateways. Gateways are placed as links are chosen (tree, exits, no-leaf
    //    links, loops), each the spacing from its districts' other gateways where possible.
    /** `normal`: the shared border's normal there (either way), when placement gave one */
    interface Gateway { at: Point2; cand: number; exit: boolean; normal?: Point2 }
    const gates: Gateway[][] = dists.map(() => []);
    let crowded = 0;
    const gradeAtP = (p: Point2) => gradeAt(cellOf(g, p[0], p[1]));
    const links = chooseLinks(n, developed, cands, {
      exits: s.exits, redundancy: s.redundancy, exitOrder,
      place(ci, required) {
        const c = cands[ci];
        if (gates[c.a].some(x => x.cand === ci)) return true; // placed already
        const on = c.b === n ? [c.a] : [c.a, c.b];
        const avoid = on.flatMap(k => gates[k].map(x => x.at));
        if (c.kind === 'river') {
          const [p, q] = c.bridge!;
          const tight = gates[c.a].some(x => Math.hypot(x.at[0] - p[0], x.at[1] - p[1]) < s.spacing) || gates[c.b].some(x => Math.hypot(x.at[0] - q[0], x.at[1] - q[1]) < s.spacing);
          if (tight && !required) return false;
          if (tight) crowded++;
          gates[c.a].push({ at: p, cand: ci, exit: false });
          gates[c.b].push({ at: q, cand: ci, exit: false });
          return true;
        }
        // Exits also keep the spacing from each other, along the whole edge.
        const others = c.kind === 'exit' ? gates.flat().filter(x => x.exit).map(x => x.at) : [];
        const line = c.line!, L = lineLength(line);
        const placed = placeOnBorder(line, {
          margin: Math.min(s.usableWidth, (L - s.roadWidth) / 2), avoid: [...avoid, ...others], minGap: s.spacing, straight: 2 * s.roadWidth,
          // Flat ground, and towards the border's middle.
          score: p => gradeAtP(p) / params.maxGrade + Math.abs(perimOn(line, p) - L / 2) / L,
        });
        if (!placed || (placed.crowded && !required)) return false;
        if (placed.crowded) crowded++;
        // A crowded gateway on the very spot of another is the same gateway (a junction): one
        // gateway twice was paired twice, and two roads came in along the same stub.
        for (const k of on) if (!gates[k].some(x => Math.hypot(x.at[0] - placed.at[0], x.at[1] - placed.at[1]) < 2 * s.roadWidth)) gates[k].push({ at: placed.at, cand: ci, exit: c.kind === 'exit', normal: placed.normal });
        return true;
      },
    });

    // Links dropped after placing (to avoid a district with one link) take their gateways along.
    {
      const kept = new Set(links.chosen);
      for (let k = 0; k < n; k++) gates[k] = gates[k].filter(x => kept.has(x.cand));
    }
    // 4. Roads inside each district.
    const roads: Road[] = [];
    // A path runs through cell centres, so "on" a border it can be most of a cell beside it,
    // leaving a strip of district too thin to use. Points running along a border move onto it.
    const onBorder = Math.max(s.roadWidth / 2, 0.75 * cellM);
    const snap = (points: Point2[], from: number): Point2[] => {
      const out: Point2[] = points.map((p, i) => {
        if (i < Math.max(1, from) || i >= points.length - 1) return p;
        const c = cellOf(g, p[0], p[1]);
        if (g.border[c] > onBorder) return p;
        // Not onto a border a road already runs along: two roads would lie on top of each other.
        if (g.road[c] <= onBorder) return p;
        const a = points[i - 1], b = points[i + 1];
        const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (Math.abs(Math.cos(heading - g.borderNormal[c])) > 0.5) return p; // crossing it
        return [g.borderFootX[c], g.borderFootZ[c]];
      });
      return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1);
    };
    // Ids from a counter, so they never repeat.
    let nextId = 0;
    // `keep`: the road's first segment (and its last, for 'both') is a square stub out of a
    // gateway and isn't smoothed: simplifying dropped the stub's end and the curve began at the
    // border.
    const lay = (raw0: Point2[], exit: boolean, required: boolean, how: Road['how'], smooth = true, keep: 'none' | 'start' | 'both' = 'none') => {
      // An exit road runs from the site edge inward.
      const flip = exit && edgeDist(raw0[raw0.length - 1]) < 1 && edgeDist(raw0[0]) >= 1;
      const raw = flip ? [...raw0].reverse() : raw0;
      const kept = flip ? (keep === 'start' ? 'end' : keep) : keep;
      const head = (kept === 'start' || kept === 'both') && raw.length > 2 ? 1 : 0;
      const tail = (kept === 'end' || kept === 'both') && raw.length > 2 + head ? 1 : 0;
      const mid = raw.slice(head, raw.length - tail);
      const points = smooth ? snap(mid, 0) : mid;
      // Unsmoothed roads (border roads, bridges) still lose tiny jags (half a road width), which
      // otherwise cap the curve radius at the corners.
      const line = [...raw.slice(0, head), ...smoothRoad(points, s.curveRadius, smooth ? 0.6 * cellM : s.roadWidth / 2), ...raw.slice(raw.length - tail)];
      roads.push({ id: `road:${nextId++}`, points: line, exit, required, how });
      markRoad(g, line);
    };
    const meets = (p: Point2, r: Road) => r.points.some((a, i) => {
      if (i + 1 >= r.points.length) return false;
      const b = r.points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0;
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz) < s.roadWidth;
    });
    const onRoad = (c: number) => g.road[c] <= Math.max(s.roadWidth / 2, 0.75 * g.cell);
    // A route aimed at a road stops in a cell beside it: finish on the nearest point of a road.
    const joinTo = (path: Point2[], rs: Road[]): Point2[] => {
      const end = path[path.length - 1];
      let best: Point2 | null = null, bd = Infinity;
      for (const r of rs) for (let i = 0; i + 1 < r.points.length; i++) {
        const a = r.points[i], b = r.points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
        const t = L ? Math.max(0, Math.min(1, ((end[0] - a[0]) * dx + (end[1] - a[1]) * dz) / L)) : 0;
        const q: Point2 = [a[0] + t * dx, a[1] + t * dz], d = Math.hypot(end[0] - q[0], end[1] - q[1]);
        if (d < bd) { bd = d; best = q; }
      }
      if (!best || bd <= 1 || bd >= 2 * g.cell) return path;
      // The nearest road point can be behind the last cell: replace cells rather than double
      // back (a hairpin at the junction).
      const out = [...path];
      const back = (q: Point2) => {
        if (out.length < 2) return false;
        const a = out[out.length - 2], b = out[out.length - 1];
        return (b[0] - a[0]) * (q[0] - b[0]) + (b[1] - a[1]) * (q[1] - b[1]) < 0;
      };
      while (out.length > 2 && back(best)) out.pop();
      return [...out, best];
    };
    // Bridges first: each joins its two bank gateways straight across.
    for (const ci of links.chosen) {
      const c = cands[ci];
      if (c.kind === 'river') lay([c.bridge![0], c.bridge![1]], false, links.tree.has(ci), 'bridge', false);
    }
    const inwardOf = (k: number, at: Point2, normal?: Point2): Point2 => {
      // Into district k, square to its border at `at`: the shared border's normal where placement
      // gave one, else the normal of the nearest boundary segment. Its side is tested a few metres
      // out: a longer probe near a corner landed in the district from the wrong side, and both
      // districts' stubs pointed the same way.
      const probe = 5;
      if (normal) return containsPoint(dists[k].geometry.footprint, [at[0] + normal[0] * probe, at[1] + normal[1] * probe]) ? normal : [-normal[0], -normal[1]];
      let best: Point2 = [0, 1], bd = Infinity;
      for (const r of dists[k].geometry.footprint.flat()) for (let i = 0; i < r.length; i++) {
        const a = r[i], b = r[(i + 1) % r.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
        if (L < 1e-9) continue;
        const t = Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dz) / (L * L)));
        const d = Math.hypot(at[0] - a[0] - t * dx, at[1] - a[1] - t * dz);
        if (d < bd) { bd = d; best = [-dz / L, dx / L]; }
      }
      return containsPoint(dists[k].geometry.footprint, [at[0] + best[0] * probe, at[1] + best[1] * probe]) ? best : [-best[0], -best[1]];
    };
    // A route that turns more than 270° all told has looped: cheaper, by the costs, than a tight
    // turn beside a bank, but no road does that. The next, freer try is taken instead.
    const loops = (p: Point2[]) => {
      let net = 0;
      for (let i = 1; i + 1 < p.length; i++) {
        let d = Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]) - Math.atan2(p[i][1] - p[i - 1][1], p[i][0] - p[i - 1][0]);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        net += d;
        if (Math.abs(net) > 1.5 * Math.PI) return true;
      }
      return false;
    };
    // A route crossing itself closes a loop of one road (two did, at 30 km).
    const selfCrossing = (p: Point2[]) => junctions(p, [], 1).length > 0;
    // A single turn over 120° (a U-turn onto a stub, or into the gateway at the end).
    const sharp = (p: Point2[]) => {
      for (let i = 1; i + 1 < p.length; i++) {
        const ux = p[i][0] - p[i - 1][0], uz = p[i][1] - p[i - 1][1], vx = p[i + 1][0] - p[i][0], vz = p[i + 1][1] - p[i][1];
        const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
        if (lu > 1e-6 && lv > 1e-6 && (ux * vx + uz * vz) / (lu * lv) < -0.5) return true;
      }
      return false;
    };
    // Most of the line already lies on a placed road (the neighbouring district laid a border
    // road along the same border): don't lay it again on top.
    const overlap = (line: Point2[]) => {
      let on = 0, all = 0;
      for (let v = 0; v + 1 < line.length; v++) {
        const L = Math.hypot(line[v + 1][0] - line[v][0], line[v + 1][1] - line[v][1]), m = Math.max(1, Math.ceil(L / 25));
        for (let q = 0; q < m; q++) {
          const p: Point2 = [line[v][0] + (line[v + 1][0] - line[v][0]) * (q + 0.5) / m, line[v][1] + (line[v + 1][1] - line[v][1]) * (q + 0.5) / m];
          all++;
          if (roads.some(r => meets(p, r))) on++;
        }
      }
      return { metres: on * 25, share: all ? on / all : 0 };
    };
    const covered = (line: Point2[]) => overlap(line).share > 0.5;
    // The stretches of a line no placed road runs along, each reaching a road width onto the
    // covered part at either end so it meets the road there.
    const samples = (line: Point2[], step: number) => { const L = lineLength(line), m = Math.max(1, Math.ceil(L / step)); return Array.from({ length: m + 1 }, (_, q) => pointAt(line, (q * L) / m)); };
    const uncovered = (line: Point2[]): Point2[][] => {
      const L = lineLength(line), step = 25, n = Math.max(1, Math.ceil(L / step));
      const free = Array.from({ length: n }, (_, q) => { const p = pointAt(line, ((q + 0.5) * L) / n); return !roads.some(r => meets(p, r)); });
      const out: Point2[][] = [];
      for (let q = 0; q < n;) {
        if (!free[q]) { q++; continue; }
        let e = q;
        while (e < n && free[e]) e++;
        const from = Math.max(0, (q * L) / n - s.roadWidth), to = Math.min(L, (e * L) / n + s.roadWidth);
        // Not a corner the road already rounds: a border has sharp corners, the road a curve of
        // the Curve radius, so the corner looked uncovered and a tiny duplicate was laid across it
        // (a hook, and a dead end once the road was trimmed). Any stretch staying that close to a
        // road would run beside it anyway.
        const gap = slice(line, from, to);
        const beside = samples(gap, step).every(p => roads.some(r => project(r.points, p).d < s.curveRadius));
        if (to - from > s.roadWidth && !beside) out.push(gap);
        q = e;
      }
      return out;
    };
    const STUB = 2.5; // cells a road runs square from a gateway before routing freely
    let unreachable = 0, through = 0, borderRoads = 0, directs = 0, tees = 0, stars = 0, forks = 0, askew = 0, merged = 0;
    const cellsOf = (r: Road) => {
      const out = new Set<number>();
      for (let i = 0; i + 1 < r.points.length; i++) {
        const [a, b] = [r.points[i], r.points[i + 1]];
        const m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g.cell / 2)));
        for (let q = 0; q <= m; q++) out.add(cellOf(g, a[0] + (b[0] - a[0]) * q / m, a[1] + (b[1] - a[1]) * q / m));
      }
      return out;
    };
    // Each district's own roads, so its gateways can be checked for being joined up inside it.
    const ownRoads: Road[][] = dists.map(() => []);
    const lateTees: (() => void)[] = [];
    for (let k = 0; k < n; k++) {
      const gs = gates[k];
      if (!gs.length) continue;
      const first = roads.length;
      const fp = dists[k].geometry.footprint;
      const outer = fp[0][0];
      const perimeter = lineLength([...outer, outer[0]]);
      const gateInfo = gs.map(x => ({ at: x.at, perim: perimOn([...outer, outer[0]], x.at), inward: inwardOf(k, x.at, x.normal) }));
      const allow = (c: number) => masks[k].out.has(c);
      const isExit = (i: number) => gs[i].exit;
      // Route from gateway i: square out of the border for a stub when the goal is well ahead,
      // else free (a stub aimed away from a nearby goal made the road loop back on itself).
      // Inside the district first; if that fails, anywhere.
      // A goal of "any road" gets no guide point: aiming at the centre sent tees the long way round.
      const routeBetween = (i: number, goal: { cell: number } | { touches: (c: number) => boolean }, aim?: Point2, guide = true, goalHeading?: number, finish?: Point2) => {
        const x = gateInfo[i];
        const ahead = aim ? (aim[0] - x.at[0]) * x.inward[0] + (aim[1] - x.at[1]) * x.inward[1] : Infinity;
        const square = ahead > (STUB + 3) * g.cell || isExit(i);
        // The square stub is laid exactly along the gateway's normal (the router's 16 headings
        // were up to 13° off), and the route carries on from its end, heading the same way.
        const stubEnd: Point2 = [x.at[0] + x.inward[0] * STUB * g.cell, x.at[1] + x.inward[1] * STUB * g.cell];
        const tries: [Point2, Parameters<typeof route>[2]][] = [
          ...(square && usable(cellOf(g, stubEnd[0], stubEnd[1])) ? [
            [stubEnd, { params, maxTurn, allow, startHeading: Math.atan2(x.inward[1], x.inward[0]), goal, goalHeading, toward: guide ? aim : undefined }],
            [stubEnd, { params, maxTurn, allow, startHeading: Math.atan2(x.inward[1], x.inward[0]), goal, toward: guide ? aim : undefined }],
          ] as [Point2, Parameters<typeof route>[2]][] : []),
          [x.at, { params, maxTurn, allow, goal, goalHeading, toward: guide ? aim : undefined }],
          [x.at, { params, maxTurn, goal, goalHeading, toward: guide ? aim : undefined }],
          // Last: the router's looser turn limit (two sectors a step), anywhere.
          [x.at, { params, maxTurn: 2, goal, toward: guide ? aim : undefined }],
        ];
        for (const [from, t] of tries) {
          const path = route(g, from, t);
          if (!path || path.length < 2) continue;
          // After a stub, skip route points not past its end (the route starts at its cell's
          // centre, which can be behind it: a back-and-forth kink).
          const past = (q: Point2) => (q[0] - stubEnd[0]) * x.inward[0] + (q[1] - stubEnd[1]) * x.inward[1] > 1;
          const rest = path.slice(1);
          // An exit always leaves square-on: even a route that didn't start from the stub gets it.
          const stubbed = from !== x.at || (isExit(i) && usable(cellOf(g, stubEnd[0], stubEnd[1])));
          while (stubbed && rest.length > 1 && !past(rest[0])) rest.shift();
          const full: Point2[] = stubbed ? [x.at, stubEnd, ...rest] : [x.at, ...rest];
          // Sharpness is judged on the road as laid too: a route curling round over a few grid
          // steps passed (each step under 120°), and simplifying it left one 134° hairpin.
          const ends = finish ? [...full, finish] : full;
          if (!loops(full) && !selfCrossing(full) && !sharp(ends) && !sharp(simplifyLine(ends, 0.6 * cellM))) return full;
        }
        return null;
      };
      // The border from gateway i forward (the ring's direction) to gateway j. Pairing joins
      // perimeter neighbours (i then j), so this stretch holds no other gateway. The shorter way
      // round could run past one, putting that gateway on the road.
      const ringC = [...outer, outer[0]];
      const vs: { at: number; p: Point2 }[] = [];
      {
        let run = 0;
        for (let v = 0; v + 1 < ringC.length; v++) { vs.push({ at: run, p: ringC[v] }); run += Math.hypot(ringC[v + 1][0] - ringC[v][0], ringC[v + 1][1] - ringC[v][1]); }
      }
      const borderBetween = (i: number, j: number): Point2[] => {
        const a = gateInfo[i].perim, b = gateInfo[j].perim;
        const mid = a <= b ? vs.filter(v => v.at > a && v.at < b) : [...vs.filter(v => v.at > a), ...vs.filter(v => v.at < b)];
        return [gateInfo[i].at, ...mid.map(v => v.p), gateInfo[j].at];
      };
      const eligible = (i: number, j: number) => {
        if (!developed[k] || isExit(i) || isExit(j)) return false;
        const line = borderBetween(i, j);
        if (lineLength(line) > perimeter / 2) return false;
        // Every corner (after the jags go) must take a curve of the Curve radius: a border road
        // takes the district's corners as they come, and a corner its neighbouring stretches are
        // too short for showed up as a tight curve. And never along water or the site edge.
        const simple = simplifyLine(line, s.roadWidth / 2);
        for (let v = 1; v + 1 < simple.length; v++) {
          const [p0, p1, p2] = [simple[v - 1], simple[v], simple[v + 1]];
          const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
          let d = Math.abs(Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) - Math.atan2(p1[1] - p0[1], p1[0] - p0[0]));
          if (d > Math.PI) d = 2 * Math.PI - d;
          if (d > Math.PI - (s.junctionAngle * Math.PI) / 180 + 1e-6 || s.curveRadius * Math.tan(d / 2) > Math.min(l1, l2) / 2) return false;
        }
        for (let v = 0; v + 1 < line.length; v++) if (wetSide(line[v], line[v + 1]) || (onSiteEdge(line[v]) && onSiteEdge(line[v + 1]))) return false;
        return true;
      };
      const star = developed[k] && (dists[k].attrs.anchor === 'main' || dists[k].attrs.anchor === 'minor');
      const pr = pairGateways(gateInfo, centres[k], perimeter, { borderShare: developed[k] ? s.borderRoads : 0, eligible, rng, star });
      const req = (i: number) => links.tree.has(gs[i].cand);
      // Gateways that already have a road in this district. Two can coincide (two links meeting
      // at one border point); a second road out of the same point ran beside the first for
      // kilometres, so the other end of that pair joins the nearest road instead (a fork).
      const used: Point2[] = [];
      const isUsed = (i: number) => used.some(p => Math.hypot(p[0] - gateInfo[i].at[0], p[1] - gateInfo[i].at[1]) < 2 * s.roadWidth);
      const markUsed = (...is: number[]) => { for (const i of is) used.push(gateInfo[i].at); };
      for (const [i, j] of pr.border) {
        const line = borderBetween(i, j), o = overlap(line);
        // Mostly on a road already: lay only the stretches that aren't. Skipping it whole left a
        // gateway with a dead end where the neighbour's border road stopped 300 m short of it.
        if (o.share > 0.5) {
          for (const gap of uncovered(line)) { lay(gap, false, req(i) || req(j), 'border', false); borderRoads++; }
          markUsed(i, j);
          continue;
        }
        // Partly on a road already (the neighbour's border road, or a through road along this
        // border): route it across the district instead.
        if (o.metres > s.usableWidth) { pr.through.push([i, j]); continue; }
        lay(line, false, req(i) || req(j), 'border', false);
        markUsed(i, j);
        borderRoads++;
      }
      // A through road meeting a neighbour's road head-on at a gateway, but running beside it on
      // the way there (both districts' other gateways lay the same way, so each ran along its side
      // of the border for a kilometre or more): join the neighbour's road where they come close
      // instead, and cut its stretch beyond the junction (it only led to the gateway). The owner
      // doesn't want two arterials running parallel. Checked at both ends of the road.
      const mergeParallel = (line: Point2[], i: number, j: number): boolean => {
        const ends = ([[i, j], [j, i]] as const).map(([from, to]) => {
          const G = gateInfo[to].at;
          const atG = (p: Point2) => Math.hypot(p[0] - G[0], p[1] - G[1]) < 2 * s.roadWidth;
          const R = roads.find(r => r.how !== 'bridge' && !ownRoads[k].includes(r) && (atG(r.points[0]) || atG(r.points[r.points.length - 1])));
          if (!R || isExit(from) || isExit(to)) return null;
          // The run beside R (within two Usable widths: 370 m apart still read as parallel to the
          // owner), walking back from G past the stubs (both roads must converge there).
          const ours = to === j ? line : [...line].reverse();
          const L = lineLength(ours), step = 25;
          let run = 0, best = 0;
          for (let d = (2 * STUB) * g.cell; d < L; d += step) {
            if (project(R.points, pointAt(ours, L - d)).d < 2 * s.usableWidth) { run += step; best = Math.max(best, run); } else run = 0;
          }
          return best > s.usableWidth ? { from, G, atG, R, best } : null;
        }).filter(e => e !== null).sort((a, b) => b.best - a.best);
        // A road can merge at one end only (it starts from a gateway): the longer run beside goes
        // first. Merging whichever end came first left a 1.7 km run at the other.
        for (const { from, G, atG, R } of ends) {
          // R's tail: from its last junction to G. Only that stretch may be cut.
          const rEnd = atG(R.points[R.points.length - 1]);
          const rLine = rEnd ? R.points : [...R.points].reverse();
          const rL = lineLength(rLine);
          const js = junctions(rLine, roads.filter(o => o !== R).map(o => o.points), s.roadWidth);
          const tailFrom = js.length ? js[js.length - 1] + s.roadWidth : 0;
          const tailCells = new Set<number>();
          for (let d = tailFrom; d <= rL; d += g.cell / 2) { const p = pointAt(rLine, d); tailCells.add(cellOf(g, p[0], p[1])); }
          const path = routeBetween(from, { touches: c => tailCells.has(c) }, G, false);
          if (!path) continue;
          const joined = joinTo(path, [R]);
          const T = joined[joined.length - 1], at = project(rLine, T).at;
          if (at < tailFrom - s.roadWidth || at < 1) continue;
          const kept = slice(rLine, 0, at);
          R.points = rEnd ? kept : [...kept].reverse();
          // The grid still held the cut stretch: a later tee aimed at it and ended in open ground.
          remarkRoads(g, roads.map(r => r.points));
          lay(joined, isExit(from), req(i) || req(j), 'through', true, 'start');
          return true;
        }
        return false;
      };
      for (const [i, j] of pr.through) {
        if (isUsed(i) || isUsed(j)) {
          if (!isUsed(j)) pr.tees.push(j);
          else if (!isUsed(i)) pr.tees.push(i);
          forks++;
          continue;
        }
        markUsed(i, j);
        const a = gateInfo[i].at, b = gateInfo[j].at, gap = Math.hypot(a[0] - b[0], a[1] - b[1]);
        // Gateways too close for two square stubs and a turn between them, or with no route that
        // doesn't loop: join them directly, straight if that stays in the district, else along
        // the border the shorter way round (never along water).
        const direct = () => {
          // Straight over land (it may clip a neighbouring district: it's short).
          const steps = Math.max(2, Math.ceil(gap / (g.cell / 2)));
          const straight = Array.from({ length: steps - 1 }, (_, q) => (q + 1) / steps).every(t => { const c = cellOf(g, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); return usable(c); });
          const fwd = borderBetween(i, j), back = borderBetween(j, i);
          const line = straight ? [a, b] : lineLength(fwd) <= lineLength(back) ? fwd : back;
          if (line.slice(1).some((q, v) => wetSide(line[v], q))) return false;
          if (covered(line)) return true;
          lay(line, isExit(i) || isExit(j), req(i) || req(j), 'direct', false);
          directs++;
          return true;
        };
        // Not first for an exit: it must leave the site square-on.
        if (gap < (2 * STUB + 4) * g.cell && !isExit(i) && !isExit(j) && direct()) continue;
        // Aim a stub's length inside gateway j, shortened where that lands off usable ground (in a
        // pond behind a bridge's bank, the route had no goal at all and the road wasn't laid).
        const gj = gateInfo[j];
        let stub = STUB;
        while (stub > 0 && !usable(cellOf(g, gj.at[0] + gj.inward[0] * stub * g.cell, gj.at[1] + gj.inward[1] * stub * g.cell))) stub -= 0.5;
        const target: Point2 = [gj.at[0] + gj.inward[0] * stub * g.cell, gj.at[1] + gj.inward[1] * stub * g.cell];
        // Arrive heading into gateway j, so the stub into it carries straight on.
        let path = stub > 0 ? routeBetween(i, { cell: cellOf(g, target[0], target[1]) }, target, true, Math.atan2(-gj.inward[1], -gj.inward[0]), gj.at) : null;
        if (path) {
          // Finish along gateway j's exact stub: the route ends at the target cell's centre.
          // Laid from its square end: `keep` holds that end's stub unsmoothed (both ends, normally).
          let line = [...path.slice(0, -1), target, gj.at];
          let keep: 'start' | 'both' = 'both', [a0, b0] = [i, j];
          // Arriving square can cost a detour: in a district too tight to turn in, the road
          // swung right round (a C 3.2× the gap, a hook 2.3×) to come into the gateway square.
          // Then try arriving at an angle, from either end, and take it if it's much shorter.
          // Never into a bridge: a road meets a deck square.
          if (lineLength(line) > DETOUR * gap) {
            const bridgeEnd = (x: number) => cands[gs[x].cand]?.kind === 'river';
            let best: { line: Point2[]; from: number; to: number } | null = null;
            for (const [from, to] of [[i, j], [j, i]] as const) {
              if (bridgeEnd(to) || isExit(to)) continue;
              const at = gateInfo[to].at, p = routeBetween(from, { cell: cellOf(g, at[0], at[1]) }, at, true);
              if (p && (!best || lineLength(p) + 1 < lineLength(best.line))) best = { line: [...p.slice(0, -1), at], from, to };
            }
            if (best && lineLength(best.line) < 0.75 * lineLength(line)) { line = best.line; [a0, b0] = [best.from, best.to]; keep = 'start'; askew++; }
          }
          if (mergeParallel(line, a0, b0)) { through++; merged++; continue; }
          lay(line, isExit(i) || isExit(j), req(i) || req(j), 'through', true, keep);
          through++;
          continue;
        }
        if (gap < s.spacing && direct()) continue;
        // No square approach (a gateway by the site edge, among hills: every route came at it
        // from behind, a U-turn): route to the gateway itself and arrive at an angle. Leaving the
        // road out left dead ends on both sides of the gateway.
        path = routeBetween(i, { cell: cellOf(g, gj.at[0], gj.at[1]) }, gj.at, true);
        if (!path) { unreachable++; continue; }
        lay([...path.slice(0, -1), gj.at], isExit(i) || isExit(j), req(i) || req(j), 'through', true, 'start');
        through++;
        askew++;
      }
      // Spokes to a town centre: the first reaches the centre; each later one joins the centre
      // or a spoke already laid, whichever comes first. Routed separately they converged on the
      // same corridor and lay on top of each other for kilometres.
      const spokes: Road[] = [];
      const centreCell = cellOf(g, centres[k][0], centres[k][1]);
      const spokeCells = new Set<number>();
      for (const i of pr.star) {
        if (isUsed(i)) continue;
        const nearGate = (c: number) => { const [cx, cz] = centreOf(g, c); return Math.hypot(cx - gateInfo[i].at[0], cz - gateInfo[i].at[1]) < 3 * g.cell; };
        // Any road already in the district counts too (a border road can pass the centre).
        const own = roads.filter(r => cellsOf(r).has(centreCell) || spokes.includes(r) || (r.how === 'border' && [...cellsOf(r)].some(c => masks[k].own.has(c))));
        const ownCells = new Set([...spokeCells, ...own.flatMap(r => [...cellsOf(r)])]);
        const goal = ownCells.size ? { touches: (c: number) => c === centreCell || (ownCells.has(c) && !nearGate(c)) } : { cell: centreCell };
        let path = routeBetween(i, goal, centres[k]);
        if (!path) { unreachable++; continue; }
        if (own.length) path = joinTo(path, own);
        lay(path, isExit(i), req(i), 'star', true, 'start');
        markUsed(i);
        const laid = roads[roads.length - 1];
        spokes.push(laid);
        for (const c of cellsOf(laid)) spokeCells.add(c);
        stars++;
      }
      // A later spoke joining the first short of the centre leaves the first's last stretch a
      // stub: cut it back to the farthest joint along it, unless something else meets its end.
      if (spokes.length >= 2) {
        const first = spokes[0], end = first.points[first.points.length - 1];
        if (!roads.some(r => r !== first && meets(end, r))) {
          let cut = -1, cutAt: Point2 | null = null;
          for (const sp of spokes.slice(1)) {
            const j = sp.points[sp.points.length - 1];
            const at = perimOn(first.points, j);
            if (at > cut) { cut = at; cutAt = j; }
          }
          if (cutAt && cut > 0) {
            const kept: Point2[] = [];
            let run = 0;
            for (let v = 0; v < first.points.length; v++) {
              if (v > 0) run += Math.hypot(first.points[v][0] - first.points[v - 1][0], first.points[v][1] - first.points[v - 1][1]);
              if (run >= cut) break;
              kept.push(first.points[v]);
            }
            first.points = [...kept, cutAt];
          }
        }
      }
      ownRoads[k].push(...roads.slice(first));
      // Tees join a road in their district once every district's roads are down.
      for (const i of pr.tees) lateTees.push(() => {
        // A road already runs through this gateway (a border road past it): nothing to join.
        // Not one that merely ends here: that's the neighbour's road, waiting for this one.
        const at = gateInfo[i].at;
        const endsHere = (r: Road) => [r.points[0], r.points[r.points.length - 1]].some(p => Math.hypot(p[0] - at[0], p[1] - at[1]) < 2 * s.roadWidth);
        if (roads.some(r => meets(at, r) && !endsHere(r))) return;
        // This district already has a road out of this point (a coincident gateway).
        if (isUsed(i)) return;
        // Any road counts, in this district or not: a tee that may only join its own district's
        // roads crossed a neighbour's road to reach one just beyond it, closing a small ring.
        // Except a road ending at this same gateway (the neighbour's, waiting for this one):
        // joining it anywhere closes a ring back through the gateway, as big as how far along it
        // joins. It was excluded only within 3 cells, and tees joined it 300 m out instead.
        const thr = Math.max(s.roadWidth / 2, 0.75 * g.cell);
        const dist = (p: Point2, rs: Road[]) => Math.min(Infinity, ...rs.flatMap(r => r.points.slice(1).map((q, j) => segDist(p, r.points[j], q))));
        const enders = roads.filter(endsHere), others = roads.filter(r => !endsHere(r));
        const ownEnd = (c: number) => {
          const p = centreOf(g, c);
          return dist(p, enders) <= thr && dist(p, others) > thr;
        };
        const path = routeBetween(i, { touches: c => onRoad(c) && !ownEnd(c) }, centres[k], false);
        if (!path) { unreachable++; return; }
        lay(joinTo(path, roads), isExit(i), req(i), 'tee', true, 'start');
        ownRoads[k].push(roads[roads.length - 1]);
        tees++;
      });
    }
    for (const t of lateTees) t();
    // Join up each district's roads: two through roads that don't cross leave its gateways in
    // separate pieces, and the tree only links districts, so the network would split there.
    let joins = 0;
    for (let k = 0; k < n; k++) {
      for (let guard = 0; guard < 6; guard++) {
        const rs = ownRoads[k];
        if (rs.length < 2) break;
        const parent = rs.map((_, i) => i);
        const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
        // Touching is tested on the lines, not on shared cells: two roads crossing at a slant can
        // pass between each other's sampled cells, and a join then closed a needless triangle.
        for (let a = 0; a < rs.length; a++) for (let b = a + 1; b < rs.length; b++) {
          if (roadsTouch(rs[a], rs[b], s.roadWidth)) parent[find(a)] = find(b);
        }
        // A neighbour's road touching two pieces joins them too (they meet at a shared gateway, or
        // an earlier join ended on it).
        const touching = (r: Road) => rs.map((_, i) => i).filter(i => roadsTouch(r, rs[i], s.roadWidth));
        const foreign = roads.filter(r => !rs.includes(r)).map(r => ({ r, t: touching(r) })).filter(f => f.t.length);
        for (const f of foreign) for (const i of f.t.slice(1)) parent[find(i)] = find(f.t[0]);
        const groups = new Map<number, number[]>();
        rs.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
        if (groups.size <= 1) break;
        const sorted = [...groups.values()].sort((x, y) => y.length - x.length || x[0] - y[0]);
        // The goal is the main piece and the neighbours' roads touching it: a join that aimed only
        // at this district's own roads crossed a neighbour's road (meeting them at a shared gateway)
        // to reach one just beyond, closing a small ring.
        const inMain = new Set(sorted[0]);
        const mainRoads = [...sorted[0].map(i => rs[i]), ...foreign.filter(f => f.t.some(i => inMain.has(i))).map(f => f.r)];
        const main = new Set(mainRoads.flatMap(r => [...cellsOf(r)]));
        const mainPts = sorted[0].flatMap(i => rs[i].points);
        let start: Point2 | null = null, toward: Point2 | null = null, bd = Infinity;
        for (const i of sorted[1]) for (const p of rs[i].points) for (const q of mainPts) {
          const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d < bd) { bd = d; start = p; toward = q; }
        }
        const allow = (c: number) => masks[k].out.has(c);
        const path = start && (route(g, start, { params, maxTurn, allow, goal: { touches: c => main.has(c) }, toward: toward! }) ?? route(g, start, { params, maxTurn, goal: { touches: c => main.has(c) }, toward: toward! }));
        if (!path || path.length < 2) break;
        lay(joinTo([start!, ...path.slice(1)], mainRoads), false, true, 'join');
        ownRoads[k].push(roads[roads.length - 1]);
        joins++;
      }
    }

    // Open the local loops (2026-11-24-arterial-loops-design.md). The owner wants loops only
    // through several districts: at least LOOP_DISTRICTS. Each that takes in fewer loses one piece
    // of road along its edge (a stretch between junctions), merging it with the area beside it.
    // Joins and tees go first, through roads last; never a bridge or an exit's piece at the site
    // edge, and never a removal that leaves a dead end or splits the network.
    const footprints = dists.map(d => d.geometry.footprint);
    const ORDER: Road['how'][] = ['join', 'tee', 'connector', 'star', 'border', 'direct', 'through'];
    const deadAt = (p: Point2, self: Road, rs: Road[]) => edgeDist(p) >= 1 && !rs.some(o => o !== self && meets(p, o));
    const pieces = (groupsOf: Road[]) => {
      const parent = groupsOf.map((_, i) => i);
      const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
      for (let a = 0; a < groupsOf.length; a++) for (let b = a + 1; b < groupsOf.length; b++) if (roadsTouch(groupsOf[a], groupsOf[b], s.roadWidth)) parent[find(a)] = find(b);
      return new Set(groupsOf.map((_, i) => find(i))).size;
    };
    // Which district each cell's centre is in, so a removal never leaves a district with no road
    // (at 2 km a district's only road was a piece of a local loop).
    const districtOfCell = new Map<number, number>();
    masks.forEach((m, k) => { for (const c of m.own) districtOfCell.set(c, k); });
    const served = (rs: Road[]) => new Set(rs.flatMap(r => [...cellsOf(r)].map(c => districtOfCell.get(c)).filter((k): k is number => k !== undefined)));
    let localLoops = 0, opened = 0;
    type Piece = { r: Road; from: number; to: number };
    for (let guard = 0; guard < 60; guard++) {
      const local = loopsOf(roads.map(r => r.points), s.roadWidth).filter(h => districtsIn(h, footprints, s.usableWidth).length < LOOP_DISTRICTS);
      localLoops = local.length;
      if (!local.length) break;
      const before = pieces(roads), servedBefore = served(roads);
      const cutsOf = new Map<Road, number[]>();
      const cuts = (r: Road) => {
        let c = cutsOf.get(r);
        if (!c) { c = [0, ...junctions(r.points, roads.filter(o => o !== r).map(o => o.points), s.roadWidth), lineLength(r.points)]; cutsOf.set(r, c); }
        return c;
      };
      const removable = (r: Road, from: number, to: number) => {
        if (r.how === 'bridge') return false;
        const L = cuts(r)[cuts(r).length - 1];
        return !((from === 0 && edgeDist(r.points[0]) < 1) || (to === L && edgeDist(r.points[r.points.length - 1]) < 1));
      };
      // Remove a set of pieces (at most one per road), or say why not: the dead ends it leaves.
      const attempt = (set: Piece[]) => {
        const made = new Map<Road, Road[]>();
        for (const c of set) made.set(c.r, cutPiece(c.r.points, c.from, c.to).filter(pt => lineLength(pt) > 1).map(pt => ({ ...c.r, points: pt })));
        const trial = [...roads.filter(r => !made.has(r)), ...[...made.values()].flat()];
        const fresh = new Set([...made.values()].flat());
        // A dead end can only appear at an end that met a removed piece, or at a cut.
        const dead = trial.flatMap(r => [r.points[0], r.points[r.points.length - 1]].map(p => ({ r, p })))
          .filter(e => (fresh.has(e.r) || set.some(c => project(c.r.points, e.p).d < s.roadWidth)) && deadAt(e.p, e.r, trial));
        return { made, trial, dead };
      };
      let done = false;
      for (const h of local) {
        const hb = bounds([[h]]);
        const borders = (r: Road, from: number, to: number) => project([...h, h[0]], pointAt(r.points, (from + to) / 2)).d <= s.roadWidth / 2 + 2;
        const near = roads.filter(r => {
          const rb = r.points.reduce((m, p) => [Math.min(m[0], p[0]), Math.min(m[1], p[1]), Math.max(m[2], p[0]), Math.max(m[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
          return !(rb[0] > hb.maxX + s.roadWidth || rb[2] < hb.minX - s.roadWidth || rb[1] > hb.maxZ + s.roadWidth || rb[3] < hb.minZ - s.roadWidth);
        });
        const cands: Piece[] = [];
        for (const r of near) {
          const c = cuts(r);
          for (let q = 0; q + 1 < c.length; q++) if (removable(r, c[q], c[q + 1]) && borders(r, c[q], c[q + 1])) cands.push({ r, from: c[q], to: c[q + 1] });
        }
        cands.sort((x, y) => ORDER.indexOf(x.r.how) - ORDER.indexOf(y.r.how) || (x.to - x.from) - (y.to - y.from));
        for (const c0 of cands) {
          // Where the loop's edge runs through a point where two roads merely meet end to end (a
          // gateway), removing one side's piece leaves the other's end dangling: take that road's
          // end piece along too, as long as it also borders this loop.
          const set: Piece[] = [c0];
          let res = attempt(set);
          for (let grow = 0; grow < 4 && res.dead.length; grow++) {
            const e = res.dead.find(d => !set.some(c => c.r === d.r) && !res.made.has(d.r));
            if (!e) break;
            const c = cuts(e.r), atStart = Math.hypot(e.p[0] - e.r.points[0][0], e.p[1] - e.r.points[0][1]) < 1e-6;
            const [from, to] = atStart ? [0, c[1]] : [c[c.length - 2], c[c.length - 1]];
            if (!removable(e.r, from, to) || !borders(e.r, from, to)) break;
            set.push({ r: e.r, from, to });
            res = attempt(set);
          }
          if (res.dead.length || pieces(res.trial) > before) continue;
          const servedAfter = served(res.trial);
          if ([...servedBefore].some(k => !servedAfter.has(k))) continue;
          for (const [r, parts] of res.made) roads.splice(roads.indexOf(r), 1, ...parts.map((m, q) => ({ ...m, id: q === 0 ? r.id : `road:${nextId++}` })));
          opened++;
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) break;
    }
    // Bands and their bounds, computed once per road.
    const bandCache = new Map<Road, { band: MultiPolygon; box: ReturnType<typeof bounds> }>();
    const bandInfo = (r: Road) => {
      let b = bandCache.get(r);
      if (!b) { const band = offsetPolyline(r.points, s.roadWidth / 2, 'round'); b = { band, box: bounds(band) }; bandCache.set(r, b); }
      return b;
    };
    const bandOf = (r: Road) => bandInfo(r).band;
    const overlaps = (a: ReturnType<typeof bounds>, b: ReturnType<typeof bounds>) => !(a.minX > b.maxX || a.maxX < b.minX || a.minZ > b.maxZ || a.maxZ < b.minZ);
    const near = (fp: MultiPolygon, rs: Road[]) => { const fb = bounds(fp); return rs.filter(r => overlaps(bandInfo(r).box, fb)); };
    const isThin = (fp: MultiPolygon) => slivers(fp, [], s.usableWidth).length > 0;

    // 5. One network: if a route failed somewhere, join any stray piece to the main one.
    let connectors = 0;
    for (let guard = 0; guard < 10 && roads.length > 1; guard++) {
      const owner = new Map<number, number>();
      const parent = roads.map((_, i) => i);
      const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
      roads.forEach((r, i) => { for (const c of cellsOf(r)) { const o = owner.get(c); if (o === undefined) owner.set(c, i); else parent[find(i)] = find(o); } });
      const groups = new Map<number, number[]>();
      roads.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
      if (groups.size <= 1) break;
      const sorted = [...groups.values()].sort((x, y) => y.length - x.length || x[0] - y[0]);
      const main = new Set(sorted[0].flatMap(i => [...cellsOf(roads[i])]));
      const mainPts = sorted[0].flatMap(i => roads[i].points);
      let start: Point2 | null = null, toward: Point2 | null = null, bd = Infinity;
      for (const i of sorted[1]) for (const p of roads[i].points) for (const q of mainPts) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < bd) { bd = d; start = p; toward = q; }
      }
      const path = start && route(g, start, { params, maxTurn, goal: { touches: c => main.has(c) }, toward: toward! });
      if (!path || path.length < 2) break;
      lay(joinTo(path, sorted[0].map(i => roads[i])), false, true, 'connector');
      connectors++;
    }
    // Trim dead ends: cut each back to its last junction (the owner, 2026-11-24: no dead ends).
    // Rules that each did the right thing left ends hanging between them: a border road ending
    // at a gateway whose neighbour's road was skipped as already covered, an impossible square
    // approach. Never a bridge, never a cut that leaves a district with no road or splits the
    // network. Extending a dead end instead adds road, and could bring back hairpins.
    let trimmed = 0;
    for (let guard = 0; guard < 40; guard++) {
      const before = pieces(roads), servedBefore = served(roads);
      let done = false;
      for (const r of roads) {
        if (r.how === 'bridge') continue;
        for (const atStart of [true, false]) {
          const p = atStart ? r.points[0] : r.points[r.points.length - 1];
          if (!deadAt(p, r, roads)) continue;
          const js = junctions(r.points, roads.filter(o => o !== r).map(o => o.points), s.roadWidth);
          const L = lineLength(r.points);
          // Back to the nearest junction; with none, the whole road goes (its other end then
          // shows up as a dead end on whatever it met, if anything).
          const kept = !js.length ? [] : [atStart ? slice(r.points, js[0], L) : slice(r.points, 0, js[js.length - 1])];
          const trial = [...roads.filter(o => o !== r), ...kept.map(points => ({ ...r, points }))];
          if (pieces(trial) > before) continue;
          const servedAfter = served(trial);
          if ([...servedBefore].some(k => !servedAfter.has(k))) continue;
          roads.splice(roads.indexOf(r), 1, ...kept.map(points => ({ ...r, points })));
          trimmed++;
          done = true;
          break;
        }
        if (done) break;
      }
      if (!done) break;
    }
    if (trimmed) remarkRoads(g, roads.map(r => r.points));
    // Dead ends: road ends that meet no other road and aren't on the site edge. Expected 0.
    let deadEnds = 0;
    for (const r of roads) for (const p of [r.points[0], r.points[r.points.length - 1]]) {
      if (edgeDist(p) < 1 || roads.some(o => o !== r && meets(p, o))) continue;
      deadEnds++;
    }

    // 8. Cut the roads out of the districts and the river. Each road's piece is its band minus
    //    the bands of earlier roads, taken locally (only bands overlapping the region).
    const order = new Map(roads.map((r, i) => [r, i]));
    const cut = (parent: RegionNode, roadKind: string, extra: (i: number) => RegionNode['attrs'], keep: (i: number, piece: MultiPolygon) => MultiPolygon = (_i, p) => p) => {
      const fp = parent.geometry.footprint;
      const local = near(fp, roads).sort((a, b) => order.get(a)! - order.get(b)!);
      const kids: RegionNode[] = [];
      let taken: MultiPolygon = [];
      for (const r of local) {
        const i = order.get(r)!;
        const piece = keep(i, intersect(fp, difference(bandOf(r), taken)));
        taken = union(taken, bandOf(r));
        if (area(piece) <= 0) continue;
        const name = `${roadKind}:${kids.length}`;
        kids.push({ id: childId(parent.id, name), name, kind: roadKind, stage: 'arterials', geometry: makeSlab(piece), attrs: extra(i), children: [] });
      }
      return { kids, covered: union(kids.flatMap(k => k.geometry.footprint), []), localAll: taken };
    };
    let sliverCount = 0;
    for (const d of dists) {
      const fp = d.geometry.footprint;
      const { kids, localAll } = cut(d, 'arterial', i => ({ road: roads[i].id, width: s.roadWidth }));
      difference(fp, localAll).filter(poly => area([poly]) > 0).forEach((poly, k) => {
        const name = `superblock:${k}`;
        kids.push({ id: childId(d.id, name), name, kind: 'superblock', stage: 'arterials', geometry: makeSlab([poly]), attrs: {}, children: [] });
      });
      children.set(d.id, kids);
      if (!isThin(fp) && area(intersect(fp, localAll)) > 1) sliverCount += slivers(fp, localAll, s.usableWidth).length;
    }
    let bridges = 0;
    if (river) {
      // A bridge is where a road's centreline actually crosses the river. A band grazing the
      // bank isn't one: its sliver stays water.
      const rfp = river.geometry.footprint;
      // Sampled every road width: smoothed segments can be kilometres long, and a few samples per
      // segment missed 150 m crossings, leaving them unbridged.
      const crosses = (r: Road) => r.points.some((p, i) => {
        if (containsPoint(rfp, p)) return true;
        if (i + 1 >= r.points.length) return false;
        const q = r.points[i + 1], n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / s.roadWidth);
        for (let k = 1; k < n; k++) if (containsPoint(rfp, [p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n])) return true;
        return false;
      });
      const { kids } = cut(river, 'bridge', i => ({ road: roads[i].id }), (i, piece) => (crosses(roads[i]) ? piece.filter(poly => area([poly]) >= s.roadWidth * s.roadWidth / 2) : []));
      bridges = kids.length;
      if (kids.length) {
        const rest = difference(rfp, union(kids.flatMap(k => k.geometry.footprint), []));
        if (rest.length) kids.push({ id: childId(river.id, 'water:0'), name: 'water:0', kind: 'water', stage: 'arterials', geometry: makeSlab(rest), attrs: {}, children: [] });
        children.set(river.id, kids);
      }
    }

    // 9. Stats.
    let overGrade = 0;
    for (const r of roads) for (let i = 0; i + 1 < r.points.length; i++) {
      const [a, b] = [r.points[i], r.points[i + 1]];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > 0 && Math.abs(groundHeightAt(tree, ...b) - groundHeightAt(tree, ...a)) / d > params.maxGrade) overGrade += d;
    }
    return {
      children,
      data: new Map([[tree.id, {
        roads: roads.map(r => ({ id: r.id, points: r.points, exit: r.exit, how: r.how })),
        stats: {
          districts: n, links: links.chosen.length, tree: links.tree.size,
          loops: links.chosen.filter(i => !links.tree.has(i) && cands[i].kind !== 'exit').length,
          exits: links.chosen.filter(i => cands[i].kind === 'exit').length, bridges,
          gateways: new Set(gates.flat().map(x => `${x.at[0]},${x.at[1]}`)).size,
          throughRoads: through, askew, merged, forks, localLoops, loopsOpened: opened, trimmed, borderRoads, directs, tees, stars, joins, leaves: links.leaves.length, crowded, deadEnds,
          connectors, unreachable,
          tightCurves: roads.reduce((m, r) => m + tightBends(r.points, s.curveRadius), 0),
          slivers: sliverCount, overGrade: Math.round(overGrade), ms: Math.round(performance.now() - t0),
        },
      }]]),
    };
  },
};

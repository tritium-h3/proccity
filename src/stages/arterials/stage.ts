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
import { area, bounds, centroid, containsPoint } from '../../grammar/polygon.js';
import { makeSlab } from '../../grammar/slab.js';
import type { Stage } from '../types.js';
import { BLOCKED, buildGrid, cellOf, centreOf, HILLS, LAND, markRoad, RIVER, stepCost, type CostParams } from './grid.js';
import { placeExits, poissonHubs } from './hubs.js';
import { buildMesh } from './mesh.js';
import { route } from './route.js';
import { smoothRoad, tightBends } from './smooth.js';
import { slivers } from './space.js';

const CELL = 20;            // m: routing grid
const NUDGE = 60;           // m: centres move this far to flatter ground
const MAX_LINK = 1.8;       // × spacing: longest mesh link
const BLOCKED_SHARE = 0.3;  // a link mostly over sea or pond isn't a candidate

interface Road { id: string; points: Point2[]; exit: boolean; required: boolean }

export const arterials: Stage = {
  id: 'arterials',
  title: 'Arterials',
  settings: [
    { key: 'spacing', label: 'Arterial spacing', type: 'number', min: 300, max: 1500, step: 50, default: 700, unit: 'm', help: 'Distance between hubs, and so between arterials' },
    { key: 'redundancy', label: 'Redundancy', type: 'number', min: 0, max: 1, step: 0.05, default: 0.3, help: 'Extra loop links beyond what reaching everywhere needs' },
    { key: 'exits', label: 'Exits', type: 'number', min: 1, max: 8, step: 1, default: 3, help: 'Arterials leading off the site' },
    { key: 'roadWidth', label: 'Road width', type: 'number', min: 15, max: 40, step: 1, default: 25, unit: 'm', help: 'Including verges' },
    { key: 'junctionAngle', label: 'Junction angle', type: 'number', min: 30, max: 90, step: 5, default: 60, unit: '°', help: 'The sharpest angle two arterials may meet at' },
    { key: 'curveRadius', label: 'Curve radius', type: 'number', min: 20, max: 200, step: 10, default: 60, unit: 'm', help: 'The tightest bend an arterial may take' },
    { key: 'maxGrade', label: 'Max grade', type: 'number', min: 2, max: 20, step: 1, default: 8, unit: '%', help: 'Steepest grade an arterial should take (soft)' },
    { key: 'usableWidth', label: 'Usable width', type: 'number', min: 30, max: 150, step: 10, default: 60, unit: 'm', help: 'Narrowest land left between roads, or a road and a district edge' },
  ],

  run({ tree, leaves, settings, rng }) {
    const t0 = performance.now();
    const s = settings as Settings & { spacing: number; redundancy: number; exits: number; roadWidth: number; junctionAngle: number; curveRadius: number; maxGrade: number; usableWidth: number };
    const children = new Map<string, RegionNode[]>();
    const dists = leaves.filter(n => n.kind === 'district');
    if (!dists.length) return { children };
    const params: CostParams = { maxGrade: s.maxGrade / 100, roadWidth: s.roadWidth, usableWidth: s.usableWidth };

    // 1. The grid.
    const terrainKids = tree.children;
    const blocked = terrainKids.filter(n => n.kind === 'sea' || n.kind === 'pond').map(n => n.geometry.footprint);
    const river = terrainKids.find(n => n.kind === 'river');
    const hills = dists.filter(d => d.attrs.terrain === 'hills').map(d => d.geometry.footprint);
    const sb = bounds(tree.geometry.footprint);
    const size = Math.max(sb.maxX - sb.minX, sb.maxZ - sb.minZ);
    const onSiteEdge = (p: Point2) => Math.min(Math.abs(p[0] - sb.minX), Math.abs(p[0] - sb.maxX), Math.abs(p[1] - sb.minZ), Math.abs(p[1] - sb.maxZ)) < 0.5;
    // District borders as corridors, but not the site's own edge: roads shouldn't hug it.
    const borderFps: MultiPolygon[] = dists.map(d => d.geometry.footprint.map(poly => poly.map(ring => ring)));
    const g = buildGrid({
      bounds: { minX: sb.minX, minZ: sb.minZ, size },
      elevAt: (x, z) => groundHeightAt(tree, x, z),
      kindAt: (x, z) => {
        const p: Point2 = [x, z];
        if (!containsPoint(tree.geometry.footprint, p) || blocked.some(b => containsPoint(b, p))) return BLOCKED;
        if (river && containsPoint(river.geometry.footprint, p)) return RIVER;
        return hills.some(h => containsPoint(h, p)) ? HILLS : LAND;
      },
      districts: borderFps,
      river: river?.geometry.footprint,
    }, CELL);
    // Undo the corridor along the site edge (its segments all lie on the boundary).
    for (let c = 0; c < g.w * g.h; c++) {
      const [x, z] = centreOf(g, c);
      if (g.border[c] < s.roadWidth && onSiteEdge([Math.max(sb.minX, Math.min(sb.maxX, x)), Math.max(sb.minZ, Math.min(sb.maxZ, z))]) && Math.min(x - sb.minX, sb.maxX - x, z - sb.minZ, sb.maxZ - z) <= g.border[c] + 1) g.border[c] = Infinity;
    }
    const usable = (c: number) => g.kind[c] === LAND || g.kind[c] === HILLS;
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
    const nudge = (p: Point2): Point2 => {
      let best = -1, bs = Infinity;
      const c0 = cellOf(g, p[0], p[1]), r = Math.ceil(NUDGE / g.cell);
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const i = (c0 % g.w) + di, j = Math.floor(c0 / g.w) + dj;
        if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
        const c = j * g.w + i;
        if (!usable(c)) continue;
        const score = gradeAt(c) + Math.hypot(di, dj) * 0.001;
        if (score < bs) { bs = score; best = c; }
      }
      return best >= 0 ? centreOf(g, best) : p;
    };

    // 2. Hubs: the town centres, then spaced points on usable, not-too-steep ground.
    const fixed = dists.filter(d => d.attrs.anchor === 'main' || d.attrs.anchor === 'minor').map(d => nudge(centroid(d.geometry.footprint)));
    const hubs = poissonHubs(fixed, s.spacing, p => { const c = cellOf(g, p[0], p[1]); return containsPoint(tree.geometry.footprint, p) && usable(c) && gradeAt(c) <= params.maxGrade; }, { minX: sb.minX, minZ: sb.minZ, size }, rng);

    // 3. The mesh, with link costs estimated along the straight line.
    const estimate = (a: Point2, b: Point2) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / g.cell));
      const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
      let cost = 0, wet = 0;
      let prev = cellOf(g, a[0], a[1]);
      for (let k = 1; k <= n; k++) {
        const c = cellOf(g, a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n);
        if (g.kind[c] === BLOCKED) wet++;
        const st = c === prev ? 0 : stepCost(g, prev, c, heading, params);
        cost += Number.isFinite(st) ? st : 1e4;
        prev = c;
      }
      return { cost, wet: wet / n };
    };
    const est = new Map<string, { cost: number; wet: number }>();
    const estOf = (a: number, b: number) => { const k = a < b ? `${a},${b}` : `${b},${a}`; if (!est.has(k)) est.set(k, estimate(hubs[a], hubs[b])); return est.get(k)!; };
    const mesh = buildMesh(hubs, (a, b) => estOf(a, b).cost, {
      redundancy: s.redundancy, minAngle: (s.junctionAngle * Math.PI) / 180, maxLen: MAX_LINK * s.spacing,
      blocked: (a, b) => estOf(a, b).wet > BLOCKED_SHARE,
    });

    // 4. Route the links: required ones first (cheapest first), then loops.
    const roads: Road[] = [];
    const lay = (points: Point2[], exit: boolean, required: boolean) => {
      const line = smoothRoad(points, s.curveRadius);
      roads.push({ id: `road:${roads.length}`, points: line, exit, required });
      markRoad(g, line);
    };
    const ordered = [...mesh.links].sort((x, y) => Number(y.required) - Number(x.required) || estOf(x.a, x.b).cost - estOf(y.a, y.b).cost);
    for (const l of ordered) {
      const path = route(g, hubs[l.a], { params, goal: { cell: cellOf(g, hubs[l.b][0], hubs[l.b][1]) } });
      if (path && path.length > 1) lay(path, false, l.required);
    }

    const bandOf = (r: Road) => offsetPolyline(r.points, s.roadWidth / 2, 'round');
    const isThin = (fp: MultiPolygon) => slivers(fp, [], s.usableWidth).length > 0;

    // 5. Loops that leave slivers go: a loop is removed only if that actually leaves fewer
    //    slivers in some district it crosses (required roads' slivers aren't its fault).
    {
      const sliversWith = (fp: MultiPolygon, rs: Road[]) => slivers(fp, union(rs.flatMap(bandOf), []), s.usableWidth).length;
      for (const loop of roads.filter(r => !r.required)) {
        const band = bandOf(loop), lb = bounds(band);
        const crossed = dists.filter(d => {
          const b = bounds(d.geometry.footprint);
          return !(b.minX > lb.maxX || b.maxX < lb.minX || b.minZ > lb.maxZ || b.maxZ < lb.minZ) && !isThin(d.geometry.footprint) && area(intersect(d.geometry.footprint, band)) > 1;
        });
        const without = roads.filter(r => r !== loop);
        if (crossed.some(d => sliversWith(d.geometry.footprint, without) < sliversWith(d.geometry.footprint, roads))) roads.splice(roads.indexOf(loop), 1);
      }
    }
    // The grid's road field still holds removed loops; rebuild it from what's left.
    g.road.fill(Infinity);
    for (const r of roads) markRoad(g, r.points);
    const onRoad = (c: number) => g.road[c] <= s.roadWidth / 2;

    // 5b. One network: the mesh can fall into pieces (hubs either side of a bay with no allowed
    //     link), so join any stray piece to the main one with a connector.
    let connectors = 0;
    const cellsOf = (r: Road) => {
      const out = new Set<number>();
      for (let i = 0; i + 1 < r.points.length; i++) {
        const [a, b] = [r.points[i], r.points[i + 1]];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g.cell / 2)));
        for (let k = 0; k <= n; k++) out.add(cellOf(g, a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n));
      }
      return out;
    };
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
      const stray = sorted[1];
      const mainPts = sorted[0].flatMap(i => roads[i].points);
      // From the stray piece's point nearest the main network.
      let start: Point2 | null = null, toward: Point2 | null = null, bd = Infinity;
      for (const i of stray) for (const p of roads[i].points) for (const q of mainPts) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < bd) { bd = d; start = p; toward = q; }
      }
      const path = start && route(g, start, { params, goal: { touches: c => main.has(c) }, toward: toward! });
      if (!path || path.length < 2) break;
      lay(path, false, true);
      connectors++;
    }

    // 6. Exits: dead ends from the site edge, inward, to the nearest arterial.
    let exitCount = 0;
    if (roads.length) {
      const ring = tree.geometry.footprint[0][0];
      const exits = placeExits(s.exits, ring, p => {
        const inside: Point2 = [p[0], p[1]];
        const c = cellOf(g, inside[0], inside[1]);
        return usable(c) && !blocked.some(b => containsPoint(b, inside));
      }, p => -gradeAt(cellOf(g, p[0], p[1])), rng);
      for (const e of exits) {
        const start: Point2 = [e.at[0] + e.inward[0] * g.cell, e.at[1] + e.inward[1] * g.cell];
        const path = route(g, start, { params, startHeading: Math.atan2(e.inward[1], e.inward[0]), goal: { touches: onRoad }, toward: centroid(tree.geometry.footprint) });
        if (!path) continue;
        lay([e.at, ...path], true, true);
        exitCount++;
      }
    }

    // 7. Spurs to any district the network doesn't touch.
    let spurs = 0, unreachable = 0;
    if (roads.length) {
      let all = union(roads.flatMap(bandOf), []);
      for (const d of dists) {
        const fp = d.geometry.footprint;
        if (area(intersect(fp, all)) > 1) continue;
        const target = centroid(fp);
        // Start on the road point nearest the district.
        let start: Point2 | null = null, bd = Infinity;
        for (const r of roads) for (const p of r.points) { const dd = Math.hypot(p[0] - target[0], p[1] - target[1]); if (dd < bd) { bd = dd; start = p; } }
        // Goal cells: any whose centre is inside, plus the cells holding its corners (a small
        // district may contain no cell centre at all).
        const goal = new Set<number>();
        for (const ring of fp.flat()) for (const p of ring) goal.add(cellOf(g, p[0], p[1]));
        const fb = bounds(fp);
        for (let z = fb.minZ; z <= fb.maxZ; z += g.cell / 2) for (let x = fb.minX; x <= fb.maxX; x += g.cell / 2) if (containsPoint(fp, [x, z])) goal.add(cellOf(g, x, z));
        const path = start && route(g, start, { params, goal: { touches: c => goal.has(c) }, toward: target });
        if (!path || path.length < 2) { unreachable++; continue; }
        // The goal cell may only hold one of the district's corners: finish at that corner.
        const end = path[path.length - 1];
        let corner: Point2 = end, cd = Infinity;
        for (const ring of fp.flat()) for (const p of ring) { const dd = Math.hypot(p[0] - end[0], p[1] - end[1]); if (dd < cd) { cd = dd; corner = p; } }
        lay(cd > 1 ? [...path, corner] : path, false, true);
        spurs++;
        all = union(all, bandOf(roads[roads.length - 1]));
      }
    }

    // 8. Cut the roads out of the districts and the river.
    const bands = roads.map(bandOf);
    const exclusive: MultiPolygon[] = [];
    let taken: MultiPolygon = [];
    for (const b of bands) { exclusive.push(difference(b, taken)); taken = union(taken, b); }
    const all = taken;
    const boxes = exclusive.map(e => (e.length ? bounds(e) : null));
    const cut = (parent: RegionNode, roadKind: string, restKind: string, extra: (i: number) => RegionNode['attrs']) => {
      const fp = parent.geometry.footprint, pb = bounds(fp);
      const kids: RegionNode[] = [];
      exclusive.forEach((e, i) => {
        const b = boxes[i];
        if (!b || b.minX > pb.maxX || b.maxX < pb.minX || b.minZ > pb.maxZ || b.maxZ < pb.minZ) return;
        const piece = intersect(fp, e);
        if (area(piece) <= 0) return;
        const name = `${roadKind}:${kids.filter(k => k.kind === roadKind).length}`;
        kids.push({ id: childId(parent.id, name), name, kind: roadKind, stage: 'arterials', geometry: makeSlab(piece), attrs: extra(i), children: [] });
      });
      return { kids, rest: difference(fp, all).filter(poly => area([poly]) > 0) };
    };
    let sliverCount = 0;
    for (const d of dists) {
      const { kids, rest } = cut(d, 'arterial', 'superblock', i => ({ road: roads[i].id, width: s.roadWidth }));
      rest.forEach((poly, k) => {
        const name = `superblock:${k}`;
        kids.push({ id: childId(d.id, name), name, kind: 'superblock', stage: 'arterials', geometry: makeSlab([poly]), attrs: {}, children: [] });
      });
      children.set(d.id, kids);
      if (!isThin(d.geometry.footprint) && area(intersect(d.geometry.footprint, all)) > 1) sliverCount += slivers(d.geometry.footprint, all, s.usableWidth).length;
    }
    let bridges = 0;
    if (river) {
      const { kids, rest } = cut(river, 'bridge', 'water', i => ({ road: roads[i].id }));
      bridges = kids.length;
      if (kids.length) {
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
        roads: roads.map(r => ({ id: r.id, points: r.points, exit: r.exit })),
        stats: {
          links: mesh.links.length, loops: roads.filter(r => !r.required && !r.exit).length, exits: exitCount, bridges,
          unreachable, spurs, connectors, sharpJunctions: mesh.sharp,
          tightCurves: roads.reduce((n, r) => n + tightBends(r.points, s.curveRadius), 0),
          slivers: sliverCount, overGrade: Math.round(overGrade), ms: Math.round(performance.now() - t0),
        },
      }]]),
    };
  },
};

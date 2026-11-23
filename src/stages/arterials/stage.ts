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

// Distances scale with the city: the routing grid is spacing/35 (20 m at the old 700 m), but at
// most ~300 cells across; other distances are in cells, spacing or district widths.
const CELLS_PER_SPACING = 35, MAX_GRID = 300;
const NUDGE = 3;            // cells: centres move this far to flatter ground
const MAX_LINK = 1.8;       // × spacing: longest mesh link
const BLOCKED_SHARE = 0.3;  // a link mostly over sea or pond isn't a candidate
const EXIT_STUB = 2;        // cells an exit runs straight in from the edge
const WATER = new Set(['sea', 'river', 'pond']);

interface Road { id: string; points: Point2[]; exit: boolean; required: boolean }

export const arterials: Stage = {
  id: 'arterials',
  title: 'Arterials',
  settings: [
    { key: 'spacing', label: 'Arterial spacing', type: 'number', min: 1000, max: 5000, step: 100, default: 2000, unit: 'm', help: 'Distance between hubs, and so between arterials' },
    { key: 'redundancy', label: 'Redundancy', type: 'number', min: 0, max: 1, step: 0.05, default: 0.3, help: 'Extra loop links beyond what reaching everywhere needs' },
    { key: 'exits', label: 'Exits', type: 'number', min: 1, max: 8, step: 1, default: 3, help: 'Arterials leading off the site' },
    { key: 'roadWidth', label: 'Road width', type: 'number', min: 15, max: 40, step: 1, default: 25, unit: 'm', help: 'Including verges' },
    { key: 'junctionAngle', label: 'Junction angle', type: 'number', min: 30, max: 90, step: 5, default: 60, unit: '°', help: 'The sharpest angle two arterials may meet at' },
    { key: 'curveRadius', label: 'Curve radius', type: 'number', min: 50, max: 500, step: 10, default: 150, unit: 'm', help: 'The tightest bend an arterial may take' },
    { key: 'maxGrade', label: 'Max grade', type: 'number', min: 2, max: 20, step: 1, default: 8, unit: '%', help: 'Steepest grade an arterial should take (soft)' },
    { key: 'usableWidth', label: 'Usable width', type: 'number', min: 100, max: 800, step: 50, default: 300, unit: 'm', help: 'Narrowest land left between roads, or a road and a district edge' },
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
    const cellM = Math.max(s.spacing / CELLS_PER_SPACING, size / MAX_GRID);
    const districtWidth = Math.sqrt(dists.reduce((t, d) => t + area(d.geometry.footprint), 0) / dists.length);
    // Kinds painted in order (later wins); elevations from the terrain's own triangles, water
    // first so land wins along shared edges. Point lookups per cell took seconds at 5 km.
    const water = terrainKids.filter(n => n.kind === 'sea' || n.kind === 'pond' || n.kind === 'river').flatMap(n => n.geometry.footprint);
    const g = buildGrid({
      bounds: { minX: sb.minX, minZ: sb.minZ, size },
      elevAt: (x, z) => groundHeightAt(tree, x, z),
      kindAt: () => LAND,
      kinds: [
        { footprint: tree.geometry.footprint, kind: LAND },
        ...hills.map(footprint => ({ footprint, kind: HILLS })),
        ...(river ? [{ footprint: river.geometry.footprint, kind: RIVER }] : []),
        ...blocked.map(footprint => ({ footprint, kind: BLOCKED })),
      ],
      surfaces: [...terrainKids.filter(n => WATER.has(n.kind)), ...terrainKids.filter(n => !WATER.has(n.kind))].flatMap(n => (n.data?.ground ? [n.data.ground] : [])),
      districts: dists.map(d => d.geometry.footprint),
      river: river?.geometry.footprint,
      water: [...water, ...tree.geometry.footprint],
      // District borders are corridors, but not the site's own edge: roads hugged it.
      skipSegment: (a, b) => onSiteEdge(a) && onSiteEdge(b),
    }, cellM, {
      band: 2 * cellM, edgeScale: 0.44 * districtWidth, roadReach: Math.max(8 * cellM, 1.1 * s.usableWidth),
      riverReach: 5 * cellM, bankExtra: cellM / 2,
    });
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
      const c0 = cellOf(g, p[0], p[1]), r = NUDGE;
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
    // Hubs keep away from the site edge, or links between them ran along it.
    const margin = (s.spacing * 3) / 14; // 150 m at the old 700 m spacing
    const edgeDist = (p: Point2) => Math.min(p[0] - sb.minX, sb.maxX - p[0], p[1] - sb.minZ, sb.maxZ - p[1]);
    // Town centres too keep inside the edge margin (one on the edge sent roads along it).
    const inset = (p: Point2): Point2 => [Math.min(sb.maxX - margin, Math.max(sb.minX + margin, p[0])), Math.min(sb.maxZ - margin, Math.max(sb.minZ + margin, p[1]))];
    const fixed = dists.filter(d => d.attrs.anchor === 'main' || d.attrs.anchor === 'minor').map(d => nudge(inset(centroid(d.geometry.footprint))));
        const hubs = poissonHubs(fixed, s.spacing, p => { const c = cellOf(g, p[0], p[1]); return containsPoint(tree.geometry.footprint, p) && edgeDist(p) >= margin && usable(c) && gradeAt(c) <= params.maxGrade; }, { minX: sb.minX, minZ: sb.minZ, size }, rng);

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
    const lay = (points: Point2[], exit: boolean, required: boolean, keep = 0) => {
      // The first `keep` points stay as they are (an exit's straight stub), the rest is smoothed.
      const line = keep > 0 ? [...points.slice(0, keep), ...smoothRoad(points.slice(keep - 1), s.curveRadius, 0.6 * cellM).slice(1)] : smoothRoad(points, s.curveRadius, 0.6 * cellM);
      roads.push({ id: `road:${roads.length}`, points: line, exit, required });
      markRoad(g, line);
    };
    const ordered = [...mesh.links].sort((x, y) => Number(y.required) - Number(x.required) || estOf(x.a, x.b).cost - estOf(y.a, y.b).cost);
    for (const l of ordered) {
      const path = route(g, hubs[l.a], { params, goal: { cell: cellOf(g, hubs[l.b][0], hubs[l.b][1]) } });
      if (path && path.length > 1) lay(path, false, l.required);
    }

    // Bands and their bounds, computed once per road. Slivers and cuts in a district depend only
    // on the bands overlapping it: unions of every band made pruning take seconds at 30 km.
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

    // 5. Loops that leave slivers go: a loop is removed only if that actually leaves fewer
    //    slivers in some district it crosses (required roads' slivers aren't its fault).
    {
      const sliversWith = (fp: MultiPolygon, rs: Road[]) => slivers(fp, union(near(fp, rs).flatMap(bandOf), []), s.usableWidth).length;
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
      }, p => -gradeAt(cellOf(g, p[0], p[1])), rng, margin, 3 * cellM);
      for (const e of exits) {
        // Square-on: start at a cell centre just inside, put the exit point on the edge
        // straight behind it, and go straight in for a couple of cells before turning.
        const c0 = cellOf(g, e.at[0] + e.inward[0] * g.cell, e.at[1] + e.inward[1] * g.cell);
        const start = centreOf(g, c0);
        const back = (start[0] - e.at[0]) * e.inward[0] + (start[1] - e.at[1]) * e.inward[1];
        const edge: Point2 = [start[0] - e.inward[0] * back, start[1] - e.inward[1] * back];
        const path = route(g, start, { params, startHeading: Math.atan2(e.inward[1], e.inward[0]), straightStart: EXIT_STUB, goal: { touches: onRoad }, toward: centroid(tree.geometry.footprint) });
        if (!path) continue;
        lay([edge, ...path], true, true, EXIT_STUB + 2);
        exitCount++;
      }
    }

    // 7. Spurs to any district the network doesn't touch.
    let spurs = 0, unreachable = 0;
    if (roads.length) {
      let all = union(roads.flatMap(bandOf), []);
      for (const d of dists) {
        // Undeveloped land needn't be reached by an arterial (the owner: "it's not important to
        // connect undeveloped districts"); roads may still cross it.
        if (d.attrs.type === 'undeveloped') continue;
        const fp = d.geometry.footprint;
        if (area(intersect(fp, all)) > 1) continue;
        const target = centroid(fp);
        // Start on the road point nearest the district.
        let start: Point2 | null = null, bd = Infinity;
        for (const r of roads) for (const p of r.points) { const dd = Math.hypot(p[0] - target[0], p[1] - target[1]); if (dd < bd) { bd = dd; start = p; } }
        // Goal cells: any whose centre is inside, plus the cells holding its corners (a small
        // district may contain no cell centre at all).
        const goal = new Set<number>();
        // Not corners on the site edge: a spur ending there ran along the edge.
        for (const ring of fp.flat()) for (const p of ring) if (edgeDist(p) > g.cell) goal.add(cellOf(g, p[0], p[1]));
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
      const crosses = (r: Road) => r.points.some((p, i) => containsPoint(rfp, p) || (i + 1 < r.points.length && [0.25, 0.5, 0.75].some(t => containsPoint(rfp, [p[0] + (r.points[i + 1][0] - p[0]) * t, p[1] + (r.points[i + 1][1] - p[1]) * t]))));
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
        roads: roads.map(r => ({ id: r.id, points: r.points, exit: r.exit })),
        stats: {
          hubs: hubs.length, candidates: mesh.candidates, links: mesh.links.length, loops: roads.filter(r => !r.required && !r.exit).length, exits: exitCount, bridges,
          unreachable, spurs, connectors, sharpJunctions: mesh.sharp,
          tightCurves: roads.reduce((n, r) => n + tightBends(r.points, s.curveRadius), 0),
          slivers: sliverCount, overGrade: Math.round(overGrade), ms: Math.round(performance.now() - t0),
        },
      }]]),
    };
  },
};

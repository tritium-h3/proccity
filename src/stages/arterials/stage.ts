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
import { BLOCKED, buildGrid, cellOf, centreOf, HILLS, isUsable, LAND, markRoad, RIVER, stepCost, WILD, type CostParams } from './grid.js';
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
    const nudge = (p: Point2): Point2 => {
      let best = -1, bs = Infinity;
      const c0 = cellOf(g, p[0], p[1]), r = NUDGE;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const i = (c0 % g.w) + di, j = Math.floor(c0 / g.w) + dj;
        if (i < 0 || j < 0 || i >= g.w || j >= g.h) continue;
        const c = j * g.w + i;
        if (!usable(c)) continue;
        // Flattest, but clear of water and Undeveloped land where that's possible.
        const score = gradeAt(c) + Math.hypot(di, dj) * 0.001 + (clear(c) ? 0 : 1e3);
        if (score < bs) { bs = score; best = c; }
      }
      return best >= 0 ? centreOf(g, best) : p;
    };

    // 2. Hubs: the town centres, then spaced points on usable, not-too-steep ground.
    // Sampled hubs only on developed land, clear of water and of Undeveloped land: a hub there
    // that the mesh leaves as a leaf is a dead end at the shore or in the wilds.
    // Hubs keep away from the site edge, or links between them ran along it.
    const margin = (s.spacing * 3) / 14; // 150 m at the old 700 m spacing
    // Town centres too keep inside the edge margin (one on the edge sent roads along it).
    const inset = (p: Point2): Point2 => [Math.min(sb.maxX - margin, Math.max(sb.minX + margin, p[0])), Math.min(sb.maxZ - margin, Math.max(sb.minZ + margin, p[1]))];
    const fixed = dists.filter(d => d.attrs.anchor === 'main' || d.attrs.anchor === 'minor').map(d => nudge(inset(centroid(d.geometry.footprint))));
        const hubs = poissonHubs(fixed, s.spacing, p => { const c = cellOf(g, p[0], p[1]); return containsPoint(tree.geometry.footprint, p) && edgeDist(p) >= margin && usable(c) && clear(c) && gradeAt(c) <= params.maxGrade; }, { minX: sb.minX, minZ: sb.minZ, size }, rng);

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
    // A path runs through cell centres, so "on" a border it can be most of a cell beside it,
    // leaving a strip of district too thin to use. Points running along a border move onto it.
    const onBorder = Math.max(s.roadWidth / 2, 0.75 * cellM);
    const snap = (points: Point2[], from: number): Point2[] => {
      const out: Point2[] = points.map((p, i) => {
        if (i < Math.max(1, from) || i >= points.length - 1) return p;
        const c = cellOf(g, p[0], p[1]);
        if (g.border[c] > onBorder) return p;
        const a = points[i - 1], b = points[i + 1];
        const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (Math.abs(Math.cos(heading - g.borderNormal[c])) > 0.5) return p; // crossing it
        return [g.borderFootX[c], g.borderFootZ[c]];
      });
      return out.filter((p, i) => i === 0 || Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]) > 1);
    };
    // Ids from a counter, not roads.length: pruning removes roads, and a reused id made two
    // roads' bridges and strips claim the same road.
    let nextId = 0;
    const lay = (raw: Point2[], exit: boolean, required: boolean, keep = 0) => {
      const points = snap(raw, keep);
      // The first `keep` points stay as they are (an exit's straight stub), the rest is smoothed.
      const line = keep > 0 ? [...points.slice(0, keep), ...smoothRoad(points.slice(keep - 1), s.curveRadius, 0.6 * cellM).slice(1)] : smoothRoad(points, s.curveRadius, 0.6 * cellM);
      roads.push({ id: `road:${nextId++}`, points: line, exit, required });
      markRoad(g, line);
    };
    const ordered = [...mesh.links].sort((x, y) => Number(y.required) - Number(x.required) || estOf(x.a, x.b).cost - estOf(y.a, y.b).cost);
    for (const l of ordered) {
      const path = route(g, hubs[l.a], { params, maxTurn, goal: { cell: cellOf(g, hubs[l.b][0], hubs[l.b][1]) } });
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
    // Within three-quarters of a cell too: at 100 m cells half a road width (12.5 m) missed cells.
    const onRoad = (c: number) => g.road[c] <= Math.max(s.roadWidth / 2, 0.75 * g.cell);

    // A route aimed at a road stops in a cell beside it, up to most of a cell short (a visible
    // gap at 100 m cells): finish on the nearest point of those roads.
    const joinTo = (path: Point2[], rs: Road[]): Point2[] => {
      const end = path[path.length - 1];
      let best: Point2 | null = null, bd = Infinity;
      for (const r of rs) for (let i = 0; i + 1 < r.points.length; i++) {
        const a = r.points[i], b = r.points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
        const t = L ? Math.max(0, Math.min(1, ((end[0] - a[0]) * dx + (end[1] - a[1]) * dz) / L)) : 0;
        const q: Point2 = [a[0] + t * dx, a[1] + t * dz], d = Math.hypot(end[0] - q[0], end[1] - q[1]);
        if (d < bd) { bd = d; best = q; }
      }
      return best && bd > 1 && bd < 2 * g.cell ? [...path, best] : path;
    };

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
      const path = start && route(g, start, { params, maxTurn, goal: { touches: c => main.has(c) }, toward: toward! });
      if (!path || path.length < 2) break;
      lay(joinTo(path, sorted[0].map(i => roads[i])), false, true);
      connectors++;
    }

    // 5c. A dead end goes when every developed district it reaches is reached by another road
    //     (and the network stays in one piece): a leaf hub's road otherwise ran on to nowhere,
    //     often a shore or the edge of the wilds. Any district this leaves untouched gets a spur.
    let pruned = 0;
    const developed = dists.filter(d => d.attrs.type !== 'undeveloped').map(d => ({ d, box: bounds(d.geometry.footprint) }));
    const reachCache = new Map<Road, Set<RegionNode>>();
    const reachOf = (r: Road) => {
      let set = reachCache.get(r);
      if (!set) {
        const { band, box } = bandInfo(r);
        set = new Set(developed.filter(x => overlaps(x.box, box) && area(intersect(x.d.geometry.footprint, band)) > 1).map(x => x.d));
        reachCache.set(r, set);
      }
      return set;
    };
    const cellCache = new Map<Road, Set<number>>();
    const cellsCached = (r: Road) => { let c = cellCache.get(r); if (!c) { c = cellsOf(r); cellCache.set(r, c); } return c; };
    const meets = (p: Point2, r: Road) => r.points.some((a, i) => {
      if (i + 1 >= r.points.length) return false;
      const b = r.points[i + 1], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
      const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0;
      return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz) < s.roadWidth;
    });
    const prune = () => {
      const pieces = (rs: Road[]) => {
        const owner = new Map<number, number>(), parent = rs.map((_, i) => i);
        const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
        rs.forEach((r, i) => { for (const c of cellsCached(r)) { const o = owner.get(c); if (o === undefined) owner.set(c, i); else parent[find(i)] = find(o); } });
        return new Set(rs.map((_, i) => find(i))).size;
      };
      const dangling = (r: Road) => [r.points[0], r.points[r.points.length - 1]].some(p => !roads.some(o => o !== r && meets(p, o)));
      const before = pruned;
      for (let changed = true; changed;) {
        changed = false;
        let now = pieces(roads);
        for (const r of [...roads]) {
          if (r.exit || !dangling(r)) continue;
          const others = roads.filter(o => o !== r);
          if (![...reachOf(r)].every(d => others.some(o => reachOf(o).has(d)))) continue;
          const after = pieces(others);
          if (after > now) continue;
          roads.splice(roads.indexOf(r), 1);
          now = after;
          pruned++;
          changed = true;
        }
      }
      if (pruned > before) { g.road.fill(Infinity); for (const r of roads) markRoad(g, r.points); }
    };
    prune();

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
        const path = route(g, start, { params, maxTurn, startHeading: Math.atan2(e.inward[1], e.inward[0]), straightStart: EXIT_STUB, goal: { touches: onRoad }, toward: centroid(tree.geometry.footprint) });
        if (!path) continue;
        lay(joinTo([edge, ...path], roads), true, true, EXIT_STUB + 2);
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
        // Candidate cells, best first: cells whose centre is inside and clear of water and
        // Undeveloped land; corner cells that are clear (a small district may hold no cell centre
        // at all). Not corners on the site edge: a spur ending there ran along the edge.
        const inside: number[] = [], corners: number[] = [];
        for (const ring of fp.flat()) for (const p of ring) if (edgeDist(p) > g.cell) corners.push(cellOf(g, p[0], p[1]));
        const fb = bounds(fp);
        for (let j = Math.max(0, Math.floor((fb.minZ - g.minZ) / g.cell)); j < g.h && g.minZ + j * g.cell <= fb.maxZ; j++) {
          for (let i = Math.max(0, Math.floor((fb.minX - g.minX) / g.cell)); i < g.w && g.minX + i * g.cell <= fb.maxX; i++) {
            const c = j * g.w + i;
            if (usable(c) && containsPoint(fp, centreOf(g, c))) inside.push(c);
          }
        }
        let cands = [inside.filter(clear), corners.filter(c => usable(c) && clear(c))].find(cs => cs.length) ?? [];
        if (!cands.length) {
          // Nowhere clear (a district along a shore): its cells farthest from the water, out of
          // Undeveloped land. Ending near the wilds is fine: the end is in the district it serves.
          const tame = (cs: number[]) => cs.filter(c => usable(c) && g.wild[c] > g.cell);
          const cs = [tame(inside), tame(corners), inside.filter(usable), corners.filter(usable)].find(x => x.length) ?? [];
          const fromWater = (c: number) => (edgeDist(centreOf(g, c)) <= g.bank[c] + 1 ? Infinity : g.bank[c]);
          const most = Math.max(0, ...cs.map(fromWater));
          cands = cs.filter(c => fromWater(c) >= 0.9 * most);
        }
        if (!cands.length) { unreachable++; continue; }
        // The spur starts in the district, at the candidate nearest its centre, and is routed out
        // to whichever road is cheapest to reach. Routed the other way, from the road point
        // nearest the centre, it crossed the river to districts just over it and hooked back to
        // a corner at the end (hairpins, ends on the bank).
        const target = centroid(fp);
        const start = cands.reduce((a, c) => { const [ax, az] = centreOf(g, a), [cx, cz] = centreOf(g, c); return Math.hypot(cx - target[0], cz - target[1]) < Math.hypot(ax - target[0], az - target[1]) ? c : a; });
        const path = route(g, centreOf(g, start), { params, maxTurn, goal: { touches: onRoad } });
        if (!path || path.length < 2) { unreachable++; continue; }
        lay(joinTo(path, roads), false, true);
        spurs++;
        all = union(all, bandOf(roads[roads.length - 1]));
      }
    }

    // Again with exits and spurs in: one may reach what a dead end was kept for.
    prune();

    // 7b. Dead ends left: carry each on, the way it was heading, to another road within the
    //     spacing (a loop, not a stub). Failing that, one near the site edge carries on off the
    //     site; that's an extra way out, which beats a road stopping just short of the edge.
    let closed = 0, extended = 0;
    {
      const pathLength = (p: Point2[]) => p.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
      const isDangling = (r: Road, p: Point2) => !roads.some(o => o !== r && meets(p, o));
      const ends: { r: Road; first: boolean }[] = [];
      for (const r of roads) {
        if (r.exit) continue;
        if (isDangling(r, r.points[0])) ends.push({ r, first: true });
        if (isDangling(r, r.points[r.points.length - 1])) ends.push({ r, first: false });
      }
      for (const { r, first } of ends) {
        const pts = first ? [...r.points].reverse() : r.points;
        const end = pts[pts.length - 1];
        if (!isDangling(r, end)) continue; // an earlier closure reached it
        const back = pts[Math.max(0, pts.length - 2)];
        const heading = Math.atan2(end[1] - back[1], end[0] - back[0]);
        // Not back onto its own road: its cells and their neighbours.
        const own = new Set<number>();
        for (const c of cellsOf(r)) for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
          const i = (c % g.w) + di, j = Math.floor(c / g.w) + dj;
          if (i >= 0 && j >= 0 && i < g.w && j < g.h) own.add(j * g.w + i);
        }
        const from = (p: Point2[]) => [end, ...p.slice(Math.hypot(p[0][0] - end[0], p[0][1] - end[1]) < 1 ? 1 : 0)];
        const loop = route(g, end, { params, maxTurn, startHeading: heading, maxCost: 3 * s.spacing, goal: { touches: c => onRoad(c) && !own.has(c) } });
        if (loop && loop.length > 1 && pathLength(loop) <= s.spacing) {
          lay(joinTo(from(loop), roads.filter(o => o !== r)), false, true);
          closed++;
          continue;
        }
        if (edgeDist(end) >= s.spacing / 2) continue;
        const out = route(g, end, { params, maxTurn, startHeading: heading, maxCost: 3 * s.spacing, goal: { touches: c => edgeDist(centreOf(g, c)) < g.cell } });
        if (!out || out.length < 2) continue;
        // Finish on the edge, straight out from the last cell.
        const last = out[out.length - 1];
        const onEdge: Point2 = [Math.min(sb.maxX, Math.max(sb.minX, last[0])), Math.min(sb.maxZ, Math.max(sb.minZ, last[1]))];
        const dx = Math.min(last[0] - sb.minX, sb.maxX - last[0]), dz = Math.min(last[1] - sb.minZ, sb.maxZ - last[1]);
        if (dx < dz) onEdge[0] = last[0] - sb.minX < sb.maxX - last[0] ? sb.minX : sb.maxX;
        else onEdge[1] = last[1] - sb.minZ < sb.maxZ - last[1] ? sb.minZ : sb.maxZ;
        // An exit runs from the edge inward.
        lay([onEdge, ...from(out).reverse()], true, true);
        extended++;
      }
      if (closed + extended) { g.road.fill(Infinity); for (const r of roads) markRoad(g, r.points); }
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
        roads: roads.map(r => ({ id: r.id, points: r.points, exit: r.exit })),
        stats: {
          hubs: hubs.length, candidates: mesh.candidates, links: mesh.links.length, loops: roads.filter(r => !r.required && !r.exit).length, exits: exitCount, bridges,
          unreachable, spurs, connectors, pruned, closed, extended, sharpJunctions: mesh.sharp,
          tightCurves: roads.reduce((n, r) => n + tightBends(r.points, s.curveRadius), 0),
          slivers: sliverCount, overGrade: Math.round(overGrade), ms: Math.round(performance.now() - t0),
        },
      }]]),
    };
  },
};

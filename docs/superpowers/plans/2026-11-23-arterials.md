# Arterials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An `arterials` stage: a sparse, connected, terrain-following arterial network (hubs → pruned mesh → heading-aware A* over a cost grid) with exits, cut out of districts (into `arterial` + `superblock` pieces) and the river (`bridge` + `water`).

**Architecture:** Pure modules under `src/stages/arterials/`:
- `grid.ts`: a raster of terrain and district facts, plus step costs;
- `route.ts`: heading-aware A*;
- `hubs.ts`: hubs and exits;
- `mesh.ts`: Delaunay, MST, redundancy and angle pruning;
- `smooth.ts`: simplify, Chaikin and radius checks;
- `space.ts`: the sliver test;
- `stage.ts`: assembly and cutting.

The renderer bakes superblocks (by district type) and roads into the tint texture, and draws bridge decks as meshes.

**Tech Stack:** TypeScript 7, Vitest, d3-delaunay, clipper2-ts via `grammar/clipper.ts`, Three.js TSL.

**Spec:** `docs/superpowers/specs/2026-11-23-arterials-design.md`

## Global Constraints

- **Settings** (key, label, range, step, default, unit):

  | Key | Label | Range | Step | Default | Unit |
  |---|---|---|---|---|---|
  | `spacing` | Arterial spacing | 300–1500 | 50 | 700 | m |
  | `redundancy` | Redundancy | 0–1 | 0.05 | 0.3 | |
  | `exits` | Exits | 1–8 | 1 | 3 | |
  | `roadWidth` | Road width | 15–40 | 1 | 25 | m |
  | `junctionAngle` | Junction angle | 30–90 | 5 | 60 | ° |
  | `curveRadius` | Curve radius | 20–200 | 10 | 60 | m |
  | `maxGrade` | Max grade | 2–20 | 1 | 8 | % |
  | `usableWidth` | Usable width | 30–150 | 10 | 60 | m |

- **Max grade is soft:** cost grows with the square of the excess, never infinite.
- **Grade is along the heading.**
- **Sea and ponds are impassable.** The river is passable at a high cost, with a heading penalty off-perpendicular.
- **District borders are corridors:**
  - cost × 0.5 within roadWidth/2 of a border;
  - a parallel penalty `k(1 − |cos θ|)` from roadWidth/2 to 40 m;
  - a gentle rise towards district edges inside districts.
- **Existing roads** raise cost within usableWidth, except at joins, crossings and shared corridors. Updates are incremental.
- **Exits** are degree-1, outside the Delaunay mesh. Each leaves the site perpendicular to the boundary over land, and joins the nearest hub or arterial.
- **Sliver:** a piece that doesn't survive an inward offset of usableWidth/2, or is under 0.25 × its district's area.
- **Output:**
  - Each district gets children `arterial` (attrs `{ road, width }`) and `superblock`; an untouched district gets one superblock.
  - The river gets `bridge` (attrs `{ road }`) plus one `water`.
  - Sea and ponds get none.
  - Ids: `<parent>/arterial:N`, `/superblock:N`, `/bridge:N`, `/water:0`.
- **Site data:**
  - `data.roads: { id: string; points: Point2[]; exit: boolean }[]`, a new `RegionData` field that is validated.
  - `data.stats`: `links, loops, exits, bridges, unreachable, sharpJunctions, tightCurves, slivers, overGrade` (m), `spurs, ms`.
- **Performance:** under about 1 s at 2 km with the defaults. Grid 20 m.
- **Deterministic** from the stage rng.

## Review Focus

- **No river or no sea:** `shore: none`, `river: false`. Exits may go on any edge, there are no bridges, and nothing throws. → Task 5 extremes.
- **Very steep site** (relief 400, hilliness 1): routes still complete, and `overGrade` is reported, not infinite cost. → Task 2 test (cost finite at any grade), Task 5 extremes.
- **A district enclosed by water or unreachable:** counted in `unreachable`, no throw. → Task 5 test with a pond-island synthetic check, or rely on stats.
- **Exits when most of the boundary is sea:** exits are placed only on land boundary. If there's less land edge than exits need, place fewer and count them. → Task 3 test.
- **Spacing 1500 on a 2 km site:** few hubs (possibly just the centres plus exits), still connected, and every district touched via spurs. → Task 5 extremes.

---

### Task 1: The grid and costs (`grid.ts`) and the `roads` data field

**Files:**
- Create: `src/stages/arterials/grid.ts`; Test: `src/stages/arterials/grid.test.ts`
- Modify: `src/doc/types.ts` (RegionData `roads?`), `src/doc/validate.ts` (validate `roads`), `src/doc/validate.test.ts` (one valid and one invalid case)

**Interfaces (produces):**

```ts
export const LAND = 0, HILLS = 1, RIVER = 2, BLOCKED = 3;
export interface Grid {
  minX: number; minZ: number; cell: number; w: number; h: number;
  elev: Float32Array; kind: Uint8Array;
  border: Float32Array;      // m to the nearest district border
  borderNormal: Float32Array; // angle (rad) of that border's normal
  edge: Float32Array;        // 0 at a district's middle … 1 at its edge
  road: Float32Array;        // m to the nearest placed road (Infinity)
}
export interface GridInput {
  bounds: { minX: number; minZ: number; size: number };
  elevAt(x: number, z: number): number;
  kindAt(x: number, z: number): number;          // LAND | HILLS | RIVER | BLOCKED
  districts: MultiPolygon[];                      // for border distance/normal and edge
}
export function buildGrid(inp: GridInput, cell: number): Grid;
export interface CostParams { maxGrade: number; roadWidth: number; usableWidth: number }
/** Cost of stepping from cell a to neighbour b with heading h (rad); Infinity only for BLOCKED. */
export function stepCost(g: Grid, a: number, b: number, heading: number, p: CostParams): number;
export function markRoad(g: Grid, line: Point2[]): void;   // incremental update of g.road
export const cellOf: (g: Grid, x: number, z: number) => number;
export const centreOf: (g: Grid, i: number) => Point2;
```

- [ ] **Step 1: Failing tests** on synthetic `GridInput`s (flat or tilted planes, rectangles):
  - On flat land, `stepCost` for a straight step equals its length × 1 (on a cell away from borders).
  - On a 20% plane, an uphill step costs more than an along-contour step, and both are finite.
  - At 4% grade with `maxGrade` 8, the step costs less than double flat; at 16%, more than 5× flat.
  - A BLOCKED cell gives `Infinity`.
  - A RIVER step costs ≥ 20× land, and more off-perpendicular than across.
  - With two districts sharing a border, a step along the border costs about 0.5 × an interior step. A step parallel to the border 20 m off it costs more than along it, and more than a perpendicular crossing.
  - After `markRoad`, a parallel step within usableWidth of the road costs more than before.
  - Validate: `data.roads` with points passes, and `data.roads: [{ id: 1 }]` fails.
- [ ] **Step 2:** Run `npx vitest run src/stages/arterials src/doc/validate.test.ts`; expect FAIL.
- [ ] **Step 3: Implement.**
  - Border distance and normal: bucket district boundary segments into grid tiles, then query nearby buckets.
  - `edge`: distance-to-border relative to the district's inradius estimate, clamped to 0–1.
  - Cost:

    ```
    len × base × grade × border × edge × road
    ```

    where:
    - `base` = 1 on land, 1.5 on hills, 30 on river (× (1 + 4(1 − |cos|)) off-perpendicular);
    - `grade` = g ≤ max ? 1 + 2(g/max)² : 3 + 40((g − max)/max)²;
    - `border` = 0.5 on the corridor, else 1 + 3(1 − |cos θ|) in the band;
    - `edge` = 1 + 0.3 × edge;
    - `road` = 1 + 3(1 − |cos θ_road|) within usableWidth (store the road direction alongside `road`).
- [ ] **Step 4:** Run; PASS. Typecheck and lint.
- [ ] **Step 5:** Commit `feat(arterials): cost grid`.

### Task 2: Heading-aware A* (`route.ts`)

**Files:** Create `src/stages/arterials/route.ts`; Test `route.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:

```ts
export interface RouteOpts { params: CostParams; turnPenalty?: number; startHeading?: number; goal: { cell: number } | { touches: (cell: number) => boolean } }
export function route(g: Grid, start: Point2, opts: RouteOpts): Point2[] | null;  // cell centres, start → goal
```

- [ ] **Step 1: Failing tests:**
  - On a flat grid, the route between two points is nearly straight (length ≤ 1.08 × euclid).
  - A ridge (a band of 30% grade with a gap of flat at one end) makes the route go through the gap.
  - A BLOCKED wall with no gap → `null`.
  - A river band → the route crosses it once, and the crossing is short (≤ 1.3 × the river width).
  - The `touches` goal stops at the first cell that satisfies it.
  - No turn between consecutive steps exceeds 45° (16 headings, max change of 2 steps per move).
  - Deterministic.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3: Implement.**
  - The state is (cell, heading 0–15). Moves are the 16 directions (8 neighbours plus 8 knight moves).
  - A heading change is allowed only up to ±2 sectors, with a turn penalty of `turnPenalty × |Δ|` (default 0.15 × step length).
  - Use a binary heap, with Euclidean distance × min cost (0.5) as the heuristic.
  - Return the path with collinear cells removed.
- [ ] **Step 4:** Run; PASS. Commit `feat(arterials): heading-aware routing`.

### Task 3: Hubs, exits and the mesh (`hubs.ts`, `mesh.ts`)

**Files:** Create `src/stages/arterials/hubs.ts`, `mesh.ts`; Tests `hubs.test.ts`, `mesh.test.ts`

**Interfaces:**

```ts
// hubs.ts
export function poissonHubs(fixed: Point2[], spacing: number, ok: (p: Point2) => boolean, bounds: { minX: number; minZ: number; size: number }, rng: () => number): Point2[]; // fixed first, then sampled
export interface Exit { at: Point2; inward: Point2 /* unit vector into the site */ }
export function placeExits(n: number, boundary: Point2[] /* site ring */, okEdge: (p: Point2) => boolean, flatness: (p: Point2) => number, rng: () => number): Exit[];
// mesh.ts
export interface Link { a: number; b: number; required: boolean }
export function buildMesh(hubs: Point2[], cost: (a: number, b: number) => number, o: { redundancy: number; minAngle: number; maxLen: number; blocked: (a: number, b: number) => boolean }): { links: Link[]; sharp: number };
```

- [ ] **Step 1: Failing tests:**
  - `poissonHubs`: no two hubs closer than 0.7 × spacing; fixed points kept first; all pass `ok`; deterministic.
  - `placeExits`: on a square site with okEdge false along one side, 3 exits all lie on allowed sides, are at least a quarter of the perimeter apart where possible, and have unit inward vectors. Asking for 8 on a tiny allowed edge gives fewer.
  - `buildMesh`:
    - required links form a spanning tree over the reachable hubs;
    - redundancy 0 → no extra links, and redundancy 1 → every allowed Delaunay link within maxLen;
    - no two links at a hub meet below `minAngle`, except counted `sharp` ones that are required;
    - `blocked` links are excluded;
    - deterministic.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3: Implement.**
  - Poisson: dart throwing with a grid accelerator, about 30 tries per accepted point.
  - Exits: sample the boundary every 10 m, keep the allowed samples, and pick by farthest-point along the perimeter, preferring flatness among nearby samples.
  - Mesh:
    1. Delaunay over the hubs; drop links that are blocked or longer than maxLen.
    2. Kruskal on `cost` gives the required tree.
    3. Sort the remaining links by cost and take them while kept/total < redundancy, skipping any that breaks `minAngle` at either end.
    4. A required link that breaks the angle counts as `sharp`.
- [ ] **Step 4:** Run; PASS. Commit `feat(arterials): hubs, exits and the link mesh`.

### Task 4: Smoothing and the sliver test (`smooth.ts`, `space.ts`)

**Files:** Create `src/stages/arterials/smooth.ts`, `space.ts`; Tests `smooth.test.ts`, `space.test.ts`

**Interfaces:**

```ts
// smooth.ts
export function smoothRoad(line: Point2[], radius: number): Point2[];  // simplify(3 m) → chaikin(3); endpoints kept
export function tightBends(line: Point2[], radius: number): number;     // vertices whose circumradius < radius
// space.ts
export function slivers(district: MultiPolygon, roads: MultiPolygon, usableWidth: number): MultiPolygon[]; // pieces of district − roads that are slivers
```

- [ ] **Step 1: Failing tests:**
  - `smoothRoad` on a right-angle polyline (two 200 m legs) keeps the endpoints, and `tightBends(result, 60)` is 0. On a zig-zag of 20 m steps it reduces the vertex count.
  - `tightBends` on a 90° corner with 10 m legs is ≥ 1.
  - `slivers`:
    - a 250 m square cut by a 25 m road through its middle → no slivers;
    - the same road 30 m from one edge (usableWidth 60) → one sliver;
    - a road along the edge (outside the district) → no pieces flagged.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3: Implement.**
  - `smoothRoad` uses `simplifyLine` and `chaikin`.
  - Circumradius from three consecutive points.
  - `slivers` = `difference(district, roads)`. Each polygon is a sliver if `area(offsetPolygons([poly], −usableWidth/2)) === 0` or its area is under 0.25 × area(district).
- [ ] **Step 4:** Run; PASS. Commit `feat(arterials): road smoothing and the sliver test`.

### Task 5: The stage

**Files:**
- Create: `src/stages/arterials/stage.ts`
- Modify: `src/stages/index.ts` (add after `districts`)
- Test: `src/stages/arterials/stage.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; district nodes (kind `district`, attrs `type`, `anchor`, `terrain`) and terrain nodes.
- Produces: `export const arterials: Stage`.

- [ ] **Step 1: Failing tests.** The helper runs terrain, then districts, then arterials (pattern of `districts/stage.test.ts`, with caching).
  - Partitions: every district's children partition it, using the districts test's perimeter tolerance. The river's children partition it.
  - Connected: union-find over road polylines sharing endpoints or crossing.
  - Every reachable district touches some road band, or `stats.unreachable` accounts for it.
  - `exits` stat = the requested count where the land edge allows, and each exit road has an endpoint on the site boundary.
  - No road band intersects the sea or a pond by more than 1 m².
  - Every river crossing yields a bridge child.
  - Junction angles respect the setting, apart from `sharpJunctions`; `tightBends` ≤ `stats.tightCurves`.
  - Slivers: the recomputed count ≤ `stats.slivers`.
  - Mean road grade (sampled every 10 m) < 0.6 × the mean grade of straight hub-to-hub segments.
  - Lowering maxGrade to 4 doesn't raise `overGrade` past maxGrade 12's.
  - Deterministic.
  - `stats.ms` < 1500 at defaults.
  - Extremes keep the partition and don't throw:
    - `{ shore: 'none', river: false }` (terrain);
    - `{ relief: 400, hilliness: 1 }` (terrain);
    - `{ spacing: 300 }`, `{ spacing: 1500 }`;
    - `{ redundancy: 0 }`, `{ redundancy: 1 }`;
    - `{ exits: 8 }`, `{ junctionAngle: 90 }`, `{ curveRadius: 200 }`, `{ maxGrade: 2 }`, `{ usableWidth: 150 }`.
- [ ] **Step 2:** Run; FAIL.
- [ ] **Step 3: Implement `run`.** Leaves = district nodes plus the river node.
  1. Build the grid:
     - `elevAt` = `groundHeightAt(tree)`;
     - `kindAt`: sea and pond are BLOCKED, river is RIVER, a hills district is HILLS, otherwise LAND; outside the site is BLOCKED.
  2. Hubs:
     - fixed = centroids of anchor districts (`main`, `minor`) nudged to the lowest-grade cell within 60 m;
     - then `poissonHubs` with `ok` = land/hills cell with local grade ≤ maxGrade (relaxed if none nearby).
  3. Mesh:
     - link cost estimate = straight-line integral of `stepCost`;
     - blocked if the segment crosses the sea or a pond for more than 30% of its length;
     - maxLen 1.8 × spacing.
  4. Route links: required first by cost, then loops. Each route uses the `cell` goal, or `touches` an existing road where a hub already has one. Then `smoothRoad` and `markRoad`.
  5. Exits: `placeExits` (okEdge = land and not sea). Route from just inside each exit (startHeading = inward) to `touches` the network.
  6. Reach: for each untouched district, route from the nearest road with `touches` = cell inside that district (border corridor preferred by cost). Count `spurs`, and `unreachable` where `null`.
  7. Bands = `offsetPolyline(line, roadWidth/2)` per road; union them all.
  8. Slivers: per district, `slivers()`. If a loop road causes any, drop that road (recompute from the union of the remaining bands) and re-check; required roads stay and are counted.
  9. Cut:
     - per district: `intersect(fp, roads)` → arterial pieces (split by road id: intersect with each road's band minus earlier roads' bands); `difference(fp, roads)` → superblocks (each polygon its own superblock);
     - river: the same, giving bridge pieces and a water remainder.
  10. Stats, `data.roads`, and the time.
- [ ] **Step 4:** `npm run typecheck && npx oxlint src && npm test`; all pass.
- [ ] **Step 5:** Commit `feat(arterials): arterials stage`.

### Task 6: Renderer, docs, visual check

**Files:**
- Create: `src/scene/renderers/arterials.ts`
- Modify:
  - `src/scene/renderers/districts.ts`: export a `districtTint(nodes, tree, extra?)` helper that returns the texture, or factor it out to `scene/renderers/tint.ts`;
  - `src/scene/renderers/index.ts`;
  - `CLAUDE.md`.

- [ ] **Step 1: Implement.**
  - The arterials renderer:
    - superblocks get their district's colour (look up the parent district's `type`);
    - arterial pieces get asphalt `#3a3a3e` at alpha 0.95;
    - `buildTerrain` with the tint;
    - bridge decks are meshes: each bridge footprint triangulated with `flatSurface`, at max(ground along its edge) + 1 m, colour `#55555a`;
    - picking over superblocks, arterials and bridges;
    - texture disposal via `userData.dispose`.
  - Refactor the districts renderer onto the shared helper. Rasterise only the polygon's row range (deferred minor from districts).
- [ ] **Step 2:** `npm run typecheck && npx oxlint src && npm test && npm run build`.
- [ ] **Step 3: Visual check.**
  - Plan-view SVGs: seeds 1–3; spacing 400/700/1200; redundancy 0/0.6.
  - App screenshot via `scratchpad/cdp.mjs`, clicking Next twice.
  - Check: connected, roads hug borders, contour-following on slopes, gentle curves, exits on land edges, bridges over the river.
- [ ] **Step 4: Docs.** CLAUDE.md:
  - Stages so far, plus the spec link;
  - a `stages/arterials/` bullet;
  - the renderer note that roads add no triangles (bridges a handful);
  - "arterial roads come next" becomes the next stage name (local roads; collectors pinned).
- [ ] **Step 5:** Commit `feat(arterials): renderer`. Then the final review, then a fast-forward merge.

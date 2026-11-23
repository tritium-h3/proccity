# Districts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `districts` stage that cuts terrain land regions into districts and assigns each a type through an anchored, budgeted, table-constrained fill, plus a renderer that tints the terrain by type.

**Architecture:** Pure modules under `src/stages/districts/`:
- `rules.ts`: types, table, terrain rules, budgets.
- `cut.ts`: region → district footprints.
- `graph.ts`: adjacency, travel and width.
- `fill.ts`: anchors, fill, repair.
- `stage.ts`: assembly.

The renderer refactors the terrain renderer to accept an optional tint texture, rasterised from district footprints, so districts add no triangles.

**Tech Stack:** TypeScript 7, Vitest, d3-delaunay (already a dependency), clipper2-ts via `grammar/clipper.ts`, Three.js TSL.

**Spec:** `docs/superpowers/specs/2026-11-23-districts-design.md`

## Global Constraints

- Type ids: `undeveloped`, `rural`, `suburban`, `town-core`, `town-business`, `low-urban`, `urban`, `financial`. Ranks 0–7 in that order.
- **Neighbour table** (symmetric; `undeveloped` borders anything):
  - rural: rural, suburban, town-core, town-business
  - suburban: rural, suburban, town-core, town-business
  - town-core: rural, suburban, town-core, town-business, low-urban
  - town-business: rural, suburban, town-core, town-business, low-urban, urban
  - low-urban: town-core, town-business, low-urban, urban, financial
  - urban: town-business, low-urban, urban, financial
  - financial: low-urban, urban, financial
- **Terrain rules:** hills are only undeveloped; slopes take undeveloped, rural, suburban or town-core; flat takes anything.
- **Budget maxima** (share of land area, at Growth g):
  - financial 0.06g; urban 0.16g; low-urban 0.20g;
  - town-business 0.08 + 0.10g; town-core 0.15; suburban 0.35;
  - rural and undeveloped uncapped.
- **Main centre type:** financial if g ≥ 0.3, urban if ≥ 0.2, low-urban if ≥ 0.1, else town-core.
- **Settings:**
  - `districtSize`: "District size", 2–30, step 1, default 8, ha. Help: "Regions bigger than about 1.5 × this are cut into several districts".
  - `settlements`: "Settlements", 1–8, step 1, default 4. Help: "Centres, including the main one".
  - `growth`: "Growth", 0–1, step 0.05, default 0.5. Help: "From villages to a city".
- **Wide patch:** contains a hill, or its merged footprint survives `offsetPolygons(fp, -50)` with area > 0.
- **Touch:** shared boundary ≥ 3 m. Districts with no land between them across water: travel only, factor 5, within 1.5 × riverWidth (use 60 m if no river).
- **Terrain factors:** flat 1, slope 2, hills 4.
- **Fill constants:** step 250 m, σ = 1, Undeveloped weight 0.05.
- **Main centre:** among the top 3 scores. **Minor centres:** spacing ≥ 600 m travel.
- **Node shape:** kind `district`, id `<region id>/district:N`, attrs `{ type, terrain, anchor? }`.
- **Override:** `overridable.district = [{ key: 'type', type: 'choice', options: the 8 types, default: 'rural' }]`.

## Review Focus

- **No districts possible.** No land at all (a site that's entirely water), or terrain not yet generated. The stage returns no children and doesn't throw. → Task 4 test.
- **No flat land at all** (relief 400, hilliness 1). There's no main centre candidate. Fall back to the best slope district as a town-core centre, or no centre if only hills exist, and the fill still completes. → Task 3 test (all-slope graph) and Task 4 extremes.
- **Settlements greater than suitable districts.** Fewer minor centres are placed; no crash. → Task 3 test.
- **Pins that conflict with the terrain** arrive via `overridesForStage` before validation (resolution drops them later). `assignTypes` ignores a pin the terrain forbids. → Task 3 test.
- **A shielded squeeze forcing repair.** The result has zero table violations, and pins are never changed. → Task 3 test.

---

### Task 1: `rules.ts` and `cut.ts`

**Files:**
- Create: `src/stages/districts/rules.ts`, `src/stages/districts/cut.ts`
- Test: `src/stages/districts/rules.test.ts`, `src/stages/districts/cut.test.ts`

**Interfaces (produces):**

```ts
// rules.ts
export const TYPES: readonly DistrictType[];          // rank order
export type DistrictType = 'undeveloped' | 'rural' | 'suburban' | 'town-core' | 'town-business' | 'low-urban' | 'urban' | 'financial';
export type TerrainKind = 'flat' | 'slope' | 'hills';
export const RANK: Record<DistrictType, number>;
export function mayBorder(a: DistrictType, b: DistrictType): boolean;
export function allowedOn(t: DistrictType, terrain: TerrainKind): boolean;
export function budgets(growth: number): Record<DistrictType, number>; // share; Infinity = uncapped
export function mainCentreType(growth: number): DistrictType;
export const TYPE_LABEL: Record<DistrictType, string>;  // 'Town core' etc.

// cut.ts
export function cutRegion(fp: MultiPolygon, k: number, rng: () => number): MultiPolygon[];
```

- [ ] **Step 1: Failing tests.**
  - rules:
    - `mayBorder` is symmetric over all 64 pairs.
    - Spot checks: rural–financial false; suburban–low-urban false; town-core–low-urban true; undeveloped–financial true.
    - `allowedOn`: town-business on slope false; town-core on slope true; rural on hills false.
    - `budgets(0).financial === 0`; `budgets(1).urban ≈ 0.16`.
    - `mainCentreType(0.5) === 'financial'`, `(0.25) === 'urban'`, `(0.05) === 'town-core'`.
  - cut:
    - k = 1 returns `[fp]`.
    - A 400×200 m rectangle with k = 4 → 4 pieces whose areas sum to the rect's (to 1e-6 relative), each a single polygon, `checkPartition(makeSlab(fp), pieces.map(p => makeSlab(p))).ok`, and each piece ≥ 0.4 × mean area.
    - An L-shaped region with k = 3 → partition ok and every piece is one polygon (fragments reassigned).
    - Deterministic for the same rng seed (`createRng(1)`).
- [ ] **Step 2:** Run `npx vitest run src/stages/districts`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement.**
  - `cutRegion`:
    - farthest-point sampling of k seeds from about 200 random interior points (rejection-sample inside the bounds);
    - 2 Lloyd iterations: Voronoi via `Delaunay.from(seeds).voronoi(bounds)`, each cell clipped with `intersect` to the region, seed moved to the clipped cell's centroid;
    - a final clip;
    - for each piece's extra polygon parts, `union` them into the piece whose footprint, `offsetPolygons(·, 0.5)`, overlaps them most.
- [ ] **Step 4:** Run the tests; expect PASS. Then `npm run typecheck && npx oxlint src`.
- [ ] **Step 5:** Commit `feat(districts): types, neighbour table, region cutting`.

### Task 2: `graph.ts`

**Files:**
- Create: `src/stages/districts/graph.ts`
- Test: `src/stages/districts/graph.test.ts`

**Interfaces:**
- Consumes: `TerrainKind` from Task 1.
- Produces:

```ts
export interface DistrictInfo { footprint: MultiPolygon; terrain: TerrainKind; area: number; centroid: Point2 }
export interface DistrictGraph {
  neighbours: number[][];                          // touching (shared ≥ 3 m), sorted
  travel: { to: number; cost: number }[][];        // neighbours + water crossings
}
export function buildGraph(ds: DistrictInfo[], crossing: number): DistrictGraph;
export function travelFrom(g: DistrictGraph, sources: number[]): number[]; // Dijkstra; Infinity if unreachable
export function isWide(fp: MultiPolygon): boolean;  // offset −50 has area > 0
export function centroidOf(fp: MultiPolygon): Point2;
```

- [ ] **Step 1: Failing tests** on a 3×3 grid of 100 m squares, plus one square across a 40 m gap:
  - Grid squares sharing an edge are neighbours; diagonal squares are not.
  - Travel cost between flat neighbours equals the centroid distance (100). With one of them on a slope it's 200.
  - The gap square is not a neighbour of any square, but has a travel edge to the nearest square, at cost 5 × centroid distance, when `crossing = 60`, and none when `crossing = 20`.
  - `travelFrom` on the grid from a corner gives the opposite corner 400.
  - `isWide`: a 200×200 square is true; a 60×400 strip is false.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement.**
  - Shared length: `area(intersect(offsetPolygons(a, 1), offsetPolygons(b, 1))) / 2`, with a bounds prefilter.
  - Crossings: for non-neighbour pairs whose bounds are within `crossing`, the pair is linked if `intersect(offsetPolygons(a, crossing / 2), offsetPolygons(b, crossing / 2))` has area > 0.
  - Edge cost: centroid distance × max(terrain factor), × 5 for crossings.
- [ ] **Step 4:** Run; PASS. Typecheck and lint.
- [ ] **Step 5:** Commit `feat(districts): district graph, travel distance, width test`.

### Task 3: `fill.ts`, anchors, fill and repair

**Files:**
- Create: `src/stages/districts/fill.ts`
- Test: `src/stages/districts/fill.test.ts`

**Interfaces:**
- Consumes: Task 1 rules; `DistrictGraph` and `travelFrom` from Task 2.
- Produces:

```ts
export type AnchorRole = 'main' | 'minor' | 'rural';
export interface FillInput {
  graph: DistrictGraph;
  terrain: TerrainKind[];
  area: number[];
  /** higher = better main-centre site (stage computes: flat area nearby, water, edge distance) */
  siteScore: number[];
  growth: number;
  settlements: number;
  pins: Map<number, DistrictType>;
  /** is this set of undeveloped districts a wide patch? (stage: hill inside, or merged footprint isWide) */
  isWidePatch(ids: number[]): boolean;
  rng: () => number;
}
export interface FillResult { types: DistrictType[]; anchor: (AnchorRole | null)[]; repairs: number }
export function assignTypes(input: FillInput): FillResult;
/** Pairs breaking the table: touching pairs, plus pairs touching one narrow undeveloped patch. */
export function tableViolations(types: DistrictType[], graph: DistrictGraph, isWidePatch: (ids: number[]) => boolean): [number, number][];
```

- [ ] **Step 1: Failing tests** on synthetic grid graphs (build `DistrictGraph` directly: 4-neighbour grid, travel cost 100 per edge; `isWidePatch` = patch size ≥ 3):
  - On a 12×12 all-flat grid with the defaults: `tableViolations` is empty; there's exactly one `main` anchor, of type financial; there's ≥ 1 rural; and every type's area share ≤ its budget, apart from anchor districts. Check seeds 1–10.
  - Growth 0: no low-urban, urban or financial.
  - Hills cells come out undeveloped; slope cells only undeveloped, rural, suburban or town-core.
  - All-slope grid: completes, has no main financial, and has no violations.
  - Settlements 8 on a 3×3 grid: completes, with fewer minor anchors.
  - Pins are kept exactly; a pin of financial on a slope is ignored.
  - **Squeeze:** a 1×3 line [pinned financial, free, pinned rural] with `isWidePatch` always false → completes; the pins are unchanged; and `tableViolations` lists only the pinned pair (financial–rural via the narrow undeveloped middle). Pins conflicting with each other are the user's choice. `repairs ≥ 1` or the middle is undeveloped.
  - **Patch chain:** `tableViolations` flags X–Y across two touching narrow undeveloped districts (X | U1 | U2 | Y).
  - Determinism for the same seed; different results for seeds 1 and 2 on the 12×12 grid.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement**, following spec §3–§5:
  1. **Anchors:**
     - The main centre is drawn uniformly from the top 3 `siteScore` flat districts. With no flat district, take the best slope district as town-core; with none, there's no main centre.
     - Minor centres are town-core, chosen by farthest travel from the placed centres, with ≥ 600 m travel and flat or slope terrain.
     - Rural anchor(s): the farthest district from all centres, on flat or slope. Add a second if another district is at least as far from every centre and anchor.
     - Then pins, then hills set to undeveloped.
  2. **Fill:** run a priority queue by travel distance from the nearest anchor. For each district:
     - Candidates obey the table with placed neighbours, plus shielded pairs through narrow patches using the current types; obey `allowedOn`; and have budget left.
     - Undeveloped is a candidate if the merged patch stays legal.
     - The expected rank is the max over anchors of `rank(anchor) − travel/250`. For rural anchors within 500 m, cap it at 2.
     - Weights: `exp(−(rank − expected)² / 2)` for candidates, and 0.05 for undeveloped. Draw from `rng`.
     - With no candidate: make it undeveloped.
  3. **Repair:** while `tableViolations` is non-empty, step the denser non-pinned district of each violating pair down one rank (skip pairs where both are pinned); count `repairs`.
- [ ] **Step 4:** Run; PASS. Typecheck and lint.
- [ ] **Step 5:** Commit `feat(districts): anchored, budgeted fill with repair`.

### Task 4: The stage

**Files:**
- Create: `src/stages/districts/stage.ts`
- Modify: `src/stages/index.ts` (add `districts` after `terrain`)
- Test: `src/stages/districts/stage.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `export const districts: Stage` (id `'districts'`, title `'Districts'`).

- [ ] **Step 1: Failing tests.** Run terrain, then districts, via `generate`, or by calling `terrain.run` then `districts.run` on the tree after `attachChildren` (follow `stage.test.ts`'s `run` helper pattern).
  - Every land region (flat, slope, hills) has district children that pass `checkPartition`; water regions have none.
  - Zero `tableViolations` on the real graph, rebuilt from the output footprints, for seeds 1–6 at defaults.
  - Hills → undeveloped; slope types are limited to the allowed four.
  - At least one rural district. Exactly one `anchor: 'main'`, of type financial, at defaults.
  - Shares within budget, apart from anchors.
  - Growth 0 has no low-urban, urban or financial.
  - Deterministic; seeds 1 and 2 differ.
  - A type override pins its district; `validateOverride` refuses financial on a slope with "Financial needs flat land".
  - Extremes keep the partition and don't throw: `{relief: 400, hilliness: 1}`; `{districtSize: 2}`; `{districtSize: 30}`; `{settlements: 8}`; `{settlements: 1}`.
  - With no terrain (leaves = [site]), no children.
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement `run`:**
  - Land leaves have kind flat, slope or hills and `stage === 'terrain'`.
  - Cut with `k = max(1, round(area / (districtSize·1e4)))` for flat and slope; hills are uncut.
  - Build `DistrictInfo[]` and the graph (`crossing = 1.5 × riverWidth` from the terrain stage settings via `attr(leaf, 'riverWidth')`, default 60).
  - `siteScore` = flat area within 300 m (sum of the areas of flat districts whose centroid is within 300 m), + 40 if within 300 m of a water region, − 30 if within 200 m of the site edge.
  - `isWidePatch` merges the footprints with `union` (memoised by sorted id key) and checks a hill or `isWide`.
  - Pins come from `overridesForStage` (kind `district`, `settings.type`), matched by the anchor point.
  - Emit nodes; `StageOutput.data` on the site: `stats: { districts, repairs, centres }`.
  - Add `overridable` and `validateOverride`.
- [ ] **Step 4:** `npm run typecheck && npx oxlint src && npm test` → all pass.
- [ ] **Step 5:** Commit `feat(districts): districts stage`.

### Task 5: Renderer, docs, visual check

**Files:**
- Modify: `src/scene/renderers/terrain.ts`. Export `buildTerrain(nodes, opts: { tint?: { texture: THREE.DataTexture; minX: number; minZ: number; size: number } })`; `renderTerrain` calls it with `{}`. In `groundMaterial`, when a tint is given, sample it by `positionWorld.xz` and `mix(colour, tint.rgb, tint.a)`.
- Create: `src/scene/renderers/districts.ts`, `src/scene/renderers/rasterise.ts` (pure)
- Test: `src/scene/rasterise.test.ts`
- Modify: `src/scene/renderers/index.ts` (register `districts`), `CLAUDE.md`, `README.md` if it lists stages

**Interfaces:**
- Produces: `export function rasterise(polys: { footprint: MultiPolygon; rgba: [number, number, number, number] }[], minX: number, minZ: number, size: number, px: number): Uint8Array` (scanline even-odd fill, row-major, z rows).

- [ ] **Step 1: Failing test:** rasterising a 100×100 square at the centre of a 400 m area at 40 px gives the expected rgba inside (pixel 20,20) and zero alpha outside (pixel 2,2).
- [ ] **Step 2:** Run; expect FAIL.
- [ ] **Step 3: Implement.**
  - `rasterise`.
  - The districts renderer:
    - Find terrain nodes in `ctx.tree` (`stage === 'terrain'`).
    - Rasterise the districts at 1024 px over the site bounds. Palette alpha is 0 for undeveloped and 0.45 for the others. Palette:
      - rural `#c9b458`, suburban `#8fbf6a`, town-core `#d9884a`, town-business `#e0a03c`;
      - low-urban `#c86a8a`, urban `#a04aa8`, financial `#4a5ad0`.
    - Call `buildTerrain` with the tint.
    - Replace the pickables' `nodeIdAt` with a district lookup (containsPoint over the districts; fall back to the terrain lookup for water).
  - Register it.
- [ ] **Step 4:** `npm run typecheck && npx oxlint src && npm test && npm run build`. All pass; the build has only the known chunk warning.
- [ ] **Step 5: Visual check.** Render plan-view SVGs of district types for seeds 1–3 and Growth 0/0.5/1 (throwaway script in the scratchpad). Take a headless screenshot of the app after selecting the districts stage (CDP or plan view). Check: a gradient with no jumps, countryside present, irregular.
- [ ] **Step 6: Docs.** Update CLAUDE.md:
  - "Stages so far" includes districts, with a spec link;
  - an architecture bullet for `stages/districts/`: the modules, the table living in `rules.ts`, and the tint renderer;
  - the polygon budget note: districts add no triangles.
- [ ] **Step 7:** Commit `feat(districts): renderer tints the terrain by district type`. Then the final review, then a fast-forward merge to main and delete the branch.

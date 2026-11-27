# Sub-districts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new stage between arterials and blocks that cuts developed superblocks into
sub-districts with a density step (or Undeveloped), and a blocks stage that sizes its streets by
that step.

**Architecture:** Pure modules in `src/stages/subdistricts/` (ladder rules, density field,
assignment), a stage that cuts superblocks with the districts' Voronoi cutter, and changes to
the blocks stage's leaves, edge classification and spacing. A tinted renderer, as arterials.

**Tech Stack:** TypeScript 7, Vitest, clipper2-ts via `grammar/clipper.ts`, d3-delaunay (via
`districts/cut.ts`), Three.js renderer (`three/webgpu`).

**Spec:** `docs/superpowers/specs/2026-11-27-subdistricts-design.md`

## Global Constraints

- Stage id `subdistricts`, title `Sub-districts`, inserted in `STAGES` after `arterials`.
- Node kind `subdistrict`, ids `<superblock id>/sub:<n>`, attrs `step` (string `'0'`–`'9'`;
  `'0'` = Undeveloped), `code` (`'F9'`, `'U0'`), `label` (`'Financial High'`, `'Undeveloped'`).
  `step` is a string because the pipeline writes override values (choice strings) straight
  into attrs after `run`.
- Ladder (steps, densest first = level 1): Rural 1; Suburban 4,3,2; Town core 5,4; Town
  business 6,5; Low urban 7,6,5; Urban 8,7,6; Financial 9,8. Letters R S T B L U F. Words: 3
  levels High/Mid/Low, 2 levels High/Low, 1 level the type alone.
- `open[type]`: rural 0.5, suburban 0.35, town-core 0.15, town-business 0.1, low-urban 0.1,
  urban 0.08, financial 0.
- Settings (sub-districts): `subdistrictSize` 150 ha (50–600), `variation` 1 step (0–3),
  `openLand` 1 (0–2).
- Settings (blocks) replacing dense*/sparse* depth/length/collectors: `densestDepth` 70,
  `densestLength` 160, `densestCollectors` 400, `sparsestDepth` 150, `sparsestLength` 500,
  `sparsestCollectors` 900. Interpolated geometrically in step (9 = densest, 1 = sparsest).
- Interim lot factor: `2 ** ((9 - step) / 8)` on each side of the type's smallest lot.
- No layout distance hard-coded in metres: blur σ = 0.5·√(districtSize), noise wavelength
  √(districtSize), raster cell = site/200.
- Stages stay pure (no DOM/Three). Renderer in `scene/renderers/`. No new triangles.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A sub-district pinned to a step its (re-typed) district no longer allows: dropped with a toast,
  not applied. Test in Task 4.
- A developed sub-district surrounded by Undeveloped ones in a sparse district: assignment must
  refuse the open pick that isolates it. Test in Task 3.
- A border between two developed sub-districts must produce exactly one street (recorded once),
  not two. Test in Task 5.
- A saved city from before the stage: loads without errors and regenerates blocks over
  sub-districts. Test in Task 6.
- Changing a district's type re-runs sub-districts and blocks without stale nodes (the pipeline
  prunes by stage id; covered by the stage test regenerating from districts in Task 4).

---

### Task 1: The ladder (`rules.ts`)

**Files:** Create `src/stages/subdistricts/rules.ts`, `src/stages/subdistricts/rules.test.ts`

**Interfaces — Produces:**
- `STEPS: Record<Developed, number[]>` (densest first), `LETTER: Record<Developed, string>`
- `nominal(t: DistrictType): number` (mean of the range; undeveloped 0)
- `codeOf(t: Developed, step: number): string`, `labelOf(t: Developed, step: number): string`
- `allowed(t: Developed, step: number): boolean` (0 always true)
- `clampStep(t: Developed, f: number): number` (round, clamp into range)
- `OPEN: Record<Developed, number>`
- `lotFactor(step: number): number`, `spacing(step, s): { depth, length, collectors }`
  where `s` has the six densest/sparsest settings.

(`Developed` is the blocks' type `Exclude<DistrictType, 'undeveloped'>`; reuse it.)

- [ ] Tests: `codeOf('financial', 9) === 'F9'`, `labelOf('financial', 9) === 'Financial High'`,
  `labelOf('urban', 7) === 'Urban Mid'`, `labelOf('rural', 1) === 'Rural'`,
  `codeOf('urban', 0) === 'U0'`, `labelOf('urban', 0) === 'Undeveloped'`;
  `allowed('suburban', 5) === false`, `allowed('financial', 0) === true`;
  `clampStep('low-urban', 9.3) === 7`, `clampStep('low-urban', 5.4) === 5`; `nominal('suburban') === 3`;
  every pair of types that `mayBorder` (districts) has ranges at most 1 step apart;
  `spacing(9, S).depth === 70`, `spacing(1, S).depth === 150`, spacing monotonic;
  `lotFactor(9) === 1`, `lotFactor(1) === 2`. Run, see fail.
- [ ] Implement. Run `npx vitest run src/stages/subdistricts/rules.test.ts`: PASS.
- [ ] Commit `feat(sub-districts): the density ladder, codes and names`.

### Task 2: The density field (`field.ts`)

**Files:** Create `src/stages/subdistricts/field.ts`, `field.test.ts`

**Interfaces — Produces:**
`densityField(tree: RegionNode, opts: { districtSize: number; variation: number; seed: number }): { at(p: Point2): number; meanOver(fp: MultiPolygon): number }`

Raster over the site bounds, cell = site/200. Land cells (inside a district) carry
`nominal(type)` with weight 1; water/off-district cells weight 0. Separable Gaussian blur
(σ = 0.5·√(districtSize·1e4) m) of value·weight and of weight; field = ratio (where weight
blur > 0, else 0). Add smooth value noise: lattice at wavelength √(districtSize·1e4), seeded,
bicubic or smoothstep interpolated, scaled to ±`variation`. `meanOver` averages `at` over
raster cell centres inside the footprint (centroid if none).

- [ ] Tests on hand-built trees (a site with two districts side by side, Financial | Suburban,
  plus water): with `variation: 0`, field deep inside the Financial half ≈ 8.5 (±0.3), deep in
  Suburban ≈ 3, monotonic decreasing across the border; a district next to water has the same
  value as without the water (normalised); an Undeveloped district pulls its neighbour down;
  same seed → same values, `variation: 1` stays within ±1 of `variation: 0`. Fail first.
- [ ] Implement; tests PASS. Commit `feat(sub-districts): implied density field`.

### Task 3: Assignment (`assign.ts`)

**Files:** Create `src/stages/subdistricts/assign.ts`, `assign.test.ts`

**Interfaces — Produces:**
```ts
interface SubInfo { type: Developed; district: string; field: number; arterial: boolean; draw: number; pin?: number }
assignSteps(subs: SubInfo[], neighbours: number[][], openLand: number): { steps: number[]; openRefused: number }
```
Steps: every sub-district gets `clampStep(type, field)`, or its pin. Then, in index order
(the caller sorts by id), an unpinned one goes Undeveloped (0) when
`draw < OPEN[type] * (1 - field/9) * openLand`, unless refused: refused when afterwards any
developed sub-district can't reach one with `arterial` through developed neighbours, or its
district would have no developed sub-district left. Pinned 0s are applied before the draws and
never refused.

- [ ] Tests: no open picks with `openLand: 0`; all-zero draws in Rural with `arterial` on every
  one → all open except the last of the district; a chain A(arterial)–B–C where B's draw says
  open → B refused (C would be cut off), `openRefused === 1`; pin 0 honoured even if it cuts a
  neighbour off; pin step kept as given; Financial never open unpinned. Fail first.
- [ ] Implement; PASS. Commit `feat(sub-districts): step assignment with connectivity`.

### Task 4: The stage

**Files:** Create `src/stages/subdistricts/stage.ts`, `stage.test.ts`; modify
`src/stages/index.ts`, `src/doc/types.ts` + `src/doc/validate.ts` (`subdistrictStats?:
Record<string, number>`, as `blockStats`).

**Interfaces — Consumes:** Tasks 1–3, `cutRegion` (`districts/cut.ts`), `sharedLength`-style
touching (export `TOUCH` and a `touching(a, b)` helper from `districts/graph.ts` if needed),
`RoadIndex` (`blocks/roads.ts`) for "touches an arterial" (outline sampled every 20 m).
**Produces:** `subdistricts: Stage`; `overridable.subdistrict = [{ key: 'step', type: 'choice',
options '0'–'9' (label: the step and its meaning, e.g. '9 (F9 / densest)' is fine as generic
'Step 9', '0' = 'Undeveloped'), default '0' }]`; `validateOverride` refuses steps not
`allowed` for the node's `attrs.district` type (store `district: type` on the node so the check
needn't walk ancestors); site data `subdistrictStats` (`subdistricts`, `undeveloped`,
`undevelopedHa`, `openRefused`, `ha:<code>`, `ms`).

Run: developed superblocks (district type ≠ undeveloped) sorted by id; k =
area > 1.5·size ? round(area/size) : 1; pieces via `cutRegion`. Pins from
`overridesForStage` (newest wins, by anchor). Field via Task 2 with seed from `rng`. Draws from
a separate stream (`createRng(floor(rng()*2**32))`), one per sub-district in id order.

- [ ] Tests (10 km defaults, seeds 1–2, cached city through sub-districts): children partition
  each developed superblock (tolerance as in blocks' test); undeveloped superblocks have none;
  every code is valid for its district; some sub-district of a 3-level type in each seed has a
  step other than its type's middle (gradients exist); every developed sub-district reaches an
  arterial through developed ones; a pin (step '8' on a Financial sub-district) holds and the
  other sub-districts keep their steps; a pin on a sub-district whose district is re-pinned to
  Suburban is dropped (pipeline `dropped` non-empty). Fail first.
- [ ] Implement; PASS. Full `npm test` will now fail in blocks (leaves changed): expected,
  fixed in Task 5. Commit `feat(sub-districts): the stage`.

### Task 5: Blocks over sub-districts

**Files:** Modify `src/stages/blocks/stage.ts`, `divide.ts` (`BlockSettings`, `targets`,
`DivideCtx` gains `step: number`), `edges.ts` (`EdgeKind` gains `'edge'`), tests
`divide.test.ts`, `stage.test.ts`.

- Leaves: `kind === 'subdistrict' && attrs.step !== '0'`. Type via `attr(n, 'type')`.
- `targets(ctx)` = `spacing(ctx.step, ctx.s)` (Task 1). Family still from type (field only).
- `minBlockArea`/`minDepth` = smallest lot scaled by `lotFactor(step)` (area by its square).
- Edge classification, beyond the outline: arterial → `A`; offsite/water → `open`; another
  sub-district: developed → `border` (half each side, recorded once by key as now), Undeveloped
  → `edge` if this one's family is dense, else `open`; an Undeveloped district → `open`; same
  sub-district → `none`. An `edge` run takes a full collector width on this side
  (`intersect(fp, offsetPolyline(line, width, 'butt'))`); its street centreline is the run
  offset inward by half the width (`offsetPath`), recorded once (not shared).
- Stats: `edgeStreets`.

- [ ] Update tests first: the partition test walks developed sub-districts instead of
  superblocks; new test: two developed sub-districts that share a border produce one street on it
  (count streets whose centreline lies on the shared border: exactly 1); dense sub-district beside
  an Undeveloped sub-district has a collector along it, sparse doesn't; blocks in a step-2
  sub-district are larger on average than in a step-7 one (seed 1). `divide.test.ts` passes
  `step` in its ctx. Fail first.
- [ ] Implement; `npm test` all PASS. Commit `feat(blocks): divide sub-districts, sized by step`.

### Task 6: Saved cities

**Files:** Modify `src/editor/normalize.ts` and its test (`normalize.test.ts` if present, else
create).

A registry stage missing from the doc's stages, at an index ≤ the doc's generated range (mapped
by stage id: the id at the old `generatedThrough`), truncates `generatedThrough` to just before
it and prunes later stages' nodes from the tree (`pruneStages`). So an old blocks city loads
showing arterials, and the next-stage button builds sub-districts, then blocks.

- [ ] Test: a doc with stages [terrain, districts, arterials, blocks], generatedThrough 3 and a
  tree holding blocks nodes → normalised generatedThrough 2 (arterials), no `blocks`-stage nodes
  left, stages list in registry order; a current doc is unchanged. Fail first.
- [ ] Implement; PASS. Commit `fix(editor): saved cities survive a stage inserted mid-pipeline`.

### Task 7: Rendering and the Inspector

**Files:** Create `src/scene/renderers/subdistricts.ts`; modify `renderers/index.ts`,
`renderers/blocks.ts` (Undeveloped sub-districts: no tint, as Undeveloped land), Inspector only
if `code`/`label` attrs don't already show (they will: it lists attrs).

Sub-district tint: `DISTRICT_COLOUR[type]` mixed towards white by `(levelIndex)/(levels)` ×
0.45 (level 1 full colour), alpha 0.85; Undeveloped untinted; arterial strips tinted as in the
arterials renderer; then `addArterials`. Sub-district outlines come from the view's outline
drawing as for any current-stage region.

- [ ] `npm run typecheck && npm run lint && npm run build`: clean.
- [ ] Visual check: restart the service, generate a 10 km city through sub-districts and blocks
  (CDP driver in the scratchpad), screenshot both stages; look for: visible level variation
  inside districts, Undeveloped patches more frequent in Rural/Suburban, no roadless blocks.
- [ ] Commit `feat(sub-districts): renderer`.

### Task 8: Docs and numbers

**Files:** `CLAUDE.md` (stage list, a `stages/subdistricts/` section, blocks section's leaves,
settings and edges), spec "As built" section with measured numbers (sub-districts per city,
undeveloped share, blocks count before/after, stage ms).

- [ ] Probe seeds 1–3: counts, undeveloped ha, blocks count, timing; write into the spec.
- [ ] Commit `docs: sub-districts stage`.

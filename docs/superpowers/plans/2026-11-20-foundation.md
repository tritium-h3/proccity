# proccity Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the proof of concept with the staged shape-grammar foundation: a city
document (a tree of named, volume-shaped regions), a stage pipeline that runs in a worker,
overrides pinned to map points, undo and redo, IndexedDB saving, and an editor around a 3D
view, all exercised by two throwaway debug stages.

**Architecture:** Pure TypeScript layers with no DOM or Three.js (`doc/`, `grammar/`,
`stages/`, `pipeline/`, `editor/history.ts`) are tested with Vitest. The pipeline runs in a
Web Worker. React holds editor state. The Three.js scene renders the tree through
per-stage renderers kept *outside* the stage modules, so the worker never bundles Three.

**Tech Stack:** TypeScript 7, React 19, Vite 8, Three.js r187 (`three/webgpu`), Vitest 5,
oxlint, `clipper2-js` (polygon booleans and offsets), `idb` (IndexedDB), `fake-indexeddb`
(tests).

**Spec:** `docs/superpowers/specs/2026-11-20-foundation-design.md`

## Global Constraints

- Latest versions of every dependency; TypeScript strict; `.js` specifiers in TS imports.
- Units are metres; ground is XZ, Y is up; points are `[x, z]`.
- Document format string is exactly `'proccity/1'`.
- Heights are `{ ref: 'ground', low, high }`, metres above ground; `high: null` = open to the sky.
- **Subtractive invariant:** children partition their parent volume. `checkPartition`
  tolerance is relative, `1e-6` of parent area.
- Clipper scale: `1000` (millimetre precision).
- Site default size `2000` m. Autosave debounce `1000` ms.
- IndexedDB database `proccity`, stores `cities` (key `id`) and `index`; last-opened city
  id in `localStorage['proccity:lastCity']`.
- Loading a saved city displays its stored tree and does **not** regenerate.
- **Git:** work on branch `foundation` (from `main`). Every task's final checkpoint step
  ends with a commit of that task's files: conventional message (`feat(grammar): …`) plus
  the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No pushing.
- Docs ride along: update `CLAUDE.md`/`README.md` in the task that makes them wrong.
- Checks every task must leave green: `npm test`, `npm run typecheck`, `npm run lint`.

## Deviations from the spec (decided while planning)

1. **Stage renderers live in `src/scene/renderers/`**, keyed by stage id, not as a
   `render` method on the stage. Otherwise the worker would bundle Three.js.
2. **Flexible `'~n'` split sizes are deferred** to stage 7, where repeat/floor splits need
   them. `split` takes absolute metres and `'<w>r'` relative weights.
3. **Editing an override regenerates from the override's own stage**, not the next one.
   Per-stage seeds make the stage's output identical, and re-resolution then re-merges
   attrs cleanly. Otherwise a deleted override's values would linger in kept nodes.
4. `CityDoc` gains `site: { size: number }`, and `StageState` gains `seedOffset: number`.
   Both were implied by the spec.
5. **Two throwaway stages** (`debug-grid`, `debug-split`), not one, so "Next", "Clear
   after", inheritance and vertical splits all have something to act on.

## Review Focus

1. **A corrupt, foreign or older-format JSON file is opened:** the user expects an error
   toast naming the problem, no crash, and nothing saved. *(Task 1 validation tests;
   Task 9 file test.)*
2. **Degenerate geometry:** a cutter that misses the slab or swallows it whole, or a split
   whose strip falls outside an irregular footprint. Expect empty pieces (`footprint: []`),
   never a throw, and the partition still holds. *(Task 2 tests.)*
3. **Rapid successive edits** (dragging through several slider values, mashing undo).
   Only the latest request's result may ever be applied; a stale result must never
   overwrite a newer one. *(Task 8 gate tests.)*
4. **IndexedDB unavailable or failing** (private browsing, quota). The editor keeps
   working, and the save indicator shows an error, which recovers on the next successful
   save. *(Task 9 autosave tests.)*
5. **Undo right after an override is dropped** restores that exact override (same id,
   anchor, settings) and it lands again. *(Task 7 history test plus the Task 5 resolution
   round trip.)*

---

## File structure

```
src/
  doc/        types.ts  tree.ts  validate.ts  create.ts            (+ *.test.ts)
  grammar/    clipper.ts  polygon.ts  slab.ts  ops.ts  partition.ts (+ *.test.ts)
  stages/     types.ts  settings.ts  index.ts
              debug-grid/stage.ts  debug-split/stage.ts             (+ *.test.ts)
  pipeline/   seeds.ts  generate.ts  overrides.ts  gate.ts  worker.ts  client.ts (+ *.test.ts)
  editor/     history.ts  history.test.ts  useCityEditor.ts
              Toolbar.tsx  StagePanel.tsx  SettingField.tsx  Inspector.tsx  Toasts.tsx  editor.module.css
  storage/    db.ts  autosave.ts  file.ts                           (+ *.test.ts)
  scene/      cityScene.ts (modified)  view.ts  slabMesh.ts
              renderers/index.ts  renderers/site.ts  renderers/debug.ts
  App.tsx (rewritten)  App.module.css (rewritten)
Deleted: src/city/ (generate.ts, generate.test.ts, rng.ts), src/scene/cityMeshes.ts
```

---

### Task 1: City document types, tree utilities, validation

**Files:**
- Create: `src/doc/types.ts`, `src/doc/tree.ts`, `src/doc/validate.ts`, `src/doc/create.ts`
- Test: `src/doc/tree.test.ts`, `src/doc/validate.test.ts`

**Interfaces:**
- Produces (`types.ts`, exactly):

```ts
export type SettingValue = number | string | boolean;
export type Settings = Record<string, SettingValue>;
export type Point2 = [number, number];             // [x, z]
export type Ring = Point2[];
export type Polygon = Ring[];                      // [outer CCW, ...holes CW]
export type MultiPolygon = Polygon[];
export interface HeightRange { ref: 'ground'; low: number; high: number | null }
export interface Slab { type: 'slab'; footprint: MultiPolygon; height: HeightRange }
export type Geometry = Slab;
export interface RegionNode {
  id: string; name: string; kind: string; stage: string;
  geometry: Geometry; attrs: Settings; children: RegionNode[];
}
export interface StageState { id: string; settings: Settings; seedOffset: number }
export interface Override {
  id: string; stage: string; kind: string; anchor: Point2;
  settings: Settings; createdAt: string;
}
export interface CityDoc {
  format: 'proccity/1'; id: string; name: string; createdAt: string; modifiedAt: string;
  seed: number; site: { size: number }; stages: StageState[];
  generatedThrough: number; overrides: Override[]; tree: RegionNode;
}
export const FORMAT = 'proccity/1';
export const SITE_ID = 'site';
```

- Produces (`tree.ts`): `childId(parentId: string, name: string): string` (`${parentId}/${name}`),
  `walk(root, fn: (n: RegionNode) => void): void`, `findById(root, id): RegionNode | undefined`,
  `ancestry(root, id): RegionNode[]` (root…node inclusive, `[]` if missing),
  `leaves(root): RegionNode[]`, `pruneStages(root, stageIds: Set<string>): RegionNode`
  (deep copy with every node whose `stage` is in the set removed),
  `attachChildren(root, children: Map<string, RegionNode[]>): RegionNode` (deep copy;
  appends to the named parents; throws `Error('unknown parent <id>')`).
- Produces (`validate.ts`): `class CityDocError extends Error`, `parseCityDoc(json: unknown): CityDoc`.
- Produces (`create.ts`): `createSite(size: number): RegionNode` (id/name/kind `'site'`,
  stage `'site'`, square footprint centred on origin, CCW, height `{ref:'ground',low:0,high:null}`);
  `createCityDoc(opts: { name: string; stages: { id: string; defaults: Settings }[]; seed: number; now: string; id: string }): CityDoc`
  (`generatedThrough: -1`, `site.size: 2000`, `seedOffset: 0`, `tree: createSite(2000)`).

- [ ] **Step 1: Write failing tests**

`tree.test.ts`, built on a fixture tree site → `a:0`, `a:1` → `a:1` has `b:0`:
- `leaves` returns ids `['site/a:0', 'site/a:1/b:0']`.
- `ancestry(root, 'site/a:1/b:0').map(n => n.id)` equals `['site','site/a:1','site/a:1/b:0']`; unknown id → `[]`.
- `pruneStages(root, new Set(['b']))` has no `b:0`, and the original still does (no mutation).
- `attachChildren` appends under `site/a:0` without mutating the input; an unknown parent throws `/unknown parent/`.

`validate.test.ts`:
- a document from `createCityDoc(...)`, round-tripped through `JSON.parse(JSON.stringify(doc))`, parses `toEqual` the original.
- `parseCityDoc({ ...doc, format: 'proccity/0' })` throws `CityDocError` matching `/format/`.
- `parseCityDoc('nope')`, `parseCityDoc(null)`, a doc missing `tree`, and a node with `geometry.type: 'box'` each throw `CityDocError`.

- [ ] **Step 2: Run `npx vitest run src/doc`.** Expected: FAIL (modules missing).
- [ ] **Step 3: Implement the four modules.** Validation is hand-written structural
  checking: object shape, `format`, recursive nodes with `type === 'slab'`, numeric
  `low`, `high` number or null. Messages name the offending path, e.g. `tree.children[2].geometry`.
- [ ] **Step 4: Run `npx vitest run src/doc`.** Expected: PASS.
- [ ] **Step 5: Checkpoint:** `npm run typecheck && npm run lint` both clean.

---

### Task 2: Polygon boundary, slabs and grammar operations

**Files:**
- Modify: `package.json` (add `clipper2-js`)
- Create: `src/grammar/clipper.ts`, `src/grammar/polygon.ts`, `src/grammar/slab.ts`, `src/grammar/ops.ts`
- Test: `src/grammar/polygon.test.ts`, `src/grammar/ops.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces (`clipper.ts`, the only file importing `clipper2-js`; scale `1000`):
  `union(a: MultiPolygon, b: MultiPolygon): MultiPolygon`, `intersect(a, b)`, `difference(a, b)`,
  `offsetPolygons(a: MultiPolygon, delta: number): MultiPolygon` (miter join, negative = inset),
  `offsetPolyline(line: Point2[], halfWidth: number): MultiPolygon` (butt ends).
  Build results with `Clipper64.executePolyTree` + `PolyTree64` and walk the tree so holes
  nest under their outer ring; outputs are CCW outer, CW holes. Use `FillRule.NonZero`.
- Produces (`polygon.ts`): `area(mp: MultiPolygon): number` (holes subtracted, ≥ 0),
  `containsPoint(mp, p: Point2): boolean` (boundary counts as inside),
  `bounds(mp): { minX: number; minZ: number; maxX: number; maxZ: number }`,
  `rect(minX, minZ, maxX, maxZ): MultiPolygon`.
- Produces (`slab.ts`): `makeSlab(footprint: MultiPolygon, low = 0, high: number | null = null): Slab`,
  `slabContains(s: Slab, p: Point2, h = 0): boolean`, `isEmpty(s: Slab): boolean` (area < 1e-9).
- Produces (`ops.ts`):

```ts
export type Size = number | `${number}r`;           // metres, or relative weight
export function split(s: Slab, axis: 'x' | 'z' | 'y', sizes: Size[]): Slab[];
export function cut(s: Slab, cutter: MultiPolygon): { inside: Slab; outside: Slab };
export function inset(s: Slab, d: number): { inner: Slab; border: Slab };
export function band(line: Point2[], width: number): MultiPolygon;
```

  `split` semantics: extent along the axis (footprint bounds for `x`/`z`; `high - low` for
  `y`). Absolute sizes take their metres; the remainder is shared among `r` sizes by
  weight; with no `r` sizes, any remainder is dropped from the last piece only if the
  absolute sizes overshoot. Throw if the absolute sizes exceed the extent. `x`/`z` pieces are
  `intersect(footprint, strip rect)` with the full height range, and the result **always has
  `sizes.length` entries** (empty footprint allowed). For `y` with `high: null`: exactly one
  `r` size, which must be last, becomes the open top; otherwise throw
  `Error('open slab: only a final relative size may be open')`.
  `inset`: `inner = offsetPolygons(fp, -d)`, `border = difference(fp, inner)`.

- [ ] **Step 1: Write failing tests**

`polygon.test.ts`: `area(rect(0,0,10,20)) === 200`; a 10×10 square with a 2×2 hole has
area 96; `containsPoint` is true at the centre and false inside the hole; `bounds` of
`rect(-1,-2,3,4)` round-trips.

`ops.test.ts` (A = `makeSlab(rect(0,0,100,50))`):
- `split(A,'x',[30,'1r','1r'])` → widths 30, 35, 35 (via `bounds`) and areas summing to 5000.
- `split(A,'x',[60,60])` throws.
- `split(makeSlab(rect(0,0,10,10),0,null),'y',[40,'1r'])` → heights `{0,40}` and `{40,null}`; with `[ '1r', 40 ]` it throws `/open slab/`.
- **Review Focus 2:** an L-shaped footprint split along `x` into a strip beyond the L's
  arm gives `isEmpty(piece) === true`, the array still has `sizes.length` entries, and the
  areas still sum to the parent's.
- `cut(A, rect(40,0,60,50))` → inside area 1000, outside 4000, outside has two polygons.
- **Review Focus 2:** `cut(A, rect(500,500,600,600))` → inside empty, outside area 5000,
  no throw; `cut(A, rect(-10,-10,200,200))` → outside empty.
- `inset(A, 5)` → inner area `90*40`, border area `5000 - 3600`.
- `area(band([[0,0],[100,0]], 10))` ≈ 1000 (±0.01).

- [ ] **Step 2: Run `npx vitest run src/grammar`.** Expected: FAIL.
- [ ] **Step 3: `npm install clipper2-js@latest`, then implement the four modules.**
- [ ] **Step 4: Run `npx vitest run src/grammar`.** Expected: PASS.
- [ ] **Step 5: Checkpoint:** typecheck and lint clean.

---

### Task 3: Partition checker (height bands)

**Files:**
- Create: `src/grammar/partition.ts`
- Test: `src/grammar/partition.test.ts`

**Interfaces:**
- Consumes: Task 2 `union`, `intersect`, `difference`, `area`.
- Produces: `checkPartition(parent: Slab, children: Slab[], relTol = 1e-6): { ok: boolean; problems: string[] }`.

Algorithm: treat `high: null` as `Infinity`. Breakpoints are the sorted unique values of
the parent and children lows and highs. For each band `[a, b)` inside the parent's range,
the children present are those with `low <= a && high >= b`. Then check:
- `area(union(present))` ≈ `area(parent)` (no gap)
- `Σ area(present)` ≈ `area(union)` (no overlap)
- `area(difference(union, parentFp))` ≈ 0 (no spill)

Also flag any child whose height range extends beyond the parent's. "≈" means within
`relTol * area(parent)`. Problems are human-readable and name the band and child
indices, e.g. `band 40–∞: overlap 12.5 m² (children 1,2)`.

- [ ] **Step 1: Write failing tests:** `ok` for the `split(A,'x',[30,'1r'])` pieces; `ok`
  for a `y` split of an open slab; `ok` for a mixed partition (left half full-height, right
  half split at 40 m into low and open); problem containing `gap` when one strip is
  missing; `overlap` when a strip is duplicated; `spill` when a child footprint pokes
  outside; `height` when a child's `high` exceeds a capped parent.
- [ ] **Step 2: Run `npx vitest run src/grammar/partition.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint:** typecheck and lint clean.

---

### Task 4: Stage contract, settings schema, attributes and debug stages

**Files:**
- Create: `src/stages/types.ts`, `src/stages/settings.ts`, `src/stages/index.ts`,
  `src/stages/debug-grid/stage.ts`, `src/stages/debug-split/stage.ts`
- Test: `src/stages/settings.test.ts`, `src/stages/debug.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (`types.ts`):

```ts
interface FieldBase { key: string; label: string; help?: string }
export type SettingField =
  | (FieldBase & { type: 'number'; min: number; max: number; step: number; default: number; unit?: string })
  | (FieldBase & { type: 'choice'; options: { value: string; label: string }[]; default: string })
  | (FieldBase & { type: 'boolean'; default: boolean });
export type SettingsSchema = SettingField[];
export interface StageInput {
  tree: RegionNode; leaves: RegionNode[]; settings: Settings; rng: () => number;
  /** resolveAttr bound to this tree and these settings */
  attr(node: RegionNode, key: string): SettingValue | undefined;
}
export interface StageOutput { children: Map<string, RegionNode[]> }
export interface Stage {
  id: string; title: string; settings: SettingsSchema;
  overridable?: Record<string, SettingsSchema>;     // node kind → accepted local settings
  run(input: StageInput): StageOutput;               // pure: no DOM, no Three.js
}
```

- Produces (`settings.ts`): `defaultsFor(schema): Settings`, `isValidValue(field, v: SettingValue): boolean`
  (type match; number within min/max; choice in options),
  `resolveAttr(ancestry: RegionNode[], key: string, stageSettings: Settings): SettingValue | undefined`.
  Precedence, strongest first: the node's own attrs, then the nearest ancestor's, then
  `stageSettings[key]`.
- Produces (`index.ts`): `export const STAGES: Stage[] = [debugGrid, debugSplit];`
- `debug-grid` (id `'debug-grid'`, title `'Debug grid'`): settings `cells` (number 2–12, step 1,
  default 6). It splits each leaf of kind `site` into `cells × cells` nodes of kind `cell`,
  named `cell:<i>-<j>`, with `attrs.colour` drawn by `rng` from
  `['red','amber','green','teal','blue','violet']`. `overridable: { cell: [colour choice field] }`.
- `debug-split` (id `'debug-split'`, title `'Debug split'`): settings `heightLimit` (number
  0–200, step 5, default 60, unit `'m'`). It splits each `cell` leaf in half along an axis
  chosen by `rng` into two `strip` nodes (`strip:0`, `strip:1`). When `heightLimit > 0`, each
  strip gets children `buildable` (0–`heightLimit`) and `airspace` (`heightLimit`–open). It
  sets no colour, since strips inherit `colour` via `attr`.

- [ ] **Step 1: Write failing tests**

`settings.test.ts`: `defaultsFor` of a three-field schema; `isValidValue` rejects out-of-range
numbers, unknown choices and wrong types; `resolveAttr` precedence (own > parent >
grandparent > stage setting > `undefined`).

`debug.test.ts` (run against `createSite(2000)` with `createRng(1)`, from Task 6 —
**until then use a local `() => 0.5`**):
- `debug-grid` with `cells: 3` produces 9 children under `site`, each with a valid colour, and `checkPartition(site, children)` is `ok`.
- running it twice with the same seeded rng yields `toEqual` outputs.
- `debug-split` on those cells: every cell gets 2 strips; with `heightLimit: 60` each strip partitions into `buildable` `{0,60}` and `airspace` `{60,null}` (`checkPartition` ok); with `heightLimit: 0`, strips have no children.

- [ ] **Step 2: Run `npx vitest run src/stages`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Stages use `split` from Task 2 and `childId` from Task 1.
- [ ] **Step 4: Run `npx vitest run src/stages`.** Expected: PASS.
- [ ] **Step 5: Checkpoint:** typecheck and lint clean.

---

### Task 5: Override resolution

**Files:**
- Create: `src/pipeline/overrides.ts`
- Test: `src/pipeline/overrides.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 2 (`containsPoint`), 4 (`Stage`, `isValidValue`).
- Produces:

```ts
export type DropReason = 'no-region' | 'invalid-setting' | 'superseded';
export interface DroppedOverride { override: Override; reason: DropReason; detail: string }
export interface Resolution { applied: Map<string, Settings>; kept: Override[]; dropped: DroppedOverride[] }
export function resolveOverrides(stage: Stage, created: RegionNode[], overrides: Override[]): Resolution;
export function describeDrop(d: DroppedOverride): string;
```

Rules (spec, Overrides section): consider only overrides with `o.stage === stage.id`, in
`createdAt` order.
- **Candidates** are created nodes of `o.kind` whose footprint contains `o.anchor`. With
  several, take the lowest `height.low`. None → `no-region`. The detail is the kind of
  whatever created node *does* cover the anchor (`'road'`), else `''`.
- **Every key** must exist in `stage.overridable?.[node.kind]` and pass `isValidValue`;
  otherwise `invalid-setting`, with the detail naming the key and value.
- **Same node and same key from a newer override:** the older one is dropped as
  `superseded`.

`applied` maps node id → merged settings; `kept` holds every override not dropped.

`describeDrop` copy, exactly (`k` = `o.kind`, and `s` = `key: value` pairs joined with `', '`):
- no-region with detail: `Dropped "${s}" on a ${k}: that spot is now a ${detail}.`
- no-region without: `Dropped "${s}" on a ${k}: there's no ${k} at that spot any more.`
- invalid-setting: `Dropped "${s}" on a ${k}: that ${k} doesn't accept ${detail}.`
- superseded: `Dropped "${s}" on a ${k}: a newer override on the same ${k} replaced it.`

- [ ] **Step 1: Write failing tests** on `debug-grid`'s 3×3 cells (use the Task 4 output):
  an anchor in cell `1-1` → applied to `site/cell:1-1`; an anchor outside the site →
  `no-region` with the no-detail copy; `colour: 'pink'` → `invalid-setting`; key `height`
  → `invalid-setting`; two overrides on one cell with the same key → older `superseded`,
  newer applied; an override for another stage id is untouched and stays in `kept`; a
  `buildable`/`airspace` pair at one anchor (kind `strip` vs children) picks the lowest.
  Plus `describeDrop` exact strings for all four forms.
- [ ] **Step 2: Run `npx vitest run src/pipeline/overrides.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint:** typecheck and lint clean.

---

### Task 6: Seeds and the generate pipeline

**Files:**
- Create: `src/pipeline/seeds.ts`, `src/pipeline/generate.ts`
- Test: `src/pipeline/generate.test.ts`, `src/pipeline/seeds.test.ts`
- Modify: `src/stages/debug.test.ts` (switch to `createRng`)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces (`seeds.ts`): `createRng(seed: number): () => number` (mulberry32, moved from
  `src/city/rng.ts`), `stageSeed(citySeed: number, stageId: string, offset: number): number`
  (FNV-1a of `stageId`, mixed with `citySeed` and `offset`, as uint32).
- Produces (`generate.ts`):

```ts
export interface GenerateRequest { doc: CityDoc; fromStage: number; stages: Stage[]; devChecks?: boolean }
export interface GenerateResult {
  tree: RegionNode; overrides: Override[]; dropped: DroppedOverride[]; partitionProblems: string[];
}
export function generateIter(req: GenerateRequest): Generator<{ stageIndex: number }, GenerateResult>;
export function generate(req: GenerateRequest): GenerateResult;   // runs generateIter to completion
```

Algorithm:
1. If `fromStage <= 0`, start from `createSite(doc.site.size)`. Otherwise start from
   `pruneStages(doc.tree, ids of stages[fromStage..])`.
2. For `i = max(fromStage, 0) … doc.generatedThrough`:
   - yield `{ stageIndex: i }`
   - run the stage with `leaves(tree)`, settings `{ ...defaultsFor(schema), ...docSettings }`,
     `rng = createRng(stageSeed(doc.seed, id, seedOffset))`, and `attr` bound via
     `ancestry`/`resolveAttr`
   - `attachChildren`
   - `resolveOverrides` on the nodes created by this stage, and merge `applied` into
     those nodes' `attrs`
   - when `devChecks`, run `checkPartition` for each parent that got children, and
     collect the problems prefixed with the parent id
3. The result's `overrides` = overrides for stages before `fromStage`, plus each processed
   stage's `kept`. Overrides for stages after `generatedThrough` are untouched.

- [ ] **Step 1: Write failing tests**
- `seeds.test.ts`: `stageSeed(1,'a',0) !== stageSeed(1,'b',0)`; changing `offset` changes it; stable across calls.
- `generate.test.ts`, with doc = `createCityDoc` over `STAGES`, `generatedThrough: 1`:
  - full generate gives 36 cells × 2 strips, and `partitionProblems` is `[]` with `devChecks: true`
  - **regenerate from stage 1 leaves stage 0 identical:** change `debug-split.heightLimit`,
    generate `fromStage: 1` from the previous tree; every `cell` node equals the earlier
    run (geometry and attrs)
  - same doc, generated twice from 0 → `toEqual`
  - `seedOffset` change on `debug-grid` changes cell colours
  - `generatedThrough: 0` → no strips (prune behaviour)
  - an override `colour:'violet'` anchored in a cell → that cell's attrs have it, and its
    strips resolve `colour` to `'violet'` via `resolveAttr`
  - **Review Focus 5 (part):** `site.size` shrunk so the anchor falls outside → the
    override appears in `dropped` as `no-region`, is absent from `overrides`, and
    re-running with the original size plus that override restored lands it again
  - `generateIter` yields `{stageIndex:0}`, then `{stageIndex:1}`, then returns
- [ ] **Step 2: Run `npx vitest run src/pipeline`.** Expected: FAIL.
- [ ] **Step 3: Implement both modules; delete `src/city/rng.ts` once nothing imports it.**
- [ ] **Step 4: Run `npm test`.** Expected: all PASS (POC generator tests still pass at this point).
- [ ] **Step 5: Checkpoint:** typecheck and lint clean.

---

### Task 7: Undo and redo history

**Files:**
- Create: `src/editor/history.ts`
- Test: `src/editor/history.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 4 `Stage`.
- Produces:

```ts
export interface EditState {
  seed: number; site: { size: number }; stages: StageState[];
  overrides: Override[]; generatedThrough: number;
}
export function editStateOf(doc: CityDoc): EditState;
export class History {
  constructor(initial: EditState);
  get current(): EditState;
  push(next: EditState, coalesceKey?: string): void;  // same key as previous push → replaces it
  undo(): EditState | null;
  redo(): EditState | null;
  get canUndo(): boolean; get canRedo(): boolean;
}
/** stage index to regenerate from when moving a→b; null = nothing to do */
export function regenerateFrom(a: EditState, b: EditState, stages: Stage[]): number | null;
```

`regenerateFrom` returns the minimum over:
- `0` if `seed` or `site.size` differ
- index `i` if `stages[i]` settings or `seedOffset` differ
- the stage index of any override added, removed or changed
- `min(a.generatedThrough, b.generatedThrough) + 1` if `generatedThrough` differs

It returns `null` if none apply. A new `push` clears the redo stack.

- [ ] **Step 1: Write failing tests:** push/undo/redo sequence; push after undo clears redo;
  coalescing (three pushes with key `'cells'` then undo returns to the pre-drag state);
  `regenerateFrom` for each rule, including `null`.
  **Review Focus 5:** state A has override O; state B, after an edit that dropped O, lacks
  it; `undo()` from B returns a state whose overrides deep-equal A's, including O's id
  and anchor.
- [ ] **Step 2: Run `npx vitest run src/editor`.** Expected: FAIL.
- [ ] **Step 3: Implement** (store snapshots via `structuredClone`).
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint:** typecheck and lint clean.

---

### Task 8: Worker, client and the latest-wins gate

**Files:**
- Create: `src/pipeline/gate.ts`, `src/pipeline/worker.ts`, `src/pipeline/client.ts`
- Test: `src/pipeline/gate.test.ts`

**Interfaces:**
- Consumes: Task 6 `generateIter`, Task 4 `STAGES`.
- Produces (`gate.ts`):
  `createLatestGate(): { next(): number; isLatest(ticket: number): boolean }`.
- Produces (`client.ts`):

```ts
export type GenerateOutcome = { status: 'done'; result: GenerateResult } | { status: 'superseded' } | { status: 'error'; message: string };
export interface GeneratorClient {
  run(doc: CityDoc, fromStage: number, onProgress?: (stageIndex: number) => void): Promise<GenerateOutcome>;
  dispose(): void;
}
export function createGeneratorClient(): GeneratorClient;
```

The worker receives messages `{ type: 'generate', ticket, doc, fromStage }` and
`{ type: 'cancel-before', ticket }`. It iterates `generateIter` with `devChecks:
import.meta.env.DEV`. Between stages it does `await new Promise(r => setTimeout(r, 0))`,
so newer messages arrive, and it abandons a run once a newer ticket has been seen. It
posts `progress`, `done` or `error` with the ticket. The client uses the gate: a result
whose ticket isn't latest resolves as `superseded`, and so does any pending promise when
a newer `run` starts. Worker creation:
`new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.

- [ ] **Step 1: Write failing tests (Review Focus 3):** tickets increase; after `next()`
  twice, the first ticket isn't latest and the second is; simulate out-of-order
  completion (ticket 2 resolves before 1) and assert only ticket 2 counts as latest.
- [ ] **Step 2: Run `npx vitest run src/pipeline/gate.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `gate.ts`, `worker.ts` and `client.ts`.**
- [ ] **Step 4: Run `npm test`.** Expected: PASS. The worker and client are verified in Task 11.
- [ ] **Step 5: Checkpoint:** typecheck and lint clean.

---

### Task 9: Storage: IndexedDB, autosave and JSON files

**Files:**
- Modify: `package.json` (add `idb`, dev `fake-indexeddb`)
- Create: `src/storage/db.ts`, `src/storage/autosave.ts`, `src/storage/file.ts`
- Test: `src/storage/db.test.ts`, `src/storage/autosave.test.ts`, `src/storage/file.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CityDoc`, `parseCityDoc`, `CityDocError`).
- Produces (`db.ts`): `interface CityIndexEntry { id: string; name: string; modifiedAt: string }`;
  `listCities(): Promise<CityIndexEntry[]>` (newest first), `loadCity(id): Promise<CityDoc | undefined>`,
  `saveCity(doc): Promise<void>` (writes both stores in one transaction),
  `deleteCity(id): Promise<void>`, `renameCity(id, name): Promise<void>`,
  `getLastCityId(): string | null`, `setLastCityId(id): void`.
- Produces (`autosave.ts`):
  `type SaveState = 'idle' | 'saving' | 'saved' | 'error'`;
  `createAutosaver(save: (doc: CityDoc) => Promise<void>, delayMs = 1000): { schedule(doc): void; flush(): Promise<void>; subscribe(fn: (s: SaveState) => void): () => void }`.
- Produces (`file.ts`): `cityToJson(doc): string` (pretty-printed, 2 spaces),
  `downloadCity(doc): void` (Blob + anchor; filename `<slug(name)>.proccity.json`),
  `importCity(text: string, newId: string, now: string): CityDoc` (parse, assign a new
  `id`, set `modifiedAt`), `readFileText(file: File): Promise<string>`.

- [ ] **Step 1: Write failing tests**
- `db.test.ts` (`import 'fake-indexeddb/auto'`): save two cities, and `listCities`
  returns newest first; load round-trips `toEqual`; rename updates both stores; delete
  removes both.
- `autosave.test.ts` (`vi.useFakeTimers()`): three `schedule`s within 1000 ms → one save
  with the last doc; states go `saving → saved`. **Review Focus 4:** a save that rejects →
  `error`; the next successful save → `saved`; `flush()` saves immediately.
- `file.test.ts`: `importCity(cityToJson(doc), 'new', now)` equals the doc with the new id
  and `modifiedAt`. **Review Focus 1:** `importCity('{not json', ...)` and a
  `format: 'proccity/0'` text both throw `CityDocError`, and nothing is written (assert
  `saveCity` was never called, via a spy in the calling helper).
- [ ] **Step 2: Run `npx vitest run src/storage`.** Expected: FAIL.
- [ ] **Step 3: `npm install idb@latest && npm install -D fake-indexeddb@latest`, then implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Checkpoint:** typecheck and lint clean.

---

### Task 10: Scene: render the tree, picking, highlight

**Files:**
- Modify: `src/scene/cityScene.ts`
- Create: `src/scene/view.ts`, `src/scene/slabMesh.ts`, `src/scene/renderers/index.ts`,
  `src/scene/renderers/site.ts`, `src/scene/renderers/debug.ts`
- Delete: `src/scene/cityMeshes.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 4 `STAGES`/`resolveAttr`, Task 2 `bounds`.
- Produces (`renderers/index.ts`):

```ts
export interface RenderContext { tree: RegionNode; isCurrent: boolean }
export interface Rendered { object: THREE.Object3D; pickables: PickableMesh[] }
export interface PickableMesh { mesh: THREE.Mesh; nodeIdForFace(faceIndex: number): string }
export type StageRenderer = (nodes: RegionNode[], ctx: RenderContext) => Rendered;
export const RENDERERS: Record<string, StageRenderer>;   // 'site', 'debug-grid', 'debug-split'
```

- Produces (`slabMesh.ts`): `slabMesh(nodes: RegionNode[], colourOf: (n: RegionNode) => THREE.Color, opts: { lift: number }): PickableMesh`.
  It merges every node into one `BufferGeometry` with vertex colours and records face
  ranges per node. Open-topped slabs become flat footprint triangles (`THREE.ShapeUtils`)
  at `y = lift`; capped slabs are extruded from `low` to `high` (side walls plus a top).
  Ground is flat (y = 0) until the terrain stage.
- Produces (`cityScene.ts`, replacing `setCity`):

```ts
export interface ViewState { tree: RegionNode; stages: Stage[]; generatedThrough: number; currentStage: number; selectedId: string | null }
export interface CityScene {
  ready: Promise<Backend>;
  setView(v: ViewState): void;
  onPick(fn: (hit: { nodeId: string; point: Point2 } | null) => void): void;
  dispose(): void;
}
```

What `setView` renders:
- the `site` renderer always
- for the current stage, its renderer for nodes created by that stage, as the "newest
  leaves" per the spec, with earlier stages hidden
- if `currentStage > generatedThrough`, nothing beyond the site

It refits the shadow camera to the site size. A pointer click without drag (under 4 px of
movement) raycasts the pickables; hits report the node id plus the ground point `[x, z]`
of the hit. The selected node draws as a `LineLoop` outline of its footprint, colour
`#e8925f`, lifted 0.3 m. Hover (pointermove, throttled to one raycast per frame) draws the
same outline at 40 % opacity. Debug renderers: `debug-grid` cells use their resolved `colour`
mapped to six fixed hex values; `debug-split` draws `buildable` capped slabs tinted by
inherited `colour` and skips `airspace`.

- [ ] **Step 1: Implement** (verified visually in Task 11, since the scene is untested by convention).
- [ ] **Step 2: Checkpoint:** `npm run typecheck && npm run lint` clean. `src/App.tsx` will
  not compile against the new `CityScene` until Task 11, so do Tasks 10 and 11 back to
  back, and run typecheck at the end of Task 11 if needed.

---

### Task 11: Editor UI, wiring, POC removal and docs

**Files:**
- Create: `src/editor/useCityEditor.ts`, `src/editor/Toolbar.tsx`, `src/editor/StagePanel.tsx`,
  `src/editor/SettingField.tsx`, `src/editor/Inspector.tsx`, `src/editor/Toasts.tsx`,
  `src/editor/editor.module.css`
- Rewrite: `src/App.tsx`, `src/App.module.css`
- Delete: `src/city/` (whole directory)
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces (`useCityEditor.ts`), a hook returning:

```ts
{
  doc: CityDoc | null; cities: CityIndexEntry[]; saveState: SaveState;
  generating: { stageIndex: number } | null; toasts: Toast[];
  currentStage: number; selectedId: string | null;
  canUndo: boolean; canRedo: boolean;
  actions: {
    newCity(): void; openCity(id: string): void; renameCity(name: string): void; deleteCity(id: string): void;
    importFile(file: File): void; download(): void;
    setSite(patch: Partial<{ size: number; seed: number }>, coalesceKey?: string): void;
    setStageSetting(stageIndex: number, key: string, value: SettingValue, coalesceKey?: string): void;
    reroll(stageIndex: number): void; nextStage(): void; clearAfter(stageIndex: number): void;
    selectStage(i: number): void; pick(hit: { nodeId: string; point: Point2 } | null): void;
    setOverride(nodeId: string, key: string, value: SettingValue): void; removeOverride(overrideId: string): void;
    undo(): void; redo(): void; dismissToast(id: string): void;
  };
}
interface Toast { id: string; kind: 'warning' | 'error' | 'info'; message: string; undoable: boolean }
```

Behaviour:
- **Every edit:** compute the next `EditState`, `history.push`, then call
  `regenerateFrom(prev, next)`. If not null, call `client.run` and, on `done`, set the doc
  (`tree`, `overrides` from the result), then autosave.
- **Drops:** one warning toast per run listing each `describeDrop` line, with `undoable:
  true`. Its Undo calls `actions.undo`.
- **Errors:** generation errors and import errors (`CityDocError` message) become error
  toasts. Storage errors show only through `saveState`.
- **Progress:** while `generating` is set, the toolbar shows `Generating: <stage title>…`.
- **Dev checks:** a non-empty `partitionProblems` is logged with `console.warn` (dev builds only).
- **`setOverride`** anchors at the last pick point, sets `stage`/`kind` from the node, and
  replaces an existing override that targets the same node and key.
- **Start-up:** load the last city (`getLastCityId`), else the newest, else
  `createCityDoc({ name: 'Untitled city', seed: random uint32, ... })`. Display the stored
  tree, **no regenerate**. A new city starts at `generatedThrough: 0` and generates stage 0
  immediately.
- **History** resets when the city changes.
- **Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z** are ignored while focus is in an input, select or
  textarea.

Layout per the spec's Editor sketch:
- **Toolbar:** a city menu (list, new, rename, delete with `confirm()`), undo/redo
  buttons, the save state (`saved ✓` / `saving…` / `not saved — storage unavailable`),
  Download, and Open (hidden file input).
- **Left StagePanel:** a Site entry (size slider 500–5000 step 100, seed number input),
  then stages with ✓ / ● / ○. The selected stage shows its fields via `SettingField`
  (range + value for number, select, checkbox), with Reroll, "Clear after this" and
  "Next ▸".
- **Centre:** the scene container.
- **Right Inspector:** breadcrumb from `ancestry` (each segment clickable to select it),
  kind, area (`m²`, via `area`), resolved attrs, and editable fields from the creating
  stage's `overridable[kind]` with an "(override)" badge and a remove button when one
  applies.
- **Bottom:** Toasts. Warnings persist until dismissed or undone; info toasts auto-hide
  after 4 s.

Sliders push history with `coalesceKey` `${stageId}.${key}` on `change` (release), not on
every `input`.

- [ ] **Step 1: Implement the hook and components; rewrite `App.tsx`/`App.module.css`
  (tokens only); delete `src/city/`.**
- [ ] **Step 2: Run `npm test && npm run typecheck && npm run lint`.** Expected: all clean
  (the POC tests are gone with `src/city/`).
- [ ] **Step 3: Visual check.** Restart with `npm run dev:restart`, then take a headless
  screenshot per `CLAUDE.md`. Expected: three panels, a 6×6 coloured grid, stage list with
  Debug grid ✓.
- [ ] **Step 4: Drive it over CDP** (real time, per `CLAUDE.md`):
  - Next ▸ → strips with buildable boxes appear
  - change `cells` to 4 → the grid regenerates, and the strips regenerate too
  - Ctrl+Z restores 6
  - click a cell → the breadcrumb shows `site › cell:…`
  - set colour → the cell recolours
  - change `cells` so the anchor maps elsewhere → still applied
  - shrink the site so the anchor is outside → a warning toast with the exact
    `describeDrop` copy and an Undo that restores it
  - reload the page → the same city reopens identically without regenerating (check
    that no generate message was posted)

  Capture a screenshot at each step and check them.
- [ ] **Step 5: Update `CLAUDE.md`** so the Architecture section describes `doc/`,
  `grammar/`, `stages/`, `pipeline/`, `editor/`, `storage/` and `scene/`. Cover the slab
  model, the subtractive invariant and `checkPartition`, how to add a stage (module plus
  `STAGES` line plus renderer), that stage renderers live in `scene/renderers` and why,
  the debug stages being throwaway, and loading without regenerating. Remove the POC
  description. **Update `README.md`**'s "current state" paragraph.
- [ ] **Step 6: Final checkpoint:** `npm test`, `npm run typecheck`, `npm run lint` and
  `npm run build` all succeed. Report to the owner with screenshots.

# proccity foundation: design

**Date:** 2026-11-20
**Status:** Draft, awaiting approval

## Intent

proccity generates a city in the browser **in stages, each one dividing the geometry the
previous stage produced**. It's a shape grammar: the owner has been watching lectures on
shape/split grammars and wants to build one. The stages, roughly:

1. Terrain
2. Districts (downtown office, downtown mixed, mid-density mixed, low residential, …)
3. Major arterial roads
4. Local roads and blocks
5. Lots
6. Lot sectioning (house, tower, driveway, garage, yard, …)
7. Building components (floors, facades, doors, windows, ledges, roofs, soffits, …)

A city is described by a **tree of named regions**. Every node is a piece of its parent:
a district is a piece of the site, a block a piece of a district, a window a piece of a
bay, of a facade, of a floor, of a building. Instanced objects (a window frame model)
may be placed into regions, but the regions themselves are always produced by dividing.

What the owner wants to do with a city, for now: **generate it, tweak it, view it, and
save it so it can be reproduced**. Saving stores the tree itself, not just the seed and
settings, because a seed only reproduces a city while the generator code is unchanged.
The saved JSON should describe the city well enough to export to Blender later.

This document covers **only the foundation**: the tree, the stage pipeline, overrides,
undo, saving, the editor shell and the 3D view. The seven city stages are each designed
separately with the owner, one at a time, after the foundation exists.

## Goals

1. A city is a JSON document holding a tree of named regions with **resolved geometry**,
   readable and reproducible without the generator.
2. Stages run in order. Changing a stage's settings regenerates that stage and every
   later one; earlier stages are untouched.
3. Each stage exposes generation settings in the editor. A stage declares its settings,
   and the editor builds the UI from that declaration.
4. **Local overrides:** a setting pinned to one region ("this block is a church").
5. Undo and redo for every edit, including a toast's Undo when an override is dropped.
6. Cities save to the browser (IndexedDB), and can be listed, opened, renamed and deleted.
7. A 3D view of the city as far as it has been generated. Clicking a region shows its path
   in the tree, which is also how a region is picked for an override.
8. The editor never freezes while generating.

## Non-goals (for now)

- The algorithms of the seven stages. Each gets its own design.
- Publishing a city to the server. Browser storage only; publishing may come later.
- Export to Blender/glTF. The format is designed to make it possible, nothing more.
- Rules as data or a text grammar language (approaches B and C below). Revisit at stages 5–7.
- Hand-editing geometry (dragging vertices, drawing roads).
- WebGPU-specific work. The renderer stays `WebGPURenderer`, which uses WebGL 2 where
  WebGPU is unavailable, and no device-loss fallback is added (owner's call).

## Anti-goals: failures even if it technically works

- **A stage that adds geometry outside what it was given.** That breaks the grammar.
- **An override that vanishes silently.**
- **A saved city that needs the generator code to be reproduced.**
- **The editor locking up during generation.**

## Approaches considered

How the grammar rules are expressed:

- **A. Rules as TypeScript code** over a shared library of grammar operations (split,
  repeat, inset, cut, component split). Fast to build and fully flexible. It also fits
  stages 1–4, which are fields and network algorithms that then carve polygons rather
  than classic splits. The grammar lives in code, so rules can't be inspected or saved.
- **B. Rules as data** (JSON rule sets run by a small engine). A real, inspectable grammar
  that could be saved with the city, but it needs a rule language designed up front, and
  stages 1–3 fit it badly.
- **C. A text grammar language** (CGA-like) with a parser. The purest form, but it's a
  language project on top of a city project.

**Chosen: A** (owner's decision). The operations library is named and shaped like
grammar operators. Whether stages 5–7 get a B-style data layer on top is decided when we
reach them.

## Constraints

- Standalone repo `~/projects/proccity`, linked from the pages gallery later. Stack per
  `~/.claude/CLAUDE.md`: latest versions, TypeScript 7 strict, React 19, Vite 8, Three.js
  (`three/webgpu`), CSS Modules plus tokens, Vitest, oxlint. Ports 5280–5282, systemd
  user service `proccity`. The owner has opened the ports in the firewall.
- Units are metres. Ground is the XZ plane, Y is up, and the site is centred on the origin.
- **Kept from the proof of concept:** repo setup, service, Vite/HTTPS/proxy config, the
  placeholder backend, and the scene basics in `src/scene/cityScene.ts` (renderer, camera,
  orbit controls, sun and shadows, fog). Instanced drawing as a technique.
  **Replaced:** `src/city/generate.ts`, `src/scene/cityMeshes.ts` and the current `App.tsx` UI.

---

## The city document

The unit of saving, undo and export. Plain JSON, versioned.

```ts
interface CityDoc {
  format: 'proccity/1';            // bump on breaking changes; loader checks it
  id: string;                      // uuid
  name: string;
  createdAt: string; modifiedAt: string;   // ISO
  seed: number;                    // per-stage seeds derive from this (see Pipeline)
  site: { size: number };          // metres; the root slab's square footprint
  stages: StageState[];            // one per registered stage, in order
  generatedThrough: number;        // index of the last generated stage, -1 = none
  overrides: Override[];
  tree: RegionNode;                // root = the site
}

interface StageState {
  id: string;                      // stage id, e.g. 'districts'
  settings: Record<string, SettingValue>;
  seedOffset: number;              // bumped by "reroll"
}

type SettingValue = number | string | boolean;

interface RegionNode {
  id: string;                      // path from the root, e.g. 'site/district:3/block:14'
  name: string;                    // last path segment, e.g. 'block:14'
  kind: string;                    // 'site' | 'district' | 'road' | 'block' | 'lot' | …
  stage: string;                   // id of the stage that created this node
  geometry: Geometry;
  attrs: Record<string, SettingValue>;   // what this node *is*: values set on it,
                                         // including applied overrides (see Attributes)
  children: RegionNode[];
}
```

- **Geometry is resolved and stored,** not re-derived. **Every region is a volume.** The
  foundation defines one kind, a terrain-hugging slab:

  ```ts
  interface Slab {
    type: 'slab';
    footprint: [x, z][][][];        // multipolygon: polygons → rings → points.
                                    // Outer rings CCW, holes CW.
    height: { ref: 'ground'; low: number; high: number | null };
                                    // metres above the ground beneath each point;
                                    // high: null = open to the sky ("edge of space")
  }
  ```

  Heights are measured from the ground, the way zoning limits work: a 40 m cap is 40 m
  above grade everywhere, so on a slope the slab's top follows the terrain (owner's call).
  The actual 3D shape comes from draping the slab over the terrain, which is in the tree
  as stage 1's output, so the document stays self-contained. JSON can't hold infinity,
  hence `null` for open.
- **Later stages add geometry kinds as they need them** by extending the `Geometry` union.
  Each new kind needs a serialiser and a containment test. Expected so far:
  - stage 1: terrain data
  - stage 6 or 7: buildings may need absolute heights (`ref: 'absolute'`) for a flat
    base, sitting on a plinth or cut into the slope
  - stage 7: faces and oriented boxes

  Each of those is designed with its stage. The foundation supports `ref: 'ground'` only.
- **Node ids are paths.** Siblings have unique names. Names are `kind:index` unless a
  stage has a better name (`facade:front`, `floor:3`).
- The **root** is created by the pipeline, not a stage: kind `site`, a slab with a square
  footprint from a site-size setting (my call: 2 km default), from the ground up, open to
  the sky. Site size and the city seed appear as a
  **Site** entry at the top of the stage list. Changing either regenerates everything.
  Every stage subdivides from there.

### The subtractive invariant

Stages only ever attach children to the **leaves** produced by earlier stages. A stage
may leave some leaves alone (a park block gets no lots); those stay leaves and are offered
to the next stage. (My call.)

- **Children partition their parent volume.** They don't overlap, and together they fill
  the parent exactly. Every bit of the site belongs to exactly one leaf, so nothing is left
  unaccounted for: a road is a node, a yard is a node, and so is the airspace above a
  height limit. (My call. It's the strict reading of "divide the geometry".)
- **Splits can go across the map or up.** Stages 1–6 will mostly split footprints, but any
  stage may split a slab vertically. A district height limit is exactly that: the
  district's slab splits into `buildable` (0–120 m) and `airspace` (120 m–open). That's
  the same operation that later cuts a building into floors. Nothing in the foundation
  assumes regions are flat.
- **Stage 7** may need a looser rule (children lie *within* their parent) once it
  introduces faces and boxes. Set in that stage's design.
- The foundation ships `checkPartition(parent, children, tolerance)` and uses it in every
  stage's tests. It works **in height bands**: between consecutive height breakpoints of
  parent and children, the footprints of the children present in that band must
  partition the parent's footprint. That covers footprint splits, vertical splits and
  mixtures. In dev builds the pipeline runs it after each stage and logs violations.
  Area tolerance is relative, around 1e-6 of parent area, to absorb clipping error.

### Attributes

How settings reach a node, from weakest to strongest:

1. the stage's settings
2. attributes inherited from ancestors (nearest ancestor wins)
3. the node's own `attrs`, which is where an applied override lands

Example: a stage reads `use` on a block. The district may say `use: 'mixed'`, an override
on the block says `use: 'church'`, and the block's value wins. The helper is
`resolveAttr(node, key, stageSettings)`, and stages use only that. This mirrors how
CGA attributes flow down the derivation tree.

## Stages

A stage is a TypeScript module implementing:

```ts
interface Stage<S extends Record<string, SettingValue>> {
  id: string;                         // stable; used in docs, seeds and node.stage
  title: string;
  settings: SettingsSchema<S>;        // drives the settings panel
  /** local settings this stage's output nodes accept as overrides, per node kind */
  overridable?: Record<string, SettingsSchema<Record<string, SettingValue>>>;
  /** attach children to the given leaves. Pure; no DOM, no Three.js. */
  run(input: StageInput<S>): StageOutput;
}
// Rendering lives in src/scene/renderers/, keyed by stage id, not on the stage, so the
// worker that runs stages never bundles Three.js. (Changed during planning.)

interface StageInput<S> {
  tree: RegionNode;                   // read-only view, earlier stages only
  leaves: RegionNode[];               // nodes this stage may subdivide
  settings: S;
  rng: () => number;                  // seeded per stage (see Pipeline)
}
interface StageOutput { children: Map<string, RegionNode[]> }   // parent id → new children
```

`StageOutput` only adds children. If terrain needs to attach a heightfield to the site
rather than divide it, stage 1's design extends `StageOutput`. The foundation doesn't
guess at that.

- A settings schema is a list of fields. Each field is one of: number (min, max, step,
  default, unit), choice (options, default) or boolean (default), with label and help
  text. The editor renders sliders, selects and toggles from it.
- `render` lives with the stage, so each stage owns how its regions look. Open-topped
  slabs are drawn as footprints on the ground, not as infinitely tall columns. The scene layer
  asks each generated stage to render its own nodes, shows the newest stage, and draws
  earlier stages dimmed or hidden. (My call: show the newest stage's leaves, with the
  site/terrain always visible.)
- Stages are listed in `src/stages/index.ts`, in order. Adding a stage means one module
  plus one line there.
- **The foundation ships one throwaway stage**, `debug-grid`, because the pipeline,
  overrides and undo need something real to exercise. It splits the site into an N×N grid
  of cells with an overridable `colour`, and is deleted when stages 1–2 land.

## Grammar operations (`src/grammar/`)

Pure geometry, named after grammar operators, working on slabs (footprint operations
use 2D polygon maths underneath). The foundation implements only what the pipeline and
`debug-grid` need, plus the operations stages 2–4 obviously need:

- `split(slab, axis, sizes)`: slice into pieces along `x`, `z` (footprint strips) or `y`
  (height bands). Sizes are absolute metres or relative weights (`'1r'`). CGA-style flexible
  sizes (`'~3.2'`) are deferred to stage 7. (Changed during planning.)
- `cut(slab, cutterFootprint)` → `{ inside, outside }`: footprint
  difference/intersection over the full height range, e.g. a road out of a district.
- `inset(slab, d)` / `offset(polyline, d)`: shrink a footprint, or widen a centreline
  into a band (road widths, pavements, setbacks).
- `area`, `contains(slab, point)` (a ground point, plus an optional height above ground),
  `bounds`, `checkPartition`.

**Library:** `clipper2-js` (Clipper2 port), my call. It does both booleans and
offsetting, and uses integer coordinates internally, which makes it robust. Scale
metres to integers at the boundary (a scale of 1000 gives millimetre precision). The
builder may substitute `polyclip-ts` for booleans if Clipper2 misbehaves, with the reason
noted. 3D operations (component split, extrude, roof) come with stages 6–7.

## Pipeline

- `generate(doc, fromStage)`: prune every node whose `stage` is at index ≥ `fromStage`,
  then run stages `fromStage … generatedThrough` in order. Each stage gets the current
  leaves, its settings and its seeded RNG, and its output is attached to the tree.
  Overrides are resolved after each stage (see below).
- **Per-stage seeds:** `hash(doc.seed, stage.id)`. Re-running a stage with the same
  input and settings reproduces it exactly, which makes undo exact and keeps "regenerate
  from stage 4" from disturbing stages 1–3. Seeding is a means, not a feature. A "reroll"
  button per stage changes only that stage's seed offset (stored in `StageState` as
  `seedOffset`, my call).
- **Advancing:** the editor has a current stage. "Next stage" generates one more stage
  (`generatedThrough + 1`) and doesn't regenerate earlier ones.
- **Runs in a Web Worker.** The main thread posts `{ doc-without-tree, fromStage }` plus the
  pruned tree, and the worker returns the new tree, the override report, and progress
  per stage. A newer request supersedes an in-flight one (the worker checks a generation
  counter between stages and abandons stale work). The UI stays live and shows progress.

## Overrides

```ts
interface Override {
  id: string;
  stage: string;          // the stage whose output it targets, e.g. 'blocks'
  kind: string;           // node kind it applies to, e.g. 'block'
  anchor: [number, number];     // ground point (x, z) where the user made it
                                // (a height may be added when stage 7 needs it)
  settings: Record<string, SettingValue>;   // e.g. { use: 'church' }
  createdAt: string;
}
```

- **Creating:** click a region in the view, then the inspector shows the local settings
  its kind accepts (from the creating stage's `overridable`). Setting one creates an
  override anchored at the clicked point, and regenerates from the override's own stage.
  Per-stage seeds reproduce that stage's regions identically, and re-resolving then
  merges attrs cleanly, so removing an override never leaves stale values behind.
  (Changed during planning; the earlier draft said "from the next stage".)
- **Resolving,** after the target stage runs: find the node of that `kind` created by that
  stage whose footprint contains `anchor`. If several match, as after a vertical split,
  take the lowest, i.e. the one touching the ground. Then:
  - **found, and every setting is valid** for it: merge the settings into `node.attrs`.
  - **no region of that kind contains the point** (it's under a road now, say): drop it.
  - **the region doesn't accept that setting** (no such local setting for its kind, or
    the value isn't a valid option there): drop it.
  - **two overrides land on the same region with the same setting:** the newer one wins
    and the older one is dropped. (My call.)
- **Dropped overrides are removed from the document** and reported in a toast, one per
  regeneration, listing each dropped override with its reason, e.g. "Dropped *use:
  church* on a block: that spot is now a road." The toast's **Undo** reverts the edit
  that caused the drop.

## Undo and redo

- History entries are snapshots of the *editable* state: `{ seed, stages, overrides,
  generatedThrough }`. Trees aren't stored in history. Undo restores the snapshot and
  regenerates from the earliest stage that differs. Per-stage seeds make this exact.
  (My call. Optionally cache the last few trees to make undo instant; builder's choice.)
- Every edit is one entry: a setting change (slider drags are coalesced into one entry
  on release), override create/edit/delete, reroll, next stage, step back.
- History is per city, in memory, lost on reload (my call). Ctrl/Cmd+Z and
  Shift+Ctrl/Cmd+Z, plus toolbar buttons.

## Storage

- IndexedDB via `idb`, database `proccity`, object store `cities` keyed by `id`, holding
  the full `CityDoc`. A second store, `index`, holds `{ id, name, modifiedAt }` for fast
  listing.
- **Autosave** after each completed generation and each edit, debounced (around 1 s).
  The toolbar shows saved/saving state.
- City list: new, open, rename, delete (with confirm). The last-opened city reopens on load.
- **Download JSON / Open JSON file** (my call): cheap, and it's the most direct form of
  "save it so it can be reproduced", plus the path to a Blender export later. Opening a
  file validates `format` and imports the city as a new entry.
- **Loading a saved city displays its stored tree directly. It does not regenerate.** It
  only regenerates when the user edits. That's what makes a save survive generator changes.

## Editor

```
┌──────────────────────────────────────────────────────────────────────────┐
│ proccity  ▾ My City        ↶ ↷        saved ✓        [Download] [Open]   │
├───────────────┬──────────────────────────────────────────┬───────────────┤
│ STAGES        │                                          │ INSPECTOR     │
│ ✓ 1 Terrain   │                                          │ site ›        │
│ ✓ 2 Districts │                                          │  downtown ›   │
│ ● 3 Arterials │              3D view                     │   block:14    │
│   ─ settings  │                                          │               │
│   density ▬▬○ │                                          │ use  [church▾]│
│   curve   ▬○▬ │                                          │  (override)   │
│   [reroll]    │                                          │               │
│ ○ 4 Blocks    │                                          │ area 6,120 m² │
│   [Next ▸]    │                                          │               │
├───────────────┴──────────────────────────────────────────┴───────────────┤
│  ⚠ Dropped "use: church" on a block: that spot is now a road.   [Undo]   │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left:** Site entry, then stages in order, marked generated ✓ / current ● / not yet ○.
  Selecting a generated stage shows its settings without discarding anything, and
  changing one regenerates from there through `generatedThrough`. "Next ▸" generates the
  following stage. **"Clear after this"** on a stage discards every later stage
  (`generatedThrough` = that stage). That's what "step back" means in History. (My call.)
- **Centre:** the 3D view. Click picks the region under the cursor at the current stage
  (raycast → node id) and highlights it. Hover shows a light highlight.
- **Right:** the inspector for the picked region: breadcrumb path (each segment
  clickable to select that ancestor), kind, a few computed facts (area), resolved
  attributes, and editable local settings when its kind accepts overrides.
- **Bottom:** toasts.

## Repository shape

```
src/
  doc/          types.ts (CityDoc, RegionNode, Geometry, Override), validate.ts, tree.ts (walk, find, prune, leaves)
  grammar/      slab.ts, ops.ts (split, cut, inset, offset, contains, area, checkPartition), clipper.ts (library boundary)
  pipeline/     generate.ts (pure), seeds.ts, overrides.ts (resolve), worker.ts, client.ts (worker RPC)
  stages/       index.ts (ordered registry), debug-grid/ (throwaway)
  editor/       history.ts, store (React state for doc + selection), components (StagePanel, Inspector, Toolbar, Toasts, CityList)
  storage/      db.ts (idb), autosave.ts, file.ts (download/open)
  scene/        cityScene.ts (kept: renderer, camera, lights, controls), view.ts (stage renders, picking, highlight)
  App.tsx, main.tsx, config.ts, server.ts, tokens.css
```

## Testing

Vitest, on pure modules: grammar ops (including `checkPartition`), tree utilities,
pipeline (prune and re-run, seeds, "regenerate from stage k leaves earlier stages
identical"), override resolution (each drop case, newer-wins, inheritance via
`resolveAttr`), history (undo/redo and coalescing), document validation and JSON round
trip. Storage is tested with `fake-indexeddb` if cheap, otherwise left to manual
verification (builder's choice). UI components stay untested by convention. The editor
and view are verified by running the app and taking screenshots.

## Left to the builder

- Exact React state shape and component breakdown.
- Worker message protocol details, and whether to cache trees for instant undo.
- Visual styling of panels, highlight and toasts, within the existing tokens.
- How `debug-grid` looks, as long as it exercises overrides and partitions.
- Scaling factor and orientation handling at the Clipper2 boundary.

## Documentation

`CLAUDE.md` and `README.md` are updated alongside the change that makes them wrong. They
describe the document format, the stage contract, and the subtractive invariant, and they
stop describing the proof of concept.

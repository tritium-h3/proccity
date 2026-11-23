# proccity — procedural 3D cities in the browser

A standalone project (own repo, own service, own ports) linked from the `pages` gallery.
Conventions follow `~/.claude/CLAUDE.md`; this file covers what's specific here.

## What it is

A **shape grammar** for cities, built in stages (terrain → districts → arterials → blocks →
lots → lot sections → building parts). Each stage **divides** the regions the previous one
produced, never adds. The design is `docs/superpowers/specs/2026-11-20-foundation-design.md`.
Stages so far: **terrain**, now v2 (`docs/superpowers/specs/2026-11-21-terrain-v2-design.md`;
v1's height-grid design is superseded), and **districts**
(`docs/superpowers/specs/2026-11-23-districts-design.md`; the owner's zoning notes are in
`docs/notes/zoningBlocks.md`), and **arterials**
(`docs/superpowers/specs/2026-11-23-arterials-design.md`). Each real stage is designed with the
owner one at a time.

**Scale (2026-11-24, `docs/superpowers/specs/2026-11-24-city-scale-design.md`):** sites are
**30 km** by default (the slider runs 5–60 km). Layout sizes grew ×15 from the original 2 km
(1.8 km terrain cells, ~4,500 ha regions, ~1,800 ha districts, 900 ha ponds), and the
structure stayed the same: about the same numbers of cells, regions, districts and
triangles. Relief is 600 m, rivers 150 m wide, roads 25 m wide, and arterials about 2 km
apart. **No layout distance is hard-coded in metres:** each derives from a setting (cell
size, river width, district size, spacing, site size), giving the old values at the old
settings. Physical things don't scale: road width, max grade, vertical tolerances, park
width. Tests written at 2 km pass `SMALL_SCALE` (`stages/testing.ts`), and 30 km tests check
that the structure holds. A saved city keeps its own settings and site size.

Local roads come next; whether collectors sit between arterials and local
roads is pinned for that design.

## Architecture (`src/`)

- **`doc/`: the city document.** `CityDoc` (format `'proccity/1'`) holds a tree of
  `RegionNode`s with **resolved geometry**, so a saved city never needs the generator to
  be reproduced. Every region is a **slab**: a footprint multipolygon plus a height range in
  metres *above ground* (`high: null` = open to the sky). Node ids are paths
  (`site/flat:1`). `validate.ts` refuses anything not `proccity/1`.
  Regions can carry bulky `data` (`ground`, `course`, `profile`, `stats`), tagged in
  `dataStage` by the stage that wrote it, so pruning that stage removes it.
  **`data.ground` is a region's own triangulated surface: absolute elevations (m above sea
  level). Slab heights stay above-ground.** `doc/ground.ts` queries it, including
  `groundHeightAt`. (`heightfield` is v1-only, decoded just so old saves validate.)
- **`grammar/`: pure geometry.** `split` (along x, z or y; sizes in metres or `'1r'`
  weights), `cut`, `inset`, `band`, plus polygon helpers. `clipper.ts` is the **only** file
  importing the polygon library (`clipper2-ts`; `clipper2-js` was tried and is broken,
  see its header). `checkPartition` enforces the **subtractive invariant**: children
  partition their parent volume, checked band by band in height. The worker runs it in
  dev builds and logs violations.
- **`stages/`: the stage contract** (`types.ts`). A stage declares a settings schema (the
  editor builds UI from it) and optional per-kind `overridable` local settings, and its
  `run()` attaches children to leaves and may annotate existing regions
  (`StageOutput.data`). It also receives `overridesForStage`, for stages whose overrides
  shape their own output (terrain's flat `elevation`). An optional `overrideScope(node)` makes
  several regions one override target, where the newest edit wins across them; terrain uses it
  so a split flat's pieces, which share a level, can't hold conflicting elevations. Stages are pure: no DOM, no
  Three.js. Test-only fake stages live in `stages/testing.ts` and are never in `STAGES`. Attributes
  inherit down the tree through `resolveAttr` (own > ancestors > stage setting).
  **Adding a stage:** a module, a line in `stages/index.ts`, and a renderer in
  `scene/renderers/`.
- **`stages/terrain/` (v2, all polygons):**
  - `water.ts`: the sea and river carve the site, with a gentle coast and a monotonic river
    profile.
  - `cells.ts`: irregular cells. Random variable-density seeds become Voronoi cells
    (`d3-delaunay`). Close corners snap together (boundary-aware, memoised). A share of cells,
    set by `irregularity`, is cut by straight lines into wedges and triangles, with each cut
    point mirrored into the neighbour so there are no T-junctions (Clipper preserves in-line
    points). Each cell gets a neighbour graph with shared edge lengths, corner adjacency,
    hop distance, nearest water and `riverHop`.
  - `rules.ts`: `TERRAIN_RULES`, a declarative weighted rule table (a stochastic grammar),
    then smoothing (votes weighted by shared edge length), flat subtypes (coastal, river,
    shelf), ponds (seeded, then grown to about `pondSize` hectares; no contact at all, not even
    a corner, with sea, river, another pond or the site edge), and merging same-kind cells,
    ponds included, into regions (later cut down to size by `split.ts`). `steppedFlats` keeps flats at very different levels from
    touching: where cells of two flat regions touch, even at a corner, and differ by more than
    `FLAT_STEP` (2 m), the higher cell becomes slope. The stage repeats this with fresh levels
    until it's stable.
  - `ponds.ts`: rounded pond shorelines, made before elevations. Shoreline edges are
    subdivided, then their vertices Gaussian-smoothed. Each vertex moves in every ring that
    holds it, so the partition stays exact. Moves that would fold or cross a cell are refused.
  - `elevation.ts`: vertex and centre elevations. Flats, ponds and banks are pinned. Other
    land comes from a smooth Gaussian height field over position, rising from the nearest
    pinned edge over about a cell's distance, never below the river floor (river surface +
    `riverHop`). Per-cell averages made cliffs with irregular cells.
  - `split.ts`: once levels are settled, flat, slope and hills regions over 1.5 × `regionSize`
    are cut at their necks: the cut along cell edges with the lowest cut length / sqrt(smaller
    piece's area), with each piece ≥ 0.4 × the target. Candidates come from a spectral
    (Fiedler) sweep plus a graph-distance sweep. It's repeated until nothing is oversized, and
    a group with no legal cut is final. Small regions and slivers are never cut or merged, and
    water is never split. Flat levels are per cell (shelves share one), so the pieces' ground
    is unchanged.
  - `ground.ts`: constrained Delaunay surfaces (`delaunator` + `constrainautor`, with an
    `earcut` fallback).
  - `decimate.ts`: every region's finished surface is simplified. Interior vertices are
    removed while the surface stays within 0.25 m on land and 0.5 m on beds. The tolerance
    is checked at removed points and between vertices. Boundary vertices always stay, so
    regions still meet exactly.
  - `stage.ts`: assembly. About 3,400 stored triangles at the old 2 km scale. At 30 km it's
    about 4,000–4,300, the extra going to the riverbed: bed points space at 0.625 × river
    width, and the 30 km river is relatively longer. About 200 ms in Node.

  **Polygon budget: terrain draws about 6,000 triangles (ground plus water surfaces), so later
  stages get the budget.** It's slightly over at 30 km because of the riverbed. Check new
  terrain detail against it. Arterial ribbons add about 8,000 at 30 km.

  **Fine detail is cosmetic, in the renderer's shader. Never add it to the geometry.**
- **`stages/districts/`:** each terrain land region is cut into districts (hills stay whole,
  water gets none), and each district gets a type, which later limits its blocks' zones.
  There's no height cap; height is per block.
  - `rules.ts`: the eight types, the owner's **neighbour table** (the source of truth),
    terrain rules (hills Undeveloped; slopes at most Town core) and Growth budgets.
  - `cut.ts`: seeded, Lloyd-relaxed Voronoi, cut sequentially so the pieces tile the region.
  - `graph.ts`: touching districts (≥ 3 m shared) and travel costs (slopes ×2, hills ×4,
    water ×5 within 1.5 river widths).
  - `fill.ts`: the puzzle fill. Anchors go first: the main centre (type set by Growth), minor
    Town cores, Rural anchors far from every centre, the user's pins, and hills. Then the rest
    fills nearest first: the table, terrain and budgets limit the choice, and it's weighted by
    expected density (falling 200 + 500·Growth m per rank). **A narrow Undeveloped patch
    doesn't hide a jump**; only hills or wide patches (over ~100 m) separate districts. If
    nothing fits there's a budget overflow or a repair, both counted in the site's stats.
    `assignStable` wraps it: the unpinned fill first, then each pin applied as is when it obeys
    the rules, with a refill only when it doesn't. So changing one district's type doesn't
    reroll the map.
  - Partition tests allow 1 mm per metre of district outline, since Clipper's millimetre
    rounding where cuts cross long region edges exceeds the default 1e-6.
- **`stages/arterials/`:** a sparse network that links (every district reachable, a few loops)
  and divides (superblocks). Density does **not** add roads.
  - `grid.ts`: a cost raster with cells of spacing/35, but at most ~300 cells across (100 m at
    30 km). Grade along the heading costs steeply past **Max grade**,
    but it's soft, never infinite. District borders are cheap corridors (×0.75), with a
    penalty for running parallel just beside them. Sea and ponds are blocked. The river costs
    ×30, more when not crossing square. Placed roads repel parallel neighbours.
  - `route.ts`: A\* with heading in the state (16 directions, at most ±45° per step, a turn
    cost).
  - `hubs.ts`, `mesh.ts`: Poisson hubs at the spacing (town centres first) and exits (dead
    ends on land edges). A Delaunay mesh is reduced to a spanning tree plus the Redundancy
    share of loops, refusing junctions sharper than the Junction angle.
  - `smooth.ts`: simplify, then true circular arcs of the Curve radius (capped where segments
    are short; counted).
  - `space.ts`: slivers (narrower than the Usable width, or tinier than its square). A loop is
    dropped if that removes a sliver.
  - `stage.ts`: route links, prune loops, repair connectivity, exits, then spurs to untouched
    districts. Bands have round ends. Roads are cut out of districts (`arterial` +
    `superblock`) and the river (`bridge` + `water`). `data.roads` keeps the centrelines; the
    stats count compromises.
- **`pipeline/`:** `generate.ts` prunes from `fromStage` and re-runs through
  `generatedThrough`. Each stage gets its own seed (`stageSeed(citySeed, id, seedOffset)`),
  so regenerating stage k never disturbs earlier stages and undo is exact.
  `overrides.ts` re-attaches each override to the region under its anchor point, or drops
  it with a toast message. Generation runs in a **Web Worker** (`worker.ts`/`client.ts`),
  with latest-wins tickets so stale results are never applied.
- **`editor/`:** `history.ts` (undo/redo of the editable state; `regenerateFrom` picks the
  earliest changed stage) and `useCityEditor.ts` (all editor state and actions).
  Components: Toolbar, StagePanel, Inspector, Toasts.
- **`storage/`:** IndexedDB (`proccity` db), debounced autosave, JSON download/open.
  **Loading a saved city shows its stored tree and does not regenerate.**
- **`scene/`:** `cityScene.ts` (renderer, camera, controls, picking, outlines), `view.ts`
  (shows the site plus the current stage's regions; `groundHeightAt`; outlines drape over
  the ground), `slabMesh.ts` (merged mesh with a face → node lookup). The terrain renderer
  merges every region's `ground` into one mesh, then smooths it at draw time
  (`scene/smoothMesh.ts`, pure and tested). Normals are Laplacian-smoothed. Edges are split
  and curved by up to 1.25 m (Phong), but **only where curving moves the surface at least
  0.3 m** (`CURVE_MIN`), never at water. Triangles are cut to match their split edges, so
  there are no cracks. Water surfaces are drawn from their outlines alone. It renders with a
  **TSL node material** (`three/tsl`). Per-pixel noise is read from a baked seamless tile
  (`scene/noiseTile.ts`, four channels):
  - kind colours blended by two-octave jittered weights, for ragged edges;
  - colour variation, and a ragged wet-sand band at sea level.

  The bump stays procedural (one noise per pixel): a bump read from the tile showed a regular
  cross-hatch. Noise displacement is ≤ 0.75 m, which together with the curve stays within the
  2 m cosmetic budget. There's also animated water. It picks by ground point (`nodeIdAt`)
  rather than by face. The sun's shadow map is redrawn only for a second after the view changes (`shadow.autoUpdate = false`),
  never while orbiting. The pixel ratio is capped at 1.5. Stage renderers live in
  `scene/renderers/`, **not on the stage**,
  so the worker never bundles Three.js. The current stage's regions cover the site
  completely, so the site ground isn't drawn under them; drawing both z-fights. The districts
  renderer reuses the terrain renderer (`buildTerrain` with a tint) and colours it from a
  texture baked from the district footprints (`scene/rasterise.ts`, shared via
  `renderers/tint.ts`), so **districts add no triangles**. Arterials tint superblocks and road
  strips with their district's colour. Roads themselves are **ribbons** draped on the ground
  as drawn (`scene/heightSampler.ts`, from the smoothed mesh), sampled every site/300. They
  run at deck height over bridges. Bridge decks are geometry too. At 30 km a road is under 2
  pixels of any baked texture.
  **Height exaggeration** (the toolbar's Height ×, 1–4, default 2, kept in localStorage, not in
  the city) stretches only the drawn ground and water (`RenderContext.exaggeration`). Anything
  built on the ground (roads, bridge decks, outlines, later buildings) sits on the stretched
  ground at its real height above it, so structures are deliberately out of scale. That's the
  owner's call. Generation always uses real heights.
  The camera's depth, zoom limits, shadow depth range and bias, and the shader's noise
  frequencies all follow the site size. **No hover work runs while a mouse button is held,**
  and the hover outline is rebuilt only when the hovered region changes. Rebuilding it every
  frame of a drag made orbiting crawl at 30 km.
- `server.ts`: **the only listener.** Express serves the built frontend from `dist/`
  (`server/web.ts`: dotfiles ignored, nothing outside `dist/`, a 503 "Building…" page while
  `index.html` is missing) plus the placeholder `/api/health`, over HTTPS (`server/tls.ts`;
  a bad cert falls back to plain HTTP rather than a crash loop), with a 301 redirect from
  HTTP (`server/redirect.ts`). `config.ts`: hosts, ports and TLS paths. **Never expose
  `vite dev`:** after the 2026-11-22 cryptominer incident in pages (source, `/@fs/` and the
  transform pipeline were public), proccity serves a build. Design:
  `docs/superpowers/specs/2026-11-22-production-serving-design.md`.

## Three.js notes

- **Import from `three/webgpu`, not `three`.** `WebGPURenderer` uses WebGPU where available
  and falls back to WebGL 2 by itself. Vite aliases bare `three` to `three/webgpu` so
  addons (`three/addons/...`) share the same copy. The UI shows which backend is active.
- Three changes API between releases. Check the installed source in `node_modules/three`
  before relying on memory (e.g. `PCFSoftShadowMap` was removed in r186).
- `WebGPURenderer` doesn't support `LineLoop`. Use a `Line` with the first point repeated.
- **A blank canvas with "WebGPU" in the panel means the GPU device was lost.** Seen
  2026-11-20 on the owner's laptop (Chrome/Linux, hybrid NVIDIA 3050 Ti, experimental
  WebGPU flags on): `VK_ERROR_OUT_OF_DEVICE_MEMORY` even for a raw WebGPU clear with no
  Three.js. That's an environment problem, not ours. The owner turned the flags off
  rather than have us add a device-loss → WebGL fallback. Don't re-propose it unprompted.
- Headless Chrome: default flags give WebGL 2 only. `--enable-unsafe-webgpu
  --enable-features=Vulkan` gives a SwiftShader WebGPU adapter whose device is lost
  immediately, even for raw WebGPU, so it **can't test WebGPU rendering**.
  `--virtual-time-budget` stalls async GPU init, so drive Chrome in real time over CDP
  (`--remote-debugging-port`) when you need console output from GPU code, or to click
  through the editor (React range inputs need the native value setter plus `input`/`change`
  events). Use a persistent `--user-data-dir` to test IndexedDB across reloads.

## Dev

**Git:** agents manage the repo. Feature work goes on a branch with a commit per task;
`main` takes merged work. Pushing to GitHub needs the owner's OK.

Runs as the systemd user service **`proccity`**. `npm run dev` runs `vite build --watch` and
`tsx watch ./src/server.ts` via `concurrently`:
- HTTPS (app + API) **5281**, HTTP→HTTPS redirect **5280**. 5282 is retired but stays
  reserved.
- `npm run dev:restart`, `systemctl --user status proccity`, `journalctl --user -u proccity -f`
- `npm test`, `npm run typecheck` (TypeScript 7), `npm run lint` (**oxlint**:
  typescript-eslint doesn't support TS 7 yet; oxlint is silent when clean),
  `npm run build` (the ~1 MB chunk warning is Three.js and expected).

**Save, then refresh.** There's no hot reload. A save rebuilds `dist/` in well under a second
(`[web] built in …` in the journal). The service runs a **production** build, so the
`import.meta.env.DEV` aids (the worker's partition check, the terrain mesh timing log) are
off there. Tests still cover the partition invariant. The source isn't served, so if the
browser doesn't match the source, check the journal for a build error or compare
`dist/assets` timestamps; `npm run dev:restart` rebuilds from scratch.

**Screenshot check:** headless Chrome's capture is 87px taller than the page viewport, so
a dark strip along the bottom is an artefact, not a layout bug. Pass a window height
87px larger than the viewport you want:
`google-chrome --headless=new --no-sandbox --ignore-certificate-errors --hide-scrollbars
--enable-unsafe-swiftshader --window-size=1200,907 --virtual-time-budget=12000
--screenshot=<out>.png https://localhost:5281/`

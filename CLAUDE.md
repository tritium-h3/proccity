# proccity — procedural 3D cities in the browser

A standalone project (own repo, own service, own ports) linked from the `pages` gallery.
Conventions follow `~/.claude/CLAUDE.md`; this file covers what's specific here.

## What it is

A **shape grammar** for cities, built in stages (terrain → districts → arterials → blocks →
lots → lot sections → building parts). Each stage **divides** the regions the previous one
produced, never adds. The design is `docs/superpowers/specs/2026-11-20-foundation-design.md`.
Stages so far: **terrain** (`docs/superpowers/specs/2026-11-21-terrain-design.md`). Each
real stage is designed with the owner one at a time; districts come next.

## Architecture (`src/`)

- **`doc/`: the city document.** `CityDoc` (format `'proccity/1'`) holds a tree of
  `RegionNode`s with **resolved geometry**, so a saved city never needs the generator to
  be reproduced. Every region is a **slab**: a footprint multipolygon plus a height range in
  metres *above ground* (`high: null` = open to the sky). Node ids are paths
  (`site/flat:1`). `validate.ts` refuses anything not `proccity/1`.
  Regions can carry bulky `data` (`heightfield`, `course`, `stats`), tagged in
  `dataStage` by the stage that wrote it, so pruning that stage removes it.
  **Height map heights are metres above sea level; slab heights stay above-ground.**
  `doc/heightfield.ts` encodes it (base64 Float32) and samples it (bilinear).
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
  shape their own output (terrain's flat `elevation`). Stages are pure: no DOM, no
  Three.js. Test-only fake stages live in `stages/testing.ts` and are never in `STAGES`. Attributes
  inherit down the tree through `resolveAttr` (own > ancestors > stage setting).
  **Adding a stage:** a module, a line in `stages/index.ts`, and a renderer in
  `scene/renderers/`.
- **`stages/terrain/`:** water first (`layout.ts`: sea, river, flats, ponds as
  polygons), then the height map (`field.ts`: pinned features, two-pass harmonic solve,
  noise faded by distance from features), then the division into sea, river, pond, flat,
  slope and hills regions (`stage.ts`). About 235 ms at 2 km. Inland edges are pinned
  high but taper near the sea and stay free near flats and ponds; pinning them hard
  produced cliffs and walls.
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
  draws the height map as a lit mesh coloured by region, plus water surfaces, and picks by
  ground point (`nodeIdAt`) rather than by face. Stage renderers live in `scene/renderers/`, **not on the stage**,
  so the worker never bundles Three.js. The current stage's regions cover the site
  completely, so the site ground isn't drawn under them; drawing both z-fights.
- `server.ts`: placeholder Express backend (`/api/health`). `config.ts`: hosts and ports.

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

Runs as the systemd user service **`proccity`** (Vite + API via `concurrently`):
- Vite (HTTPS) **5281**, API **5282**, HTTP→HTTPS redirect **5280**.
- `npm run dev:restart`, `systemctl --user status proccity`, `journalctl --user -u proccity -f`
- `npm test`, `npm run typecheck` (TypeScript 7), `npm run lint` (**oxlint**:
  typescript-eslint doesn't support TS 7 yet; oxlint is silent when clean),
  `npm run build` (the ~1 MB chunk warning is Three.js and expected).

**Stale dev server:** two writes to the same file within a few milliseconds (an append, then
an edit) can leave Vite serving the first version. Unit tests still pass, since Vitest
reads fresh. If browser behaviour doesn't match the source, `curl -sk
https://localhost:5281/src/<file>.ts` and compare. `npm run dev:restart` fixes it.

**Screenshot check:** headless Chrome's capture is 87px taller than the page viewport, so
a dark strip along the bottom is an artefact, not a layout bug. Pass a window height
87px larger than the viewport you want:
`google-chrome --headless=new --no-sandbox --ignore-certificate-errors --hide-scrollbars
--enable-unsafe-swiftshader --window-size=1200,907 --virtual-time-budget=12000
--screenshot=<out>.png https://localhost:5281/`

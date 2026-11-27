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
`docs/notes/zoningBlocks.md`), **arterials**
(`docs/superpowers/specs/2026-11-23-arterials-design.md`), **sub-districts**
(`docs/superpowers/specs/2026-11-27-subdistricts-design.md`), **blocks**
(`docs/superpowers/specs/2026-11-25-blocks-design.md`) and **lots**
(`docs/superpowers/specs/2026-11-27-lots-design.md`). Each real stage is designed with the
owner one at a time.

**Defaults (2026-11-25, the owner's numbers):** sites are **10 km** (the slider runs 5–60 km),
with regions of 2,500 ha, flats 3 cells deep, 200 ha ponds, 600 ha districts and gateways
1,500 m apart (the spacing was measured: 2,000 m crowded gateways on 600 ha districts). Cells stay
1.8 km, so hills are rare at 10 km (about 30 cells); 1.2 km cells bring them back at twice the
slivers. A 10 km city generates in under a second. Tests of the 30 km scale pin its old defaults
(`LARGE_SCALE`, `stages/testing.ts`).

**Scale (2026-11-24, `docs/superpowers/specs/2026-11-24-city-scale-design.md`):** sites were
**30 km** by default until 2026-11-25. Layout sizes grew ×15 from the original 2 km
(1.8 km terrain cells, ~4,500 ha regions, ~1,800 ha districts, 900 ha ponds), and the
structure stayed the same: about the same numbers of cells, regions, districts and
triangles. Relief is 600 m, rivers 150 m wide, roads 25 m wide, and arterials about 2 km
apart. **No layout distance is hard-coded in metres:** each derives from a setting (cell
size, river width, district size, spacing, site size), giving the old values at the old
settings. Physical things don't scale: road width, max grade, vertical tolerances, park
width. Tests written at 2 km pass `SMALL_SCALE` (`stages/testing.ts`), and 30 km tests check
that the structure holds. A saved city keeps its own settings and site size.

Lot sectioning comes next.

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
  `scene/renderers/`. A stage inserted mid-pipeline steps older saved cities back to just before it
  (`editor/normalize.ts`), since `generatedThrough` is an index.
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
  terrain detail against it. Arterial ribbons add about 8,000 at 30 km. Sub-districts and blocks add none (tinted).

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
- **`stages/arterials/`:** planned over **districts, by gateways**
  (`docs/superpowers/specs/2026-11-23-arterial-gateways-design.md`): links districts (every
  developed one reachable, a few loops) and divides them (superblocks). **No dead ends.**
  Density does **not** add roads. **Loops go through at least 3 districts**, whatever their
  size (`2026-11-24-arterial-loops-design.md`; the owner: no rings around one district border).
  - `links.ts`: over the district graph:
    1. the cheapest spanning tree, without Undeveloped districts it merely hangs off;
    2. the exits;
    3. **no leaves**: a developed district with one link gets another. Ordinary links come
       first, then exits, then spares (borders too short for the usual margins);
    4. the Redundancy share of loops.

    An Undeveloped district ends with zero links or two or more, never one. A developed
    district with only one possible neighbour (an enclave) gets **no** link (`leaves`). A
    dropped link is banned from coming back (the clean-up oscillated).
  - `gateways.ts`: `sharedBorder` (the boundary two footprints share) and `placeOnBorder`. A
    gateway sits a Usable width from the border's ends, off bends, preferring flat ground and
    at least the spacing from its districts' other gateways (else `crowded`).
  - `inside.ts`: pairs a district's gateways.
    - Perimeter neighbours may become **border roads** (the Border roads share, only where
      every corner takes a Curve-radius curve and the border never runs along water or the edge).
    - The rest pair across, most opposite first: **through roads**.
    - An odd one is a **tee** to the nearest road of any district (one limited to its own
      district's roads crossed a neighbour's road to reach it, closing a small ring). A road
      that ends at the tee's own gateway doesn't count: joining it closes a ring back through
      the gateway.
    - A gateway that already has a road in the district (two gateways can coincide) isn't used
      again: the pair's other gateway becomes a tee, so the road forks rather than running
      beside the first.
    - Town centres and lone gateways go to a central junction (**star**). Later spokes join
      the centre or any road already in the district, and the first spoke is cut back to its
      last joint (routed separately, spokes lay on top of each other for kilometres).
  - `grid.ts`: a cost raster with cells of spacing/35, but at most ~300 cells across (100 m at
    30 km). Grade along the heading costs steeply past **Max grade**, but it's soft, never
    infinite. District borders are cheap corridors (×0.75), with a penalty for running parallel
    beside them out to the Usable width. Running along a placed road costs up to ×4 beside it
    and ×9 on top of it; crossing is free. Shorelines are **not** borders. Undeveloped land costs
    ×3 to cross (and links touching it ×3 in the tree). Sea and ponds are blocked. The river
    costs ×30, more when not crossing square. Placed roads repel parallel neighbours.
  - `route.ts`: A\* with heading in the state: 16 directions and a turn cost. `maxTurn`
    sectors per step comes from the Curve radius (one at the defaults; two made 90° Vs).
    Options: `allow`, `goalHeading` (arrive square into a stub) and `maxCost`.
  - `smooth.ts`: simplify, then true circular arcs of the Curve radius (capped where segments
    are short; counted).
  - `loops.ts`: the network's loops (holes in the union of road bands), the districts each takes
    in (a usable piece left after an inward offset of half the Usable width, so a strip a road
    strays into doesn't count), junctions along a road, and cutting a piece out of one.
  - `space.ts`: slivers (narrower than the Usable width, or tinier than its square).
  - `stage.ts`:
    - Builds the graph: border links, river links (the shortest bridge between facing banks)
      and exit links.
    - Places gateways as links are chosen.
    - Lays bridges, then each district's roads. Through roads leave and enter square, along
      an exact stub that isn't smoothed. The stub shortens where its aim point is off usable
      ground (a pond behind a bridge's bank). With no square approach at all (a gateway by
      the edge among hills) the road arrives at an angle (`askew`), not left out. So does one
      whose square route is over twice the straight distance (a district too tight to turn
      in: it swung round in a C), when arriving at an angle from either end is at least a
      quarter shorter. Never at a bridge end or an exit.
    - A through road that meets a neighbour's road head-on at a gateway but runs beside it on
      the way (within two Usable widths for more than one) joins it where they come close,
      and the neighbour's stretch beyond the junction is cut (`merged`; the grid is re-marked,
      `remarkRoads`). The end with the longer run is merged. The owner: no parallel arterials. They stay within the district plus a Usable width
      (confined to the district, they couldn't follow the contours).
    - Every route is rejected if it loops (more than 270°), crosses itself, or makes a single
      turn over 120° (also judged on the line as laid, simplified: a route curling round over a few
      grid steps became one 134° hairpin); the next, freer try is taken.
    - Gateways too close for two stubs are joined **directly** (straight over land, else
      along the border).
    - Then each district's roads are joined up inside it (`joins`, tagged `join`): the tree
      only links districts. Pieces already linked through a neighbour's road count as joined,
      and a join may end on that road. Touching is tested on the lines, not on grid cells (a
      slanted crossing slips between cells), so a join never closes a needless triangle.
    - Then loops taking in fewer than 3 districts are **opened**: one piece of road between
      junctions along the loop's edge is removed (joins first, then tees, …, through roads
      last), extended through a gateway where two roads only meet end to end. Never a bridge or
      an exit's piece at the edge, and never if it leaves a dead end, splits the network or
      leaves a district without a road. What can't be opened is counted (`localLoops`; usually a
      loop closed by a bridge).
    - A gateway's inward direction is the shared border's normal, its side tested 5 m out (a
      longer probe near a corner pointed both districts' stubs the same way). Coincident
      gateways merge. A border road mostly on an existing road lays only the stretches that
      aren't (skipping it whole left a dead end where the neighbour's stopped short), but not a
      stretch staying within a Curve radius of a road (the road rounds the border's sharp corner;
      laying the corner made a tiny duplicate), and one partly on it is routed across instead.
    - Last, any dead end left over is cut back to its last junction (`trimmed`), whole roads
      included, never a bridge, and never if it leaves a district with no road (one it runs
      along counts), splits the network or leaves another road's end dangling. Rules that each
      did the right thing left ends hanging between them. A dead end the trim must leave (its
      district's only road) carries on to the nearest other road (`extended`, tagged
      `extension`), straight on first, then free to turn, never crossing itself or making a
      hairpin. That always closes a loop, often a small one: the owner (2026-11-25) prefers rare
      small loops to dead ends. The grid is re-marked first (removed pieces were still on it).
    - Path points along a border snap onto it, unless a road already runs there. Road ids come from a counter. Bands have round
      ends. Roads are cut out of districts (`arterial` + `superblock`) and the river (`bridge`
      + `water`). `data.roads` keeps the centrelines (with `how`, for diagnosis); the stats count compromises (`deadEnds`
      should be 0).
- **`stages/subdistricts/`:** density within districts. The owner wants gradients (density
  spreading out over an area, stepping partway at an edge) and open land appearing as the city
  thins, but **no core-to-edge gradient and no rings**: density comes from neighbouring districts
  only. Each developed superblock over 1.5 × Sub-district size (150 ha) is cut (the districts'
  Voronoi, `districts/cut.ts`) into sub-districts, each with a density **step** or Undeveloped.
  - `rules.ts`: the **ladder**, steps 1 (sparsest) to 9 (densest), one scale for every type; each
    type covers a few (its levels, level 1 densest: Financial 9–8, Rural 1 only). Codes are the
    type's letter and the step (**F9**; **U0** is an Undeveloped piece of an Urban district), names
    the type and a level word (**Financial High**). A step sets **spacing only** (block size,
    collector spacing, and later lot size together with the zone); buildings follow the zone.
  - `field.ts`: the implied density field. Each district's nominal density (mid-range; Undeveloped
    0), blurred over half a district's width, normalised over land (water and the site edge don't
    thin it: that would bring back a ring), plus noise (Variation).
  - `assign.ts`: a step is the type's nominal plus 1.5 × the piece's difference from its
    **district's mean** field (on the raw field the densest type, whose neighbours are always
    sparser, never reached its top level). Undeveloped is likelier where the raw field is low and
    in sparser types (`OPEN`; never Financial unpinned), refused if it cuts a developed piece off
    from the arterials or empties a district. Pins (`overridable.subdistrict.step`) apply first.
  - Attrs `step` (a string: the pipeline writes choice overrides straight into attrs), `code`,
    `label`, `district`. Site data `subdistrictStats`.
- **`stages/blocks/`:** each developed **sub-district** is divided by collectors, then local
  roads, by recursive cuts, into blocks, and each block gets a zone. The zone tables, district
  zones, road facing and use weights are in `rules.ts`, copied from the owner's notes
  (`docs/notes/zoningBlocks.md` is the source of truth). Undeveloped sub-districts and
  superblocks are left alone.
  - `edges.ts`: a sub-district's outline is arterial, **border** (another developed
    sub-district: every border gets a shared collector, half each side, since every block must
    face a road), **edge** (an Undeveloped sub-district beside a dense type: a whole collector on
    this side, "big lots, then across the street nothing") or **open** (water, Undeveloped land,
    the site edge, and Undeveloped sub-districts beside Suburban or Rural). Blocks meet open land
    with a rough edge; the owner wants rough outskirts and no shore or park-edge roads.
  - **The principle (the owner, 2026-11-27): a road carries on as far as it can, and the bigger
    the road, the wider the spacing of the junctions along it** (arterials met rarely, collectors
    about once a block length, local roads branching freely). `junctions.ts` measures it (the
    stats count junctions closer than the spacing, by category); as a score it was tried and
    dropped (more blocks, no fewer arterial junctions).
  - `divide.ts`: **one queue for the whole site** (`divideAll`), each piece carrying its own
    sub-district's context. Largest piece first, cut across its long side while it's long, then
    along it while it's deep, positioned so blocks come out near the target size. **A cut that
    meets a collector or local road carries on** into the queued piece beyond (`carryOn`), judged
    by that piece's own rules, in line (within half the road's width, turning under 30°), and so
    on until a piece refuses; across arterials only as a collector, and never into a piece already
    block-sized. Segments of one street share a `route` (in `data.streets`, the first segment's
    id): the seam for street names. **Crossroad favouritism** (`withCrossroads`, `snapEnds`): a
    candidate whose end meets a road within half a block depth of a street ending across it is
    tried first moved to line up, whatever either road's category; a whole depth was measured
    worse. **Local roads keep off arterials** unless the piece can be cut
    no other way and is over two target blocks (`ARTERIAL_FALLBACK`; the owner's notes disfavour
    but allow it). Block depth, length and
    collector spacing come from the step, geometric between the Densest (step 9) and Sparsest
    (step 1) settings (`spacing`); a block must hold one lot of its district's smallest zone (`smallestLot`, from the lots stage's table).
    The family (sparse: Suburban and Rural) only decides how cuts follow the terrain. A collector while the piece is longer than the
    collector spacing and both halves hold two rows of blocks, else a local road. A road meets a
    road at one end at least; the other may end on open land. Candidates: each planned line (every
    stretch across an odd shape), traced along the field, then straight, then square off the
    piece's road edges. **The local Max grade is a preference** (`gradeCost`, the owner, after
    slope Town cores stayed as 100 ha blocks): metres over it cost, and only past 3× it is a road
    refused. Rejected: kinks over 120°, self-crossing, a side under a lot (`smallestLot`), a side
    narrow enough not to be cut lengthwise again (`rectWidth`, from area and outline: curved
    strips fooled the box) that isn't a lot deep throughout (`solidity`: erode, dilate; no worse
    than its parent will do), and, the owner's ask, wedges: a final block fills 70% of its box,
    and a road end meets at 50°+ (a slanted traced end gets a square stub, if not too steep).
  - `field.ts` / `trace.ts`: dense cuts keep the plan's direction; sparse ones follow the
    contours. Over the Max grade a line bends towards the contour up to 30°, else snaps to the
    contour grid (along, or straight up: square blocks, short steep streets); past the 3× ceiling
    it runs on the diagonal at the ceiling. `height.ts` rasterises the terrain's
    triangles once (`groundHeightAt` per query was far too slow); slope **and the grade check**
    use it smoothed over 200 m (the terrain's facets kinked every streamline).
  - `zones.ts`: a block's faces are the road categories along its outline (`roads.ts` indexes
    every centreline); its zone is a weighted pick among its district's zones whose lots may face
    one of them, one draw per block from its own stream. Zone pins (`overridable.block`) hold only
    where the generator could have chosen them.
  - Site data: `streets` (centrelines) and `blockStats` (its own key: the arterials own `stats`).
- **`stages/lots/`:** every zoned block is cut into lots (and open ground), each lot facing at
  least one road its zone allows; other sides may face anything. Lot size comes from zone and
  density step together (`rules.ts`: a target frontage × depth per zone at step 9, × `lotFactor`;
  big-lot zones MC MO UO UCO UCOR take a block-sized target, so most of their blocks stay one lot).
  The blocks stage's `smallestLot` reads the same table.
  - `cut.ts` (the owner's approach C): a spine cut along the block where it's deeper than 1.4 lot
    depths and each row fronts along half the spine at least (repeated spines made strips fronting
    only on the block's ends); then cuts square to the frontage road at whole numbers of
    frontages. **The target frontage is a minimum** (the owner: lots were far too skinny): lots
    stretch to 1–2 frontages rather than narrow, and none is more than 2.5 times deeper than its
    frontage (`ASPECT`: deep lots get wider). Every cut leaves each piece on an allowed road, a minimum lot, and squareness as
    blocks. Cuts are straight, a hair-thin kerf merged into one side (exact partition). **Open
    ground** is the land more than twice the lot depth from an allowed road (the owner chose this
    over rear lots with access strips); measured from every edge, far sides on roads the zone
    can't face became lots with no frontage. The allowed test is precomputed per block as an
    index of the outline's allowed stretches (the road index per sample was two thirds of the time).
  - `faces.ts`: `edges`, one character per outline edge (`A` `C` `L`, `-` another lot, `o` open
    land), for buildings to read; `front`, the allowed category the lot runs along furthest,
    sampled along the whole outline.
  - Site data `lotStats`. About 16–22k lots in a 10 km city and 8–11 MB saved: the owner's call
    to store them resolved for now ("a question for future us").
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
  and curved (Phong) by up to 1.25 m × √(site/2 km), about 4.8 m at 30 km, but **only where
  curving moves the surface at least 0.3 m × the same factor** (`CURVE_MIN`), never at water.
  The curve scales because 1.8 km triangles curved by 1.25 m still looked faceted; the owner
  approved the look. Outlines and ribbons drape on the ground as drawn (`BuiltView.groundAt`,
  `heightSampler`), not on the stored surface, or the curve buries them. Triangles are cut to match their split edges, so
  there are no cracks. Water surfaces are drawn from their outlines alone. It renders with a
  **TSL node material** (`three/tsl`). Per-pixel noise is read from a baked seamless tile
  (`scene/noiseTile.ts`, four channels):
  - kind colours blended by two-octave jittered weights, for ragged edges;
  - colour variation, and a ragged wet-sand band at sea level.

  The bump stays procedural (one noise per pixel): a bump read from the tile showed a regular
  cross-hatch. Noise displacement is ≤ 0.75 m. (At 2 km, with the curve, that's the 2 m cosmetic budget;
  the curve's share grows with the site, above.) There's also animated water. It picks by ground point (`nodeIdAt`)
  rather than by face. The sun's shadow map is redrawn only for a second after the view changes (`shadow.autoUpdate = false`),
  never while orbiting. The pixel ratio is capped at 1.5. Stage renderers live in
  `scene/renderers/`, **not on the stage**,
  so the worker never bundles Three.js. The current stage's regions cover the site
  completely, so the site ground isn't drawn under them; drawing both z-fights. The districts
  renderer reuses the terrain renderer (`buildTerrain` with a tint) and colours it from a
  texture baked from the district footprints (`scene/rasterise.ts`, shared via
  `renderers/tint.ts`), so **districts add no triangles**. Arterials tint superblocks and road
  strips with their district's colour. Sub-districts tint the same way, paler as the step falls. Lots tint like blocks, each lot's colour nudged ±6% so neighbours read apart, open ground muted green. Blocks tint zones and streets into a 4096 px texture (2.4 m a pixel at 10 km) and reuse the
  arterial ribbons (`addArterials`). Roads themselves are **ribbons** draped on the ground
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

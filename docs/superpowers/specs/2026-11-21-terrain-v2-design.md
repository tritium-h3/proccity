# Terrain v2: polygon terrain from classified cells

**Date:** 2026-11-21
**Status:** Draft, awaiting approval
**Replaces:** the generation and rendering parts of `2026-11-21-terrain-design.md` (v1).
The foundation is unchanged except where noted.

## Why

Seeing v1 running showed three problems:

1. **Performance is degrading.** A dense 8 m height grid means about 63,000 vertices and
   125,000 triangles, rebuilt on every edit. Its traced outlines run to thousands of
   vertices, and it adds about 330 KB to every save.
2. **Flats and ponds look random and out of place**, like pimples. They were blobs
   dropped onto the land.
3. **A river could cut through a flat**, leaving a ramp.

v2 makes terrain **subtractive from the start, entirely in polygons**:
- water carves the site first
- the remaining land is divided into cells
- rules classify the cells
- cells of the same kind merge into regions

Every polygon vertex carries an elevation. **Fine detail is cosmetic, all in the
shader**: ragged edges, micro-relief, texture. **Simplify wherever possible.**

## Goals

1. Terrain regions (sea, river, pond, flat, slope, hills) partition the site, built in this
   order: water, then land cells, then classification, then merged regions. A later piece
   can never cross an earlier one, so there are no river ramps.
2. **Flats follow the water.** River flats run along the banks, and coastal flats along the
   shore. Slopes rise from flat edges, and hills lie farthest from water. **Ponds are their
   own level regions**, never bordering the sea, a river or another pond.
3. Classification is a **small declarative rule table**: weighted choices conditioned on a
   cell's neighbours and its distance from water. It's a stochastic shape grammar,
   expressed as data within code.
4. **Few polygons:** the whole terrain is under 10,000 triangles at default settings, and
   the dense height grid is removed.
5. **Cosmetic detail in the shader:** ragged coast and region edges, micro-relief of up to
   about 2 m, colour variation and texture. None of it is in the saved geometry, and later
   stages see only the clean polygons.
6. **Fast:** generation under 100 ms and a scene rebuild under 50 ms, at 2 km.

## Non-goals

- Level of detail. At under 10,000 triangles it isn't needed yet. Revisit when buildings
  multiply the geometry.
- Erosion, waterfalls, islands, multiple rivers.
- A general grammar language. The rule table is TypeScript data, scoped to this stage.

## Anti-goals

- Water above the land around it, anywhere.
- Ponds touching the sea, a river or each other.
- Salt-and-pepper classification: single stray cells of a different kind scattered about.
- Cosmetic detail large enough to matter: anything over about 2 m.

## Approaches considered

How land is divided:

- **A. Bands offset from the water** (a flat band, then a slope band, then hills). Simplest,
  but it looks banded and uniform, and adjacency rules are awkward. Rejected.
- **B. Voronoi cells classified by rules (chosen).** Organic irregular shapes. Adjacency
  rules are trivial. Flats still follow the water, because distance drives the
  classification. Cell corners and centres become the elevation points.

Wrinkles (owner's decision): **cosmetic**, in the shader, a couple of metres at most.

---

## Data model changes

### Ground surface on regions

A region's footprint stays a plain multipolygon, which is what grammar operations and
later stages divide. Terrain regions also carry **their own triangulated ground surface**:

```ts
interface GroundSurface {
  points: [number, number, number][];    // x, z, elevation (m above sea level)
  triangles: [number, number, number][]; // indices into points; together they exactly cover the footprint
}
// RegionData gains: ground?: GroundSurface
```

- Footprint boundary vertices appear in `points` with their elevations, and interior
  points (cell centres) give shape inside a region.
- The saved city stays self-contained: the renderer and later stages read the surface
  directly, with no generator needed.
- `groundHeightAt(tree, x, z)` changes to find the terrain region containing the point,
  then the triangle containing it, and interpolate. The height grid is no longer used.
- **Removed from generation:** `data.heightfield`. Validation still accepts it on old saves,
  and old cities show a flat site until regenerated.

### Cleanup

Deleted as unused (simplify):
- `src/stages/terrain/field.ts`
- `marchingSquares` and `simplify` in `src/grammar/contour.ts` (`chaikin` stays, since
  the river uses it)
- `doc/heightfield.ts` keeps only its decode for validation of old saves

---

## Generation (`src/stages/terrain/`)

### 1. Water (`layout.ts`, kept and simplified)

- **Sea** (if `shore ≠ none`): as v1, but a gentle coastline with only light noise. The
  shader does the raggedness.
- **River** (if `river`): as v1's course (source on an inland edge, mouth on the coast or
  the far edge), with a fixed moderate meander. It stays out of the sea until the mouth,
  only its largest piece is kept, and its width is `riverWidth`.
- **Surface profile:** descends from about `0.3 × relief` at the source to 0 at a coastal
  mouth. After classification, it's capped 0.5 m below any sea-touching cell (shore band,
  0.5 m) or coastal flat it passes, then eased back upstream at no more than a 2 % grade, so
  the lower river meets the coastal plain instead of perching above it. It's monotonic, smoothed and stored per course point as `data.profile`. Banks are
  then built *up* from the river (step 4), so the water can't sit above them.
- v1's flats and ponds placement goes away. Flats and ponds now come from cells.

### 2. Land cells (`cells.ts`)

- `land = site − sea − river`.
- Scatter seed points over the land on a jittered grid with spacing `cellSize` (setting,
  default 120 m). Relax them once (one Lloyd step) for evenness.
- Build the Voronoi diagram with **`d3-delaunay`** and clip each cell to `land` (Clipper).
  A cell clipped into several pieces becomes several cells.
- **Cell graph:** for each cell, record its neighbours (shared edge longer than 1 m), whether
  it touches the sea or the river, its **hop distance** from water (breadth-first over the
  graph from water-touching cells; 0 for those), and its **nearest water** (`sea` or `river`,
  carried along by the same breadth-first search; a tie goes to `sea`; `none` on a dry site).
- About 280 cells at default settings on a 2 km site.

### 3. Classification (`rules.ts`)

Each cell gets a kind from `flat | slope | hills | pond`, through a declarative rule table
evaluated in order. **The first rule whose `when` matches supplies weighted choices**,
picked with the stage rng:

```ts
interface Rule { name: string; when: (c: CellContext) => boolean; choose: Partial<Record<CellKind, number>> | ((c: CellContext) => Partial<Record<CellKind, number>>) }
```

Default rules, with `f = flatWidth` (hops of flat land, default 2) and `hl = hilliness`
(0–1, default 0.5):

| order | rule | when | weights |
|---|---|---|---|
| 1 | coast | touches sea | flat 0.85, slope 0.15 |
| 2 | riverbank | touches river | flat 0.8, slope 0.15, hills 0.05 |
| 3 | near water | hop ≤ f | flat 0.7, slope 0.3 |
| 4 | foothills | f < hop ≤ f + 2 | slope 0.7, hills 0.3 × (0.5 + hl) |
| 5 | uplands | otherwise | hills 0.6 + 0.4 × hl, slope 0.3, flat 0.1 (upland shelf) |

Then, in order:
- **Smoothing:** one majority pass. A cell whose kind matches none of its neighbours takes
  the most common neighbour kind. Water-touching cells are exempt.
- **Ponds:** among flat cells not touching the sea or river, pick up to `ponds` cells with
  no pond neighbour, by rng. Each becomes `pond`.
- **Flat subtypes:** a flat cell is a **coastal flat** if its nearest water is the sea and
  hop ≤ f, a **river flat** if its nearest water is the river and hop ≤ f, and otherwise a
  **shelf**.
- **Merging:** adjacent cells of the same kind merge into one region. Flats merge only within
  the same subtype, so a river flat never fuses with a shelf. Ponds never merge: they're
  single cells, and the rules keep them apart.

### 4. Elevations

All absolute metres. Processed in this order:
- **River flats:** each cell's level is the river surface at its nearest course point, plus
  1.5 m plus 1 m per hop. A long river flat therefore descends gently downstream, the way
  floodplains do.
- **Coastal flats:** 2 m plus 1 m per hop.
- **Shelves:** one level per merged shelf region, the mean of its cells' base elevations
  (below), rounded to whole metres.
- **River-aware floor:** any cell touching the river, or nearest to it, has a base of at
  least 0.5 m above the highest river surface at its corners, plus 1 m per hop. Land beside
  the upper river rises from the river, not from sea level. *(Changed after review: slopes
  beside the upper river sat about 40 m below it, a levee.)*
- **Base elevation for every non-flat cell:** `relief × smoothstep(0, maxHop, hop)`, plus
  per-cell noise of ± `0.15 × hl × relief`. Hills cells add a centre bump
  (`+0.1 × hl × relief`) at their centre point only, which gives rounded summits.
- **Ponds:** surface = the lowest bordering cell's level minus 0.5 m, so the bed lies below
  the surface and the banks above it.
- **Vertex elevations:**
  - A vertex belonging to any flat or pond takes that flat's level (the lowest, if it
    touches several).
  - Otherwise it takes the mean of the base elevations of its incident cells.
  - Vertices on a riverbank are at least the river surface + 0.5 m, and coastal vertices at
    least 0.5 m.
- **Cell centres:** flats and ponds at their level, others at their base elevation (with
  the hills bump).

### 5. Ground surfaces

Each region's `ground` is the union of its cells' **fan triangulations**: centre to each
edge. For clipped, non-convex cells, use ear clipping of the cell polygon plus the centre,
with the triangulation constrained to the polygon. The triangles must exactly cover the
footprint. Water regions get ground too (a bed): sea from 0 at the coast to −15 m at the
far edge; the river bed at surface − 3 m along the course; ponds at surface − 2 m.

### Regions produced (children of `site`)

Kinds and attributes as v1:
- `sea`
- `river` (`data.course` and `data.profile`)
- `pond:<i>` (`surface`)
- `flat:<i>` (`elevation` = mean level; plus `riverFlat` / `coastal` booleans)
- `slope:<i>` and `hills:<i>` (`minElevation`, `maxElevation`, `meanSteepness`)

All are open slabs with `data.ground`. The site gets `data.stats` (`pondsPlaced`,
`pondsRequested`, `cells`).

### Settings

| key | type | range | default |
|---|---|---|---|
| `relief` | number | 20–400 m | 150 |
| `hilliness` | number | 0–1 | 0.5 |
| `shore` | choice | none/north/east/south/west | south |
| `river` | boolean | | true |
| `riverWidth` | number | 10–120 m | 40 |
| `flatWidth` | number | 0–5 hops | 2 |
| `ponds` | number | 0–6 | 2 |
| `pondSize` | number | 1–10 cells | 4 (added 2026-11-22; see `2026-11-22-pond-clusters-design.md`) |
| `cellSize` | number | 60–250 m | 120 |

Removed: `ruggedness` (now hilliness), `coastWiggle` and `meander` (handled by the shader),
`flats` and `flatSize` (flats come from rules), and `hillsThreshold` (hills are a
classification, not a steepness cut).

**Overrides:** `flat` regions accept `elevation` (1–400 m, whole metres). Applied before
vertex elevations via `overridesForStage`, matched by anchor, as in v1. A river flat with an
override becomes level at that elevation. A flat beside the river has a minimum
(`minElevation`: 0.5 m above the highest river surface at its corners). An override below
it is invalid there: the stage ignores it, and resolution drops it with the standard toast
naming the minimum. This uses the stage's optional `validateOverride(node, key, value)`.
*(Changed after review: applying it made a 40 m wall at the bank.)*

## Rendering (`src/scene/renderers/terrain.ts`, rewritten)

- **Ground:** one merged mesh from every land region's `ground` triangles. Each vertex
  carries a `kind` attribute (flat, slope or hills) and its elevation.
- **Node material (TSL, `three/tsl`)**, working on both WebGPU and WebGL 2:
  - **Colour:** a base colour by kind (v1's palette). Region edges blend with world-space
    noise, so boundaries look ragged rather than straight.
  - **Micro-relief:** noise-based normal perturbation (bump) for small-scale texture, plus
    vertex displacement of at most ±1.5 m, and none on vertices shared with water, so banks
    never sink below the water.
  - **Shore:** a wet-sand band near sea level (elevation below 1.5 m, with a noisy
    threshold), so the coastline reads as ragged even though the polygons are simple.
- **Water:** sea plane, river ribbon (surface per vertex from `profile`) and pond planes, in
  translucent node materials with subtle animated normal noise.
- **Picking:** by point, as v1 (`nodeIdAt`).
- **Outlines** drape using `groundHeightAt`, sitting on the water surface over water (as v1).
- **Budget:** under 10,000 ground triangles at default settings, and a rebuild under 50 ms.

## Testing

Pure modules:
- **cells:** the cells partition the land; the neighbour graph is symmetric; hop distance
  is 0 at water.
- **rules:**
  - the rule table picks deterministically for a seed
  - a riverbank cell can come out flat, slope or hills over many seeds (all three seen)
  - smoothing removes isolated cells
- **ponds:**
  - no pond borders the sea, river or another pond, over shores × seeds
  - each pond surface is below every bank vertex
- **elevations:**
  - no water surface above its adjacent land vertices (sea, river, ponds), over shores × seeds
  - the river profile is non-increasing, with 0 at a coastal mouth
  - coastal flats sit at 2 m
  - river flat cells sit at the local river surface + 1.5 m (±0.01)
  - every vertex of a pond, or of a non-river flat, matches its level
- **ground:**
  - each region's triangles cover exactly its footprint area (±0.5 %)
  - every footprint vertex is present in `points`
  - total triangles under 10,000 at defaults
- **stage:**
  - the partition holds
  - every setting's extremes run without throwing
  - an elevation override applies
  - generation is under 100 ms at 2 km (assert under 500, log the actual)
- **groundHeightAt:** interpolates inside a triangle and returns the right value at vertices.

The renderer and shader are verified visually, including the cosmetic raggedness at the
coast and region edges.

## Left to the builder

- Jitter amount, and the Lloyd relaxation details.
- The triangulation method for non-convex clipped cells, within the "exact cover" requirement.
- Shader noise frequencies and colours, within the 2 m and look requirements.
- Whether `layout.ts` is trimmed in place or split.

## Documentation

`CLAUDE.md` gets the v2 terrain pipeline, `data.ground`, the rule table, the shader detail
approach, and the removal of the height grid.

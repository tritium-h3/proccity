# Terrain stage: design

**Date:** 2026-11-21
**Status:** Draft, awaiting approval
**Builds on:** `2026-11-20-foundation-design.md`

## Intent

Stage 1 builds the ground the city sits on. It produces two things:

1. **A height map:** the real ground shape everything drapes over.
2. **Named terrain regions** that divide the site, so later stages can reason about the
   ground: "downtown sits on the coastal flats", "this suburb sits on the foothill slope",
   "the hills proper stay empty or become parkland".

Computing heights with noise isn't itself subtractive. It's the compute phase. The
subtractive part is the division: every square metre of the site becomes exactly one
terrain region.

Terrain says what the ground *is*. What districts make of it is the district stage's job.

## Goals

1. One or more **flats**: level areas, each at its own elevation.
2. Optional **water** of three distinct kinds:
   - **river:** flowing fresh water
   - **pond:** still fresh water
   - **sea:** salt water along a shore
3. The settings are always honoured: "river: on" always produces a river, and
   "shore: east" always puts the sea on the east.
4. Ground that flows naturally from the fixed features (sea, river, ponds, flats) into
   noisy, organic land between them.
5. Regions that partition the site exactly, carrying attributes later stages read
   (elevation, steepness, water type).
6. Generation fast enough for live slider editing: under 500 ms for the default 2 km site.

## Non-goals (for now)

- Erosion simulation (approach B below). It's a possible later upgrade on top of this.
- Waterfalls, islands, more than one river, river tributaries, lakes fed by rivers.
- Hand-sculpting terrain or drawing water.
- Draping *later* stages' regions over the terrain. That arrives with districts; this
  stage only draws itself.

## Anti-goals

- **Flats that aren't flat**, or water that sits above the ground around it.
- **A toggle that's silently ignored** ("river: on" producing no river).
- **Regions that leave gaps or overlap.** The partition invariant holds as for every stage.

## Approaches considered

How the height map is made:

- **A. Sculpted noise (chosen).** Pin the fixed features' heights, solve the smoothest
  surface through them, and add noise faded by distance from the features. Fast,
  controllable, honours every toggle.
- **B. A plus hydraulic erosion.** More natural gullies, but seconds per generation,
  harder to keep flats exact, and it can fight the placed river. Parked as a later upgrade.
- **C. Hand-built shapes** (ridges, cones, basins). Looks artificial without noise. Dropped.

How water relates to land:

- **Land first, water follows** (rivers find downhill paths, the sea covers whatever is
  below sea level). Rejected: it can't guarantee the toggles.
- **Water first, land shaped around it (chosen).** Choose the shoreline and river course
  from the settings, then build the ground to fit.

---

## Foundation changes

### Region data

`RegionNode` gains one optional field for bulky per-region data:

```ts
interface RegionNode {
  // ...existing fields
  data?: { heightfield?: Heightfield };
}

interface Heightfield {
  origin: [number, number];   // x, z of grid point (0, 0): the site's min corner
  cell: number;               // metres between grid points (8)
  cols: number; rows: number; // grid points along x and z
  heights: string;            // base64 of a little-endian Float32Array, row-major (z then x)
}
```

- **Heights are metres above sea level** (absolute). Sea level is 0. Slab heights stay
  measured *above ground*. The height map is what defines "ground".
- The terrain stage attaches the height map to the **site** node.
- The format stays `'proccity/1'`, since the field is optional. `validate.ts` checks the
  shape when present, and that `heights` decodes to `cols × rows` floats.
- `src/doc/heightfield.ts`: `encodeHeights(Float32Array) → string`,
  `decodeHeights(string) → Float32Array`, and `sampleHeight(hf, x, z)` (bilinear
  interpolation, clamped at the edges).

### Stages can annotate existing regions

`StageOutput` gains `data?: Map<string, RegionNode['data']>` (node id → data to merge).
The pipeline merges it after attaching children. Pruning a stage must also remove what it
attached: the pipeline records which stage annotated which node, in
`node.dataStage?: Record<keyof data, string>`, and `pruneStages` strips data written by
pruned stages. It doesn't change the partition invariant.

### Debug stages are removed

`debug-grid`, `debug-split`, their renderers and tests are deleted. `STAGES` becomes
`[terrain]`. Saved debug cities still open: `normalizeStages` keeps unknown stage states,
and the view shows the bare site until the user regenerates. Pipeline, override, history
and editor tests that leaned on the debug stages are rewritten against small test-only
fake stages in `src/stages/testing.ts`. These fakes live in test utilities, not in
`STAGES`.

---

## The terrain stage (`src/stages/terrain/`)

Stage id `terrain`, title `Terrain`.

### Settings

| key | type | range / options | default | meaning |
|---|---|---|---|---|
| `relief` | number | 20–400 m, step 10 | 150 | height range across the site |
| `ruggedness` | number | 0–1, step 0.05 | 0.5 | strength of the noise between features |
| `shore` | choice | none, north, east, south, west | south | which edge faces the sea |
| `coastWiggle` | number | 0–1, step 0.05 | 0.4 | how irregular the coastline is |
| `river` | boolean | | true | whether there's a river |
| `riverWidth` | number | 10–120 m, step 5 | 40 | river width |
| `meander` | number | 0–1, step 0.05 | 0.5 | how much the river winds |
| `ponds` | number | 0–5, step 1 | 2 | number of ponds |
| `flats` | number | 1–4, step 1 | 2 | number of flats |
| `flatSize` | number | 100–600 m, step 25 | 300 | typical flat diameter |
| `hillsThreshold` | number | 5–35°, step 1 | 15 | steepness at which slope becomes hills |

Compass directions: north is −z, east is +x, south is +z, west is −x.

**Overridable:** `flat` regions accept `elevation` (number, 0 to `relief`, step 1, m).

### Generation, in order

All randomness comes from the stage's seeded `rng`.

1. **Sea** (if `shore ≠ none`): a coastline runs parallel to the chosen edge, 20 % of the
   site in from it, displaced by 1D noise with amplitude `coastWiggle × 15 %` of the site
   width. The sea polygon is everything between the coastline and that edge.
2. **River** (if `river`):
   - **Source:** a point on an inland edge, either the edge opposite the shore or an
     adjacent one, chosen by rng. With no shore, source and mouth are on opposite edges.
   - **Mouth:** a point on the coastline, or on the far edge if there's no shore.
   - **Course:** a polyline between them, meandered by recursive midpoint displacement
     with amplitude scaled by `meander`, then smoothed (Chaikin, 3 passes). The river
     polygon is `band(course, riverWidth)` minus the sea, so the mouth meets the sea
     cleanly.
   - **Surface:** the river surface descends linearly along the course from its source
     elevation (see step 5) to 0 m at the mouth.
3. **Flats:** `flats` blobs, irregular closed shapes about `flatSize` across.
   - The first flat is placed touching the coast. With no shore, it touches the river
     bank in the river's lower third. With neither, it goes anywhere.
   - Later flats are spread inland: the candidate farthest from existing flats wins, out
     of 30 rng candidates.
   - Each flat is clipped to the land (site minus sea and river) and to at least 20 m from
     earlier flats, so flats never overlap.
   - Flats after the first also keep 30 m back from the river, so a raised flat never
     forms a sheer gorge wall. *(My call.)*
   - **Elevations:** the first flat sits at 3 m (just above the waterline). The rest step
     up evenly towards `0.7 × relief` in placement order, ±10 % jitter. An `elevation`
     override replaces this (see Overrides).
4. **Ponds:** `ponds` blobs, irregular circles of radius 20–80 m (rng). Each is placed
   at least 60 m from the sea, the river and other ponds, and 30 m from flats, by rejection sampling with
   40 tries. A pond that can't be placed is skipped, and the stage reports
   `pondsPlaced < ponds` as an attribute on the site (`pondsPlaced`) rather than failing.
5. **Pinned heights** on the grid (8 m spacing, `cols = rows = size / 8 + 1`):
   - **Sea:** from 0 m at the coastline falling to −15 m at the site edge.
   - **River:** bed at surface − 3 m inside the band. The river source elevation is
     taken from the base solve below, evaluated without the river, then clamped to at
     least 5 m. *Builder's choice:* a two-pass solve, or a 0.6 × relief source
     heuristic.
   - **Ponds:** bed at pond level − 2 m. Pond level = the base height at the pond centre,
     solved with the sea, river and flats pinned but not the ponds; same approach as the
     river.
   - **Flats:** exactly their elevation, at every grid point inside them.
   - **Inland edges** (site edges not touching the sea): pinned at `relief` for the base
     solve, so land rises away from the water. They don't count as features for the noise
     fade in step 7, so the noise applies at the edges at full strength.
6. **Base surface:** solve the smoothest (harmonic) surface through the pinned grid
   points. Laplace with the pins as fixed values, by successive over-relaxation
   (ω ≈ 1.9) or coarse-to-fine; *builder's choice*, within the time budget.
7. **Noise:** add fBm simplex noise (`simplex-noise`, seeded from rng; 5 octaves, base
   wavelength about 600 m) with amplitude `ruggedness × 0.25 × relief`. Multiply it by a
   fade `m = smoothstep(0, 120 m, d)`, where `d` is the distance from the nearest *feature*
   point (sea, river, pond or flat; not inland edges) (a chamfer distance transform on the grid). Flats stay exact, since `m = 0`
   inside them, and the ground eases into every feature.
8. **The division** into regions:
   - `water = sea ∪ river ∪ ponds` (exact polygons).
   - `land = site − water`, and `flatsLand = flats` (already clipped to land).
   - `rest = land − flats`.
   - **Steepness** per grid point comes from central differences, in degrees. Points
     above `hillsThreshold` form a mask, blurred by one cell, then traced at 0.5 with
     marching squares into polygons and simplified (Douglas–Peucker, 2 m).
   - `hills = rest ∩ steepPolys` and `slope = rest − hills`. Pieces under 2,000 m²
     are merged into their neighbour of the other kind, so there are no specks.
   - Slope and hills are split into **connected components**, each its own region, so
     a suburb can sit on *one* foothill slope.
9. **Partition check:** in dev builds the pipeline's `checkPartition` covers it.

### Regions produced (children of `site`)

All are open slabs (`low 0, high null`). Names and attributes:

| kind | names | attrs |
|---|---|---|
| `sea` | `sea` | `water: 'salt'`, `flow: 'still'`, `surface: 0` |
| `river` | `river` | `water: 'fresh'`, `flow: 'flowing'`, `width` |
| `pond` | `pond:<i>` | `water: 'fresh'`, `flow: 'still'`, `surface` (m) |
| `flat` | `flat:<i>` | `elevation` (m) |
| `slope` | `slope:<i>` | `minElevation`, `maxElevation`, `meanSteepness` (°) |
| `hills` | `hills:<i>` | `minElevation`, `maxElevation`, `meanSteepness` (°) |

The site node gets `data.heightfield` and `attrs.pondsPlaced`.

### Overrides

`flat` regions accept `elevation`. Because an override is resolved *after* the stage
runs (foundation pipeline), the terrain stage reads its own overrides **before** pinning
heights. The pipeline passes `overridesForStage: Override[]` to `run()`, extending
`StageInput`, and the stage matches each override to the flat whose shape contains its
anchor. Resolution afterwards then confirms it in the normal way, and drops it with the
usual toast if no flat is there any more. This is the general mechanism for any stage
whose overrides affect its own output, not just its children's.

## Rendering (`src/scene/renderers/terrain.ts`)

- **Ground:** one mesh built from the height map grid, with vertex colours by region kind:
  - flat: pale sandy green `#a7b48a`
  - slope: olive `#7f8f5a`
  - hills: dark green-brown `#5f6b45`
  - sea and river beds: dark sand `#6b6250`

  Each vertex's region is found by rasterising the region polygons onto the grid once
  per render (scanline fill). Lighting comes from computed normals. It casts and
  receives shadows.
- **Water surfaces:** translucent meshes (`#3f6f8f` salt, `#4f86a0` fresh, about
  0.85 opacity):
  - sea: the sea polygon at y = 0
  - ponds: at their surface
  - river: its polygon triangulated, with each vertex's y set to the river surface at its
    nearest point along the course
- **Picking:** a hit on the ground or a water surface returns the ground point. The view
  then finds the terrain region containing that point (point-in-polygon over the site's
  children, water first). The existing face → node lookup isn't used for terrain.
- **Outlines** (selection, hover) are draped: the outline is densified to 8 m segments
  and each vertex gets y = height + 1 m.
- **Camera:** the target sits at the median ground height. The sun's shadow camera range
  grows to include the relief.

## Inspector

The inspector already lists kind, area and resolved attributes. Two additions: the site
shows `Ponds placed: n of m` when they differ, and flats show their `elevation` as an
editable override field (from `overridable`).

## Testing

Vitest on pure modules:
- **heightfield:** encode/decode round trip; bilinear sampling at grid points and
  midpoints; edge clamping.
- **terrain stage**, at default settings plus toggled variants:
  - `checkPartition(site, children)` is ok
  - `shore: none` gives no `sea` node, and `river: false` gives no `river` node
  - `flats: 3` gives 3 flat nodes
  - every grid point inside each flat is within 0.01 m of its elevation
  - every grid point inside the sea is ≤ 0, and land points outside water are > 0
  - the river surface is non-increasing from source to mouth
  - pond beds lie below their surface
  - the same seed gives the same output
  - an `elevation` override on a flat moves it to that elevation
  - default generation runs in under 500 ms (a soft, generous CI-safe bound: assert
    < 2,000 ms, log the actual time)
- **pipeline:** annotation data is merged, and stripped when its stage is pruned.
- **validation:** accepts a valid height map; rejects a bad base64 length.

The renderer is verified visually (headless Chrome), as before.

## Left to the builder

- The harmonic solver method and the river/pond source-elevation approach (two-pass or
  heuristic), within the time budget.
- Exact blob shape generation (noisy radial profile is fine).
- Marching-squares and simplification implementation details.
- Colour tweaks, within the palette above.

## Documentation

`CLAUDE.md` updated with:
- the terrain stage
- `data` and the height map, and that heights are absolute while slab heights are
  above-ground
- the annotate mechanism and `overridesForStage`
- the removal of the debug stages

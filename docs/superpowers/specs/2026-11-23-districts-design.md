# Districts stage

## Intent

Districts are stage 2 of the grammar. They divide each terrain land region into one or more
districts. A district is two things at once: a **neighbourhood**, and a **zoning district**
whose type limits which zones its blocks may take later. Blocks and zones come in stage 4.
The owner's zoning notes are in `docs/notes/zoningBlocks.md`. This stage only decides the
district type, because later rules (block zones, then architecture) depend on it.

The look the owner wants: density changes gradually as you travel through the city, with no
jumps from fields to towers. There are a few loose centres, one of them the social centre
with the densest core. Maps should be **irregular** and interesting, but never a
site-spanning megalopolis, and there should always be some countryside. This is faked with
rules, not simulated: "easy rules that fake it" is fine.

## Goals

- Every land region of the terrain is divided into districts. Water regions get none.
- Each district has a **type**. The types, from least to most dense, are Undeveloped, Rural,
  Suburban, Town core, Town business, Low urban, Urban and Financial.
- **Terrain rules:**
  - hills are always Undeveloped;
  - slopes may only be Undeveloped, Rural, Suburban or Town core;
  - every other type requires flat land.
- **The neighbour table (below) always holds** between districts that touch, including
  districts in different terrain regions. Undeveloped land only separates two districts if
  it's wide or a hill.
- Irregular maps, with variety between seeds.
- There's always at least one Rural area, and the dense types are capped, so the city can't
  fill the site.

## Non-goals

- **Building height.** Height is set per block, by zone, in a later stage. Districts get no
  height cap and no buildable/airspace split.
- Blocks, zones, roads and lots.
- Neighbourhood names, or any identity beyond the type.
- Simulating how cities grow over time. The owner explicitly rejected a growth simulation
  ("I don't necessarily want to simulate real urban development").
- Changing terrain or its regions.

## Anti-goals

- A density jump between touching districts. A thin Undeveloped sliver that hides a jump
  counts as one.
- One huge city covering the site, or a site with no countryside.
- Dense types (Town business and above) on slopes or hills.

## The neighbour table

The table is symmetric, and agreed with the owner. Every type may also border Undeveloped.

| District | May border |
|---|---|
| Undeveloped | anything |
| Rural | Rural, Suburban, Town core, Town business |
| Suburban | Rural, Suburban, Town core, Town business |
| Town core | Rural, Suburban, Town core, Town business, Low urban |
| Town business | Rural, Suburban, Town core, Town business, Low urban, Urban |
| Low urban | Town core, Town business, Low urban, Urban, Financial |
| Urban | Town business, Low urban, Urban, Financial |
| Financial | Low urban, Urban, Financial |

**Undeveloped land doesn't hide a jump.** Touching Undeveloped districts form one
**patch**, even across terrain region borders. Two districts that both touch the same patch
must obey the table with each other, as if they touched. The exception is a wide patch: one
that contains a hill, or whose merged footprint survives a 50 m inward offset, so it's over
about 100 m across. A park inside the city is fine; a sliver, or a chain of slivers, hiding a
cliff in density isn't. (The owner chose this over giving Undeveloped its own neighbour list,
which they called "completely wrong". The patch rule is my call, closing the X | U1 | U2 | Y
loophole a reviewer found.)

"Touch" means sharing a boundary of at least a few metres. A corner doesn't count. Districts
on opposite banks of a river don't touch, because the river region lies between them.

## Approaches

- **A. Density map, then enforce the table.** Each district's density comes from its travel
  distance to a centre, and turns into a type by thresholds. A final pass steps down
  violations. It's predictable, but tends to look like rings. Not chosen.
- **B. Place types like a puzzle, with strong pre-seeding. Chosen.** Anchors are placed
  first, then types are filled outward. Each pick is random, but must suit every neighbour
  already placed, and is weighted towards the density expected near anchors. Per-type
  budgets prevent sprawl. The owner prefers this because the maps are more irregular, as
  long as sprawl is impossible.
- **C. Plain rings by distance.** Rejected: it reads as a target.

## Design

### Settings

| Setting | Range | Default | Effect |
|---|---|---|---|
| District size | 2–30 ha, step 1 | 8 | Regions bigger than about 1.5 × this are cut into several districts. |
| Settlements | 1–8 | 4 | Centres, including the main one. |
| Growth | 0–1, step 0.05 | 0.5 | Scales the dense types' budgets, from villages to a city. |

### 1. Cutting regions into districts

The stage receives terrain regions as geometry only; terrain's cells aren't in the document.

- **Water** regions (sea, river, pond) get no districts.
- **Hills** regions get one Undeveloped district covering the whole region, uncut.
- **Flat or slope** regions get `k = max(1, round(area / districtSize))` districts. With
  `k > 1`:
  - Place k seeds by farthest-point sampling inside the region.
  - Relax them with a couple of Lloyd iterations.
  - Clip the seeds' Voronoi cells to the region.
  - A Voronoi cell clipped by a concave region can split into several parts. Keep the
    largest part, and give the others to the touching district they share the most boundary
    with.
- Every district records its parent region's kind, as `terrain: 'flat' | 'slope' | 'hills'`,
  for the terrain rules.

The districts must partition their region exactly (`checkPartition`).

### 2. The district graph

- **Neighbours:** districts touching across a shared boundary of at least 2 m, within or
  across regions. Store the shared boundary length.
- **Shielding depends on the fill.** Which districts are Undeveloped is mostly decided during
  the fill (only hills are known up front, and they're wide anyway). So a pair counts as
  shielded once the patch between them is actually narrow Undeveloped. The fill maintains
  the patches as it places Undeveloped districts.
- **Travel cost,** for the expected-density weights:
  - between neighbours, the distance between centroids, times a terrain factor: 1 on flat,
    2 on slope, 4 on hills (the higher of the two districts' factors);
  - water can be crossed only between districts on opposite sides that come within about 1.5
    × the river width of each other, at a factor of 5. This is a guide; the builder may
    implement it any equivalent way.
  - Travel distance is the shortest path through this graph (Dijkstra).

### 3. Anchors (pre-seeding)

Anchors are placed in this order, all deterministic from the stage rng:

1. **The main centre:** a flat district. Its score rewards:
   - a large connected flat area around it;
   - being near water (sea or river within about 300 m);
   - being away from the site edge.

   Pick randomly among the top few scores. Its type comes from Growth (see Budgets):
   Financial at the default.
2. **Minor centres** (Settlements − 1): flat or slope districts, picked by farthest-point
   sampling in travel distance from the centres already placed, with a minimum spacing of
   about 600 m. Each gets Town core. If none fits the spacing, there are fewer.
3. **Rural anchors:** at least one. The district farthest in travel distance from every
   centre that may be Rural (flat or slope) gets Rural. Add a second where the site is big
   enough that another district is at least as far from every centre and every anchor.
4. **Overrides:** a user's `type` override pins that district before the fill, like an
   anchor (see Overrides).
5. **Hills** are already Undeveloped.

### 4. The fill

- Fill outward from the anchors, nearest unplaced district first (priority by travel
  distance to the nearest anchor).
- **Candidates** for a district are the types that:
  - obey the table with every placed neighbour, shielded pairs included;
  - obey the terrain rules;
  - still have budget.

  Undeveloped is a candidate only if the patch it would join (or make) stays legal: if that
  patch is narrow, every placed district touching it must obey the table pairwise.
- **If no type fits** (a narrow district squeezed between, say, a placed Financial and a placed
  Rural), make it Undeveloped anyway, then **repair**: while some shielded or touching pair
  breaks the table, step the denser district of the pair down one rank. Pinned districts are
  never stepped down, so the other district of the pair moves instead. Each step strictly
  lowers the total rank, so this ends. It should be rare, since the weights already favour
  gradual steps. Log a count in the stage stats so it can be watched.
- **Expected rank:** take the type ranks Rural 1 … Financial 7. Each anchor's expected rank
  falls by one for every *step* metres of travel from it, with step about 250 m; the
  district's expected rank is the highest over all anchors. Rural anchors pull downward
  instead: within a step or two of one, the expected rank is at most Suburban.
- **Weights:** each candidate t gets `exp(-(rank(t) − expected)² / (2σ²))` with σ ≈ 1. That
  gives variety without jumps, since the table already stops jumps. Undeveloped gets a small
  fixed weight. Draw by weight from the stage rng.

### 5. Budgets

Budgets are fractions of total land area (water excluded). The density types are capped by
these maxima at Growth g:

| Type | Maximum share |
|---|---|
| Financial | 0.06·g |
| Urban | 0.16·g |
| Low urban | 0.20·g |
| Town business | 0.08 + 0.10·g |
| Town core | 0.15 |
| Suburban | 0.35 |
| Rural, Undeveloped | uncapped |

- At g = 0 there's no city tier at all, just villages and towns.
- Dense types together never exceed about 0.75 of the land at g = 1, so countryside always
  remains. The Rural anchor guarantees at least one Rural district.
- A pick that would push a type over its budget is not a candidate.
- **Anchors and pins are placed regardless of budget,** and they count against it; the fill
  gets what's left. A pin can therefore exceed a cap, which is the user's choice.
- **The main centre's type depends on Growth:**

  | Growth | Main centre |
  |---|---|
  | ≥ 0.3 | Financial |
  | ≥ 0.2 | Urban |
  | ≥ 0.1 | Low urban |
  | lower | Town core |

  This is needed because at moderate Growth one 8 ha district can exceed the Financial cap
  on a 2 km site. So the default city has a Financial core.
- The exact numbers are the builder's to tune against screenshots.

### Overrides

- `overridable: { district: [{ key: 'type', type: 'choice', options: the eight types }] }`.
- The stage reads its own overrides (`overridesForStage`) and pins each matched district's
  type before the fill.
- `validateOverride` rejects a type the terrain forbids, for example Financial on a slope:
  "Financial needs flat land".
- Two pinned districts that break the table are the user's choice and are left alone. The
  fill works around pins.
- **A pin disturbs as little as possible** (added after the owner tried it: changing one type
  rerolled the whole map). The city is filled as if nothing were pinned. Then each pin,
  oldest first, is simply applied if it obeys the terrain, the table and the patch rule where
  it lands. Only a pin that breaks them refills the city around the pins so far, from the
  same seed.

### Output

- Nodes have kind `district` and id `<region id>/district:N`.
- Attrs:
  - `type`: one of `undeveloped`, `rural`, `suburban`, `town-core`, `town-business`,
    `low-urban`, `urban`, `financial`;
  - `terrain`;
  - `anchor`: `'main' | 'minor' | 'rural'`, when the district was an anchor.
- Stage data on the site records the centres for debugging, through `StageOutput.data`
  stats.

### Rendering

- `scene/renderers/districts.ts`. Only the current stage's regions are drawn, so this
  renderer must also draw the terrain beneath. It reuses the terrain renderer on the terrain
  nodes, and shows each district's type as colour.
- Use a distinct colour per type: muted greens and browns for the countryside, warming
  through to strong colours for the city. Undeveloped shows the terrain as it is.
- Outlines drape on the ground, as for terrain.
- The method (a tinted overlay mesh on the ground, a material colour per region, or draped
  translucent fills) is left to the builder. Terrain detail must stay visible, and the
  polygon budget must hold: districts shouldn't add more than a few thousand triangles.
- Picking a district shows its type and anchor role in the Inspector.

## Testing

- **Pure modules** (cutting, graph, fill) get unit tests on synthetic inputs.
- **Stage tests:**
  - the partition holds in every land region, and water regions have no children;
  - the table holds for every touching pair and every shielded pair (seeds 1–6);
  - hills are Undeveloped and slopes are only Undeveloped, Rural, Suburban or Town core;
  - at least one Rural district exists;
  - each density type stays within its budget, apart from anchors and pins;
  - table and shielding hold after the repair, with patches merged across region borders;
  - Growth 0 has no Low urban, Urban or Financial;
  - the result is deterministic per seed;
  - two seeds give different maps.
- **Visual check:** screenshots on a few seeds and at Growth 0, 0.5 and 1.

## Left to the builder

- **Module layout** under `stages/districts/`. Suggested: `cut.ts`, `graph.ts`, `anchors.ts`,
  `fill.ts`, `stage.ts`.
- **Exact constants:** step, σ, the Undeveloped weight, the anchor scoring weights, the
  minimum spacing, the water-crossing factor and the budget numbers. Tune them against
  screenshots.
- **The rendering technique,** within the constraints above.
- **The colour palette.**

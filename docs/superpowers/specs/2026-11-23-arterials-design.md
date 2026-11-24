# Arterials stage

> **Superseded in part (2026-11-23):** §3 "Hubs and the mesh" and §4 "Reaching every district" are
> replaced by `2026-11-23-arterial-gateways-design.md` (planning by district gateways). The rest
> stands, with the scale changes in `2026-11-24-city-scale-design.md`.

## Intent

Arterials are stage 3. They do two jobs, in the owner's words: "Arterials link districts" and
"Arterials divide districts".

- **Linking.** Every district can be reached from every other reachable district by arterial.
  It doesn't have to be a tree: "a little bit of redundancy would be welcome".
- **Dividing.** Arterials cut districts into large pieces. Later stages branch off them: local
  roads, and possibly collectors (pinned: they may be dropped where space is tight), then lots.

Arterial density does **not** depend on district density. The owner wants no more roads in
dense areas: "I feel like that's against how we're trying to get cities to be laid out in the
modern era (and against my preference!)". The network is **sparse**: a target spacing, not a
road across every district border. "Connected" means reachable.

## Goals

- **One connected network.** It touches every district (an arterial runs through it or along
  its edge), plus a few loops for redundancy.
- **Exits on the site edge are mandatory.** Some arterials lead off the site, as connections to
  the world beyond.
- **Arterials follow the terrain** and keep gradients as low as the land allows.
- **No sharp angles**, as far as possible: arterials don't meet at acute angles and don't
  zig-zag. They bend in curves.
- **Usable space.** The land left between arterials, and between arterials and district
  edges, is never a thin sliver. **Arterials prefer district borders:** they run along them
  where that goes their way, and cut across a district only when that's much more direct,
  then through its middle and crossing its borders at close to a right angle. (The owner chose
  this after a reviewer measured the districts: about 6 ha, or 250 m across, against arterials
  700 m apart. A road through a district anywhere but its middle leaves slivers, and touching
  every district with free-running roads would need a spur per district.)
- A road crosses the river only on a bridge. It never crosses the sea or a pond.

## Non-goals

- Highways. ("Let's not think about highways for now.")
- Collectors, local roads, blocks and lots: those are later stages.
- Varying arterial width or density by district type.
- Hand-drawing or dragging roads, and road overrides.
- Road surface detail, cut-and-fill earthworks, junction geometry and markings. The renderer
  can fake those later.

## Anti-goals

- More arterials in dense areas than in sparse ones.
- A district the network can't reach (when it's reachable at all).
- Hairpins, zig-zags, or junctions at sharp angles.
- Slivers of land squeezed between roads, or between a road and a district edge.

## Approaches

- **A. Hubs, a mesh, then terrain-following routes. Chosen.** Hubs are spaced points, joined
  into a pruned mesh; each link is routed as a least-cost path over the terrain. Connectivity,
  redundancy and low gradients are guaranteed by construction. The owner accepted it on
  condition that sharp angles are avoided and usable space is formed. Both are built into the
  design below.
- **B. Grow roads like vines.** Roads grow step by step, steering, branching and snapping onto
  each other. This gives the most organic look, but spacing and loops come out of tuning, not
  guarantees. Not chosen.
- **C. Recursive straight cuts across the land.** Mostly straight lines, which fight
  terrain-following. Dropped.

## Design

### Settings

| Setting | Range | Default | Effect |
|---|---|---|---|
| Arterial spacing | 300–1500 m, step 50 | 700 | Distance between hubs, and so between arterials. |
| Redundancy | 0–1, step 0.05 | 0.3 | The share of extra (loop) links kept beyond what reachability needs. |
| Exits | 1–8, step 1 | 3 | Arterials leading off the site edge. |
| Road width | 15–40 m, step 1 | 25 | Arterial width, including verges. |

| Junction angle | 30–90°, step 5 | 60 | The sharpest angle at which two arterials may meet. |
| Curve radius | 20–200 m, step 10 | 60 | The tightest bend an arterial may take. |
| Max grade | 2–20%, step 1 | 8 | The steepest grade an arterial should take. It's soft: cost rises steeply past it, but it's exceeded where there's no other way. |
| Usable width | 30–150 m, step 10 | 60 | The narrowest land left between roads, or between a road and a district edge (about a quarter of a district's width at the default). |

These three were constants in the first draft. The owner asked for them to be tunable, since
they're judged by eye. They interact: a stricter junction angle prunes more loop links, so
Redundancy has less effect. The cost-field weights, and the "quarter of its district's area"
part of the sliver test, stay internal.

### 1. The cost field

A raster over the site at about 10 m per cell, built from the terrain. Each cell's cost is:

- **Gradient:** grows with grade, and steeply past **Max grade**. Measure a cell's grade along
  the route's heading, not as the steepest slope, so a road traversing a slope along the
  contours pays little. Use the terrain's ground (`groundHeightAt` over the terrain regions).
  Flat costs 1. Below Max grade, cost rises gently. Above it, cost grows fast, for example with
  the square of the excess, so it's avoided wherever any reasonable detour exists, but it's
  never a hard wall: a place reachable only up a steep slope still gets its road. This makes
  roads follow the contours, with gentle switchbacks where they must climb.
- **Hills:** an extra factor, so roads go round hills where there's a reasonable way round,
  and over them where there isn't.
- **Water:**
  - The sea and ponds are impassable.
  - The river is passable at a high per-cell cost, so crossings are short and few. Each
    crossing becomes a bridge.
  - Bridges must cross at close to a right angle: a heading penalty inside river cells.
- **District borders are corridors:**
  - Cells on a district border (within about half a road width) are cheaper, around half the
    cost, so routes follow borders where that roughly goes their way.
  - Cells in a narrow band beside a border (from half a road width out to about 40 m) cost
    more for a road running parallel to it, so a road is either on the border or clear of it.
    The suggested penalty is `k × (1 − |cos θ|)`, where θ is the angle between the heading and
    the border normal. A road crossing the border at close to a right angle pays almost
    nothing.
  - Inside a district, cost rises towards its edges (a gentle valley along its middle), so a
    route that must cross a district goes through its middle.
- **Existing arterials:** after each route is placed, cost rises within the minimum usable
  width of it, except where the new route joins, crosses or shares it (along the same border).
  So routes don't run alongside each other. Update only the cells near the new route; never
  rebuild the whole field.

### 2. Routing

- **A\* on the grid** with heading as part of the state: 16 directions, with a turn penalty
  that grows with the size of the turn. That rules out zig-zags at the source.
- Routes end at hubs or join an existing arterial. A junction must keep the minimum junction
  angle (see §3).

### 3. Hubs and the mesh

- **Hubs:**
  - the main centre and the minor town centres (district anchors from the districts stage);
  - the exits;
  - then Poisson-disk points over land at the arterial spacing. A hub must land on land, and
    not on ground steeper than Max grade where flatter land is near.
- **Exits:** dead ends. Each is a degree-1 hub on the site boundary: its one arterial leaves
  the site at a right angle and joins the nearest hub or arterial. Exits are not part of the
  Delaunay mesh, so they never form loops along the boundary. They're points on the site
  boundary over land, never on the sea side. They're spread
  apart along the boundary (farthest-point along it) and placed where the land meets the edge
  at the lowest gradient nearby. Each exit's arterial leaves the site perpendicular to the
  edge.
- **Mesh:**
  1. Take the Delaunay triangulation of the hubs.
  2. Drop links over the sea or a pond, and links much longer than about 1.8 × the spacing.
  3. Keep a minimum spanning tree by estimated route cost. That's the network reachability
     needs.
  4. Add the remaining links, cheapest first, until the Redundancy share of them is kept.
  5. Skip a link that would meet another at a hub at less than the minimum junction angle. If
     a required (tree) link would, nudge the hub (up to a third of the spacing) to open the
     angle. If the angle still can't be met, keep the link and count it in the stats.

### 4. Reaching every district

After routing, every district must touch the network: the road band intersects it, or runs
along its edge within half a road width. Because routes prefer borders, most districts are
touched by roads running past them. Spurs should be the exception; the stats count them. For
each district that isn't touched:

- route a short link from the nearest arterial to the district, preferring its borders (the
  cost field already does). It ends once it touches the district: no dead end runs into its
  middle.

A district that can't be reached (on an island, say) is counted and left alone. The stats
report it.

### 5. Smoothing

- Each routed polyline is simplified (Douglas–Peucker, a few metres), then smoothed (Chaikin,
  `grammar/contour.ts`).
- Then it's checked against the minimum curve radius. A tighter bend is eased by widening it
  locally, as far as the cost field allows. Where it can't be, it's counted in the stats.
- Junction ends keep their position and approach angle.

### 6. The usable-space check

- Compute the pieces of land left inside each district after subtracting all the road bands.
- A piece is a **sliver** if it doesn't survive an inward offset of half the Usable width
  (30 m at the default, so it's under about 60 m across), or is under a quarter of its
  district's area. Districts are about 250 m
  across, so thresholds are scaled to districts, not to the spacing. A road along a border
  makes no piece at all.
- If a loop (redundancy) link produced the sliver, remove that link and recompute.
- Slivers caused by required links stay, and are counted in the stats. They're expected to be
  rare.

### 7. Output: cutting roads out of regions

The stage divides leaves, like every stage:

- **Each district** gets children that partition it:
  - **arterial** pieces: the road bands inside it, with kind `arterial` and attrs
    `{ road: <link id>, width }`;
  - **superblock** pieces: the rest of its land, with kind `superblock`.

  A district no road touches gets one superblock covering all of it. So the next stage always
  divides superblocks.
- **The river region** gets children: **bridge** pieces (kind `bridge`, attrs `{ road }`) where
  roads cross, and one `water` piece for the rest.
- **Sea and pond regions** get no children.
- Ids follow the usual pattern: `<district id>/arterial:N`, `<district id>/superblock:N`,
  `site/river/bridge:N`.
- **Stage data** on the site:
  - the centreline of every road, as `data.roads`: a new `RegionData` field, a list of
    `{ id, points: Point2[], exit: boolean }`. Later stages branch off it, and the renderer can
    draw from it.
  - stats: links, loops, exits, bridges, unreachable districts, sharp junctions, tight curves,
    slivers, and the length of road over Max grade.

### 8. Rendering

- `scene/renderers/arterials.ts` reuses the districts renderer's approach:
  - the terrain drawn with a baked tint;
  - superblocks coloured by their district's type (inherited through `resolveAttr`);
  - arterials baked into the same texture as dark asphalt. Roads add **no triangles** on
    land.
- **Bridges** are real geometry: a deck strip from the road band over the river, at the
  higher bank's elevation, plus a little. Its triangle count is negligible.
- Picking returns the superblock, arterial or bridge under the point.

### Performance

Aim for under about 1 s for the whole stage at 2 km with the defaults. To get there:
- use a routing grid of about 20 m;
- update the cost field incrementally;
- when pruning a loop link for a sliver, remove only that link's road; never re-route the
  others.

Log the stage time in the stats. A much slower result is a finding, not a pass.

## Testing

- **Pure modules** (cost field, A\*, mesh, smoothing, sliver check) get unit tests on synthetic
  inputs. For example: a ridge forces a route round it; a river forces one short
  perpendicular crossing; an acute-angle link is pruned.
- **Stage tests** (seeds 1–4 at defaults, plus extremes):
  - every district's children partition it, and the river's children partition it;
  - the network is connected, and every reachable district touches it;
  - there are exactly the requested number of exits, each ending on the site boundary over
    land;
  - no road over the sea or ponds, and every river crossing is a bridge;
  - junction angles are at or above the minimum, apart from counted exceptions;
  - curve radii are at or above the minimum, apart from counted exceptions;
  - slivers come only from counted required links;
  - the mean road grade is well below the grade of straight lines between the same hubs;
  - lowering Max grade lowers the length of road over it (or keeps it at zero);
  - the result is deterministic per seed.
- Extremes of every setting keep the partition and finish in time.
- **Visual check:** screenshots on a few seeds, at spacing 400, 700 and 1200 and redundancy 0
  and 0.6, and in the app.

## Back pocket

If the cities look too small, scale everything up together: districts, regions and spacing.
The owner: "maybe we want to expand everything. Let's keep that in our back pockets."

## Left to the builder

- Exact cost weights, the grid resolution and the heading discretisation.
- The Poisson-disk method and the hub-nudging details.
- How tight curves are eased.
- Module layout under `stages/arterials/`. Suggested: `cost.ts`, `route.ts`, `hubs.ts`,
  `mesh.ts`, `smooth.ts`, `space.ts`, `stage.ts`.
- The asphalt colour and the bridge's look.

# Arterials by gateways

Replaces the planning half of the arterials stage (`2026-11-23-arterials-design.md`, §3 "Hubs
and the mesh" and §4 "Reaching every district"). The cost grid, routing, smoothing, the
usable-space check, the cutting of roads out of regions, bridges, output and rendering stay as
that spec and the city-scale spec (`2026-11-24-city-scale-design.md`) describe them.

## Why

The hubs-and-mesh network kept producing dead ends: at the shore, at the site edge, just past a
bridge, and inside Undeveloped land. Spurs hooked back on themselves as hairpins. Each fix
(keeping hubs off water, pruning dead ends, closing them, carrying them off the edge, rerouting
spurs) exposed the next problem. The root cause is that hubs are arbitrary points: a hub the
mesh leaves with one link is a dead end, wherever it happens to be.

The owner proposed planning the network over **districts** instead: build the graph of which
districts touch, choose which neighbours to link, put a **gateway** on each chosen shared
border, and connect each district's gateways inside it. A road then always runs from gateway to
gateway, so it ends only at a junction.

The owner on dead ends: "I don't think arterials should have dead ends, that's a pretty rare
situation even in real life."

## Goals

- **No dead ends.** Every road ends at a junction, on a bridge, or at the site edge (an exit).
- **Linking** (unchanged from the arterials spec): every developed district is reachable, with
  some redundancy (loops), set by **Redundancy**.
- **Dividing:** roads run through districts or along their borders, cutting them into
  superblocks.
- **Variety:** some district roads run **through** the district (gateway to gateway across it),
  and some run **along its border** (gateway to gateway around it). The owner: "B *and* C for
  variety".
- The owner's standing rules hold on every road:
  - **usable space**: no slivers between roads, or between a road and a district edge;
  - **follow the terrain** and keep grades low;
  - **avoid sharp turns**: no hairpins or zig-zags, and no junctions sharper than the Junction
    angle.
- Bridges and exits are part of the plan, not added afterwards.

## Non-goals

- Highways (still out of scope).
- More roads in denser districts. Density still doesn't add arterials.
- Any change to the cost grid's terrain, water and grade costs, to smoothing, cutting, bridges
  or rendering, beyond what's below.
- Converting saved cities: they keep their stored roads until Arterials is regenerated.

## Anti-goals

- A dead end anywhere: a developed district with one link, an Undeveloped district with one
  link, a road stopping short of the edge, a stub over a bridge.
- Gateways bunched together, or at a border's corner (a road there squeezes a sliver).
- Hairpins, zig-zags, and acute junctions.

## Approaches

**Where the network comes from:**

- **Gateways on a district graph. Chosen** (the owner's proposal). Dead ends are ruled out by
  construction, roads cross borders square-on at chosen points, and bridges and exits are
  just more gateways.
- **Hubs, a Delaunay mesh and routes. Rejected:** the current design. Dead ends arise from leaf
  hubs, and the fixes kept compounding (see Why).

**Which neighbours get linked:**

- **A tree plus loops, no leaves. Chosen** (the owner). A spanning tree over the districts, then
  every developed district with only one link gets another, then Redundancy adds loops.
- **Every neighbouring pair. Rejected:** a few gateways per district everywhere, leaving
  nothing for Redundancy to control.
- **A tree plus loops with leaves allowed. Rejected:** every leaf is a dead end.

**How gateways are spaced:**

- **Spacing as a minimum. Chosen** (the owner). Gateways come from the chosen links. The
  spacing only stops two from coming too close.
- **One gateway per spacing of border. Rejected** (my first proposal): it fixes density by
  border length, not by the network's needs.

**How roads run inside a district:**

- **Through roads and border roads, mixed. Chosen** (the owner: "B *and* C").
- **A star to a central junction. Rejected** in general: five or six spokes break the
  Junction angle and leave wedge-shaped slivers. It's kept for town centres only (below).
- **Border roads only. Rejected:** they don't divide districts, and Voronoi borders ignore the
  terrain.

## Design

### Settings

| Setting | Range | Default | Change |
|---|---|---|---|
| Gateway spacing | 500–5,000 m, step 100 | 2,000 | Renamed from Arterial spacing. Now the closest two gateways may be. |
| Redundancy | 0–1, step 0.05 | 0.3 | Now the share of the remaining district links added as loops. |
| Border roads | 0–1, step 0.05 | 0.3 | **New.** The share of eligible gateway pairs joined along the border rather than through the district. |
| Exits | 1–8 | 3 | Unchanged: links to "outside". |
| Road width, Junction angle, Curve radius, Max grade, Usable width | | | Unchanged. |

The setting key `spacing` is kept so saved settings still load. Only the label and help text
change.

### 1. The district graph

- **Nodes:**
  - every district, developed or Undeveloped;
  - one **outside** node standing for the world beyond the site edge.
- **Edges** (candidate links):
  - **Border links.** Two districts that share a border long enough to hold a gateway: at
    least 2 × Usable width + Road width. This uses the district graph's `sharedLength`
    (`stages/districts/graph.ts`). Its `TOUCH` threshold (3 m) is too short here.
  - **River links.** Two districts facing each other across the river, from the district
    graph's water crossings. Their gateway is a bridge.
  - **Exit links.** A district with land on the site edge, to the outside node.
- **Edge cost:** the estimated route cost between the two districts' centres through the best
  gateway candidate, using the existing cost grid. That already makes Undeveloped land (×3),
  hills, grade and the river (×30) dear.

### 2. Choosing links

1. **Tree:** the minimum spanning tree (Kruskal, by edge cost) over the border and river links.
   Then repeatedly drop Undeveloped districts left with a single link, so an Undeveloped
   district carries tree links only where a road passes through it.
2. **Exits:** the Exits setting's number of exit links, spread apart along the site boundary.
   Reuse the farthest-point spreading from `placeExits`, choosing the flattest land.
3. **No leaves:** every developed district with exactly one link gets its cheapest additional
   link. Repeat until none is left with one. This is where links can be added to Undeveloped
   districts.
4. **Loops:** add the Redundancy share of the remaining developed-to-developed links, cheapest
   first. Skip a loop that would put two gateways on one district closer than the spacing.
5. **Undeveloped districts:** zero links, or two or more, never one. After step 4, an
   Undeveloped district with one link has it removed, and step 3 runs again for any developed
   district this leaves with one.

A developed district with no possible second link counts in the stats (`leaves`), and its one
road ends at a junction near its middle (§4). That should be rare: an island, a peninsula.

### 3. Placing gateways

- One gateway per chosen link, on its shared border:
  - at least the Usable width from either end of the border (from its corners);
  - on a straight part of the border, so the road crosses it square-on;
  - preferring flat ground.
- **Spacing:** no two gateways on the same district's perimeter closer than the spacing
  (straight-line). Gateways are placed tree links first, then exits, then no-leaf links, then
  loops. A loop that can't be placed is dropped. A tree, exit or no-leaf link that can't be
  placed takes its best position anyway, and is counted (`crowded`).
- **Bridge gateways:** a bridge across the narrowest, straightest reach of river between the two
  districts, square to the banks. It has a gateway point on each bank, and each district treats
  its bank point as its gateway.
- **Exit gateways:** a point on the site edge over land, flattest nearby. The road leaves the
  site square-on (as today's exits).

### 4. Roads inside a district

Each district joins up its own gateways:

- **Two or more gateways.** Pair them up:
  - **Through roads:** pair gateways on roughly opposite sides. The angle between them, seen
    from the district's centre, should be near 180°. Route each pair across the district.
  - **Border roads:** a pair of gateways that are neighbours around the perimeter, with the
    border between them fairly straight (no turn sharper than the Junction angle) and shorter
    than about half the perimeter, is **eligible**. The Border roads setting is the share of
    eligible pairs joined by a road along the border (seeded). That road runs on the border
    line itself, so it straddles the neighbouring district; its band is cut from both.
  - With an odd number of gateways, the one left over joins the nearest road already in the
    district, at a T-junction.
- **Town centres** (main and minor anchors): every gateway's road meets at one central junction,
  on clear flat ground near the middle. Where that would break the Junction angle, two roads
  merge before the centre. (My call: real roads converge on town centres. The owner hasn't
  ruled on it.)
- **One gateway** (a counted leaf): its road runs to a junction near the district's middle.
- **Undeveloped districts** with links: through roads only. No border roads, no town centre.

**Routing:** each through road is routed on the cost grid between its two gateways:
- it leaves and arrives square to the border for a short straight stub;
- it stays inside its district, plus a cell's margin;
- it keeps the turn limit from the Curve radius (from the parked `wip/arterial-dead-ends`
  branch, `route` `maxTurn`), so there are no hairpins.

Through roads that cross make a junction where they cross. Placed roads keep repelling parallel
neighbours within the Usable width (the existing road field).

**Continuity:** where a road arrives at a gateway and the neighbouring district's road leaves
from it, the two are chained into one polyline before smoothing, so a road runs on smoothly
from district to district.

### 5. Checks and repairs

- **Connectivity** holds by construction. If a route fails (blocked ground), the existing
  connector repair joins the stray piece, and it's counted.
- **Slivers:** the existing check. A loop link whose roads cause a sliver is removed, if
  removing it leaves no district with one link.
- **Dead ends:** counted in the stats (`deadEnds`), and expected to be 0. Tests require it.

### 6. Output

As today: districts are divided into `arterial` and `superblock` pieces, the river into
`bridge` and `water`, and the site gets `data.roads`.

- **Road ids** come from a counter, so they never repeat. Reused ids were a real bug, found on
  the parked branch.
- **Stats:** districts, links, tree, loops, exits, bridges, gateways, throughRoads, borderRoads,
  leaves, crowded, deadEnds, connectors, unreachable, sharpJunctions, tightCurves, slivers,
  overGrade, ms.

### Removed

Poisson hubs, the Delaunay mesh, spurs, dead-end pruning and closing, hub keep-off from water,
and the corner-finishing hack. Kept from the current stage and the parked branch:
- the grid, including the Undeveloped cost, shorelines not counting as borders, the
  beside-a-border penalty out to the Usable width, and border snapping;
- `route` with `maxTurn` and `maxCost`;
- smoothing, `joinTo`, the cut and bridges.

## Testing

Stage tests at 30 km, seeds 1–3, plus the 2 km `SMALL_SCALE` set:
- partitions, as now;
- **no dead ends:** every road end meets another road, a bridge, or the site edge;
- every developed district has at least two links, or is a counted leaf. No Undeveloped
  district has exactly one;
- no two gateways on a district closer than the spacing, apart from counted `crowded` ones;
- every road crosses the border at its gateway within about 20° of square;
- no hairpins (no turn over 90° within 2 × Curve radius);
- Border roads 0 gives no border roads, and Border roads 1 gives some on every seed;
- higher Redundancy gives more loops;
- the existing tests stay green: water, bridges, follows the terrain, grade, keeps out of
  Undeveloped land, roads on borders rather than beside them, determinism and timing (under 3 s
  at 30 km).

Unit tests for the pure parts: link choice (tree, no leaves, loops, the Undeveloped 0-or-2 rule)
on small synthetic graphs, gateway placement on a synthetic border, and gateway pairing.

Visual check: screenshots of seeds 1–3 at Border roads 0, 0.3 and 1, and in the app.

## Left to the builder

- Module layout. Suggested: `links.ts` (graph and link choice), `gateways.ts`, `inside.ts`
  (pairing and district roads), with `stage.ts` assembling them.
- How "roughly opposite" and "fairly straight" are scored.
- How a town centre's junction is placed, and how roads merge before it.
- Chaining details at gateways.

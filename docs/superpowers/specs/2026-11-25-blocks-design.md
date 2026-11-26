# Blocks: collectors, local roads and zoned blocks

Status: in design with the owner, 2026-11-25. Stage 4 of the foundation
(`2026-11-20-foundation-design.md`), after arterials (`2026-11-23-arterial-gateways-design.md`).
The owner's zoning notes, `docs/notes/zoningBlocks.md`, are the source of truth for zones, the
district table and road facing (Financial corrected to UO, UCO, UCOR).

## Why

Arterials divide each district into superblocks (about 1 km across, a median near 125 ha, at the
10 km default). This
stage divides each superblock into blocks with collectors and local roads, and gives every block a
zone. Zones decide what the next stages build: lots, then buildings. The owner wants:

- Collectors wherever they fit, in every developed district, skipped only where they don't.
- Districts to look different: Suburban and Rural sparse, with long blocks hugging the terrain;
  the rest dense and more regular. Everything *tries* to follow the terrain.
- Connectivity: no dead ends. Cul-de-sacs are rare and only in Suburban.
- Zones mixed, not clumped. Commercial corridors should come from the road rules (HC and MCR face
  only collectors), not from clustering.

## Goals

- Every developed superblock is divided into blocks by **collectors**, then **local roads**, by
  recursive cuts. Each cut is a road running border to border across the piece it divides,
  traced along a direction field that follows the terrain.
- A road's category is decided **when it is cut** (its width is cut out then): a collector while
  the piece is larger than the collector spacing and both halves still fit a row of blocks on each
  side, else a local road.
- Every road meets a road at one end at least; the other meets a road or **open land** (water,
  Undeveloped land, the site edge), so the city's outskirts stay rough. Cul-de-sacs (a cut ending
  inside the piece) only in Suburban, and rare. *(Revised with the owner, 2026-11-25; see "Edges
  without a road".)*
- Two spacing families. **Sparse**: Suburban, Rural. **Dense**: Town core, Town business, Low
  urban, Urban, Financial. Sparse fields follow the contours closely; dense fields follow the
  superblock's longest edge (a grid) and turn towards the contours only where a road would
  break the local Max grade.
- Every block holds at least one lot of its zone's smallest lot size. Blocks otherwise take
  whatever size and shape the cuts leave.
- Each block gets **one zone**: from those its district allows, among those whose lots may face a
  road the block borders, chosen at random weighted by the district's use frequencies.
  Independent per block (no pull towards neighbours).
- Residential lots never face an arterial (deliberate, the owner's rule).
- It works at the 10 km default, and still at 30 km (slower): generation and drawing stay within a
  budget we measure and record.

## Non-goals

- Per-district block settings in the editor (only zone pins).
- Lots, buildings, parks, civic uses. Only houses, commercial and offices (the zones in the notes).
- Anything in Undeveloped districts: they stay as they are.
- Collector or local road networks that cross arterials as one continuous street (each superblock
  is divided on its own, apart from the shared border streets below).
- Changing arterials or the defaults (10 km since 2026-11-25).

## Anti-goals

- Dead ends, or roads that wander out of their superblock.
- Salt-and-pepper caused by bugs: a block whose zone breaks the district table or facing rules.
- Clumping zones on purpose. The owner prefers mixes.
- Hairpins, self-crossing or kinked roads (the arterial stage's lesson).

## Approaches considered

1. **Recursive straight cuts** (classic block subdivision). Simple and fast, crisp grids, but
   straight lines can't follow contours: Suburban and Rural would be tilted grids.
2. **Streets traced over a whole superblock along a direction field** (tensor-field generators).
   Follows terrain well, but it isn't a recursion: road categories, the collector fit test and
   dead-end clean-up all become passes after tracing (the owner's worry about post-steps).
3. **Recursive cuts, each traced along a direction field (chosen).** Keeps the recursion and
   type-at-cut; the field carries the district character and the terrain. Costs a traced cut and
   a kink check per cut.

Also rejected: typing roads *after* the recursion. A collector is wider than a local road and the
width must be cut out at the cut (stages only divide); promoting roads afterwards means reserving
the widest strip everywhere or widening later. Promotion stays as a possible fallback if
type-at-cut looks wrong in practice.

## The design

### Input and output

- Leaves: the arterial stage's `superblock` nodes (under districts). Undeveloped districts'
  superblocks are left alone.
- Each superblock gets flat children: `collector:n` and `local:n` road strips (attrs: `road` id,
  `width`) and `block:n` regions (attrs: `zone`, or `zone: null` when none is possible; see
  below). The recursion tree isn't stored; the children partition the superblock (the
  subtractive invariant holds).
- Road centrelines with their category go into the site's data (as arterials' `data.roads`), for
  the renderer and diagnosis. Stats: block counts per zone, collectors skipped, zone fallbacks,
  unzoned blocks, cul-de-sacs, dead ends (expected 0), time.

### The cut

At each step the largest piece not yet a block is cut:

1. **Direction field.** At a point, a blend of the direction of the nearest road edge of the piece
   (so cuts meet roads squarely) and the contour direction from the ground, weighted by slope.
   Sparse districts weight the contours strongly; dense ones only enough to keep a road under the
   local Max grade.
2. **Where.** Roughly through the piece's middle, across its longest dimension, so blocks shrink
   evenly. The cut is a streamline traced both ways from there until it meets the piece's border.
3. **Accept** only if both ends land on a road edge, it doesn't kink (no turn over 120°, simplified
   as laid), cross itself or break the Max grade, and both pieces are at least the minimum block
   size. Otherwise try another start point or orientation, then a straight cut, then stop: the
   piece is a block.
4. **Type.** Collector if the piece is larger than the collector spacing and both halves are at
   least two block depths across; else local. Local roads prefer ends on collectors or locals over
   arterials (disfavoured, not banned).
5. **Stop** when a piece is within its family's block size, or no cut fits.

Pieces whose only road edge is one side (against water, the site edge, hills) can only be divided
by cuts from that side back to it. In Suburban, rarely, a cut may end inside the piece instead
(a cul-de-sac).

### Edges without a road

*(Revised with the owner after the first build, 2026-11-25.)* At the 10 km defaults the arterials
enclose little: superblocks run to 650 ha with 20–60% of their outline on an arterial, the rest on
district borders, water and Undeveloped land. Requiring both ends of every road on a road left
three quarters of the developed land as single blocks.

- **District borders between developed districts get a shared collector**, whatever lies at its
  ends: each side cuts half a collector's width, together one street. Every block must face a road,
  so a district border can't be left bare.
- **Open land** (water, Undeveloped land, the site edge) may border blocks, which meet it with a
  rough edge. A road may end there if its other end meets a road (so no street runs from shore to
  shore joined to nothing). Cuts meeting roads at both ends are preferred.
- Any other roadless edge: the cut turns and follows the edge, inside the piece, to the nearest
  road (at most two block lengths; in practice this almost never happens now).
- A piece the planned cuts can't divide (odd shapes, a road on one side only) is cut square off
  its road edges.

Rejected: **perimeter roads along every shore and Undeveloped edge** (the owner doesn't want shore
and park-edge roads), and **following roadless edges without limit** (it laid 50–70 km of edge road
per city, which comes to much the same).

### Zones

For each block: the district's zones (notes table, Financial corrected), filtered to those whose
lots may face at least one road category the block borders (arterial, collector, local, per the
notes), then a weighted random pick.

Weights come from use frequencies per district type. A zone's weight is the mean of its uses'
weights, so a mixed zone neither dominates nor vanishes. Proposed defaults (owner to tune):

| District | Residential | Commercial | Office |
|---|---|---|---|
| Suburban, Rural | 6 | 1 | 1 |
| Town core | 1 | 4 | 1 |
| Town business | 1 | 1 | 4 |
| Low urban, Urban | 3 | 3 | 1 |
| Financial | 0.5 | 1 | 4 |

If the district's favoured zones can't face any road the block borders (no collector fitted), the
pick falls back to the remaining valid zones (counted). If no zone is valid at all (a Suburban
block bordered only by arterials), the block is unzoned (`zone: null`, counted) and left as open
land.

### Editing: zone pins

The user can pin a block's zone, as with district types (`overridable: { block: [zone] }`).
Overrides re-attach by anchor point when blocks regenerate (the existing `pipeline/overrides.ts`),
with a toast when one is dropped. A pin is honoured only where the generator could have chosen
it: the district allows the zone, and the block borders a road category its lots may face
(`validateOverride` gives the reason otherwise). Zones are picked independently per block, so a
pin changes nothing around it, and the blocks' geometry doesn't depend on zones, so pinning never
reshapes the cuts. Per-district block settings (spacing family, collector spacing, cul-de-sacs)
are not editable for now.

### Settings (proposed)

- Collector width 18 m, local road width 12 m (including verges).
- Dense and sparse families: block depth range and collector spacing (dense about 400 m, sparse
  about 700 m), from which minimum block size follows.
- Local Max grade (default 10%, steeper than arterials).
- Cul-de-sac share (Suburban only, default small).
- Use frequency weights and zone tables live in code (`rules.ts`), as the district neighbour
  table does, not in the UI.

### Scale and budget

**Measured (2026-11-25, straight cuts, before terrain following):** at 10 km, seeds 1–3, 2,500–3,800
blocks, the stage in 0.15–0.25 s in Node, saved cities 2–3 MB. At 30 km (seed 1), 17,000 blocks,
1 s, 14 MB. The gate passes.

At the 10 km default, roughly 50 km² is developed: a few thousand blocks (dense blocks around
1–2 ha, sparse ones several). At 30 km, nine times the area, it may be tens of thousands. Targets to measure in the plan's first task
and record here: generation time (aim: a few seconds in Node, like arterials), block count, and
triangles drawn. Local roads likely can't each be a ribbon like arterials; collectors may be. The
renderer can tint blocks by zone from a baked texture, as districts do.

*(Claude's calls.)* Blocks are ordinary region nodes, as the foundation design has every region:
that's what lets overrides and the Inspector reach them, and what lots will divide. Their size in
the saved city, the autosave and the worker transfer is part of the measurement. The first plan
task is a **gate**: if the numbers come out far over (generation well past ~10 s, or a saved city
too big to autosave smoothly), work stops and the numbers go to the owner, with options (coarser
sparse blocks, compact storage, a smaller default site). The plan doesn't degrade on its own.

## Left to the builder

- The field's exact blend and the tracing step; start-point and orientation retries.
- Minimum lot sizes per density used for the block minimum (a provisional table; the lots stage
  owns the real ones).
- How the renderer draws local roads and collectors within the budget.
- Seeds: per stage as usual, so regenerating blocks never disturbs arterials.

## As built (2026-11-25)

- **Squareness** (the owner's ask during the build): a final block fills at least 70% of its
  oriented box (or 90% of its parent's fill, for odd superblocks), is a lot deep throughout, and
  road ends meet at 50° or more; a traced cut meeting its road at a slant gets a short square stub.
- **Grade** is checked on the ground smoothed over 200 m, the same surface the field steers by.
- **Cul-de-sacs are not built.** With roads allowed to end on open land, the piece they were for
  (no through cut fits) hardly arises; the setting was removed rather than left doing nothing.
- **Collectors come out in pieces**, each across the piece being cut, not as long corridors.
  Left for the owner to judge.
- Block sizes stay at the proposed defaults (dense 70 × 160 m, sparse 120 × 400 m): the owner
  prefers more lots per block.
- **Steep ground (revised with the owner):** Town cores may sit on slopes of 30%+, which the 10%
  local grade made uncuttable (100 ha single blocks). The Max grade is now a preference: metres
  over it cost, and only past 3× it is a road refused; the field snaps to the contour grid rather
  than make oblique slivers, and on ground past the ceiling runs up it on the diagonal at the
  ceiling. Developed land in blocks over 20 ha: 0–4% (seeds 1–3).
- Road shades: arterials near-black, collectors dark grey, locals light grey (the owner's ask).

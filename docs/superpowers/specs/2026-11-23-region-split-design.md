# Terrain: split big regions at their necks

## Why

Districts come next, and each terrain region will hold one or more districts. Today a region
is every touching cell of one kind, so sizes range from slivers to 80 ha, and big regions
spread across the map through narrow gaps. A region should be a sensible piece of land:
compact, bounded by what the terrain does, and of a similar size to its neighbours.

At the defaults (2 km, four seeds), the largest land region is 50–80 ha. There are also
15–25 regions under 1 ha.

## Goals

- Land regions bigger than a target size are divided into pieces of roughly that size.
- Cuts go where the land narrows (a neck between two bulges, a gap between hills), never
  through the middle of an open area when a neck is available.
- A strip bounded by other features (land between a pond and the river) stays one region
  unless it is itself well over the target.
- Small regions are never cut, so they keep reaching through gaps.
- The pieces of a split flat keep one shared level, so neighbouring pieces stay flush.

## Non-goals

- **Slivers stay.** A small region of a very different kind (a flat wedged between hills and
  a pond) is a legitimate region. Nothing is merged across kinds and no cell changes kind.
- Water (sea, river, ponds) is never split.
- No change to classification, levels, elevations, ground or rendering.

## Anti-goals

- Regions that still meander through the map after splitting.
- Pieces that differ in level or tilt where they meet.

## Approaches

- **A. Grow from seeds.** Seeds are spread out and grow together, smallest first, with narrow
  gaps costing extra. This gives the most even sizes, but whether a neck is found depends on
  where the seeds start.
- **B. Cut at the best neck, repeatedly. Chosen.** It finds necks directly, and a sprawling
  region is exactly one with necks. Small regions are never touched. Sizes are less even,
  within about a factor of two of the target.
- **C. Build regions up from cells by merging, with a size limit.** Rejected. Today's regions
  are already the fully merged result, and greedy merging tends to sprawl, which is the
  thing to remove. The owner first pictured this one, to keep the number of passes down,
  then decided the passes aren't worth limiting while each one improves the result.

## Design

- **A new setting, Region size**, in hectares: `regionSize`, number, about 5–100, step 5,
  default 20. Help text: "Big areas are cut into regions of about this size".
- **Where it runs:** a new pure module `stages/terrain/split.ts`, called in `stage.ts` once
  the flat separation loop has settled, just before regions are built. Levels, overrides
  and `minLevel` are all computed on the unsplit groups. A piece inherits its parent's
  `minLevel`, and its flat level is the parent's level.
- **What it splits:** groups of kind flat, slope or hills. It works on the cell graph:
  neighbours, weighted by shared edge length. Cuts follow existing cell edges, so no new
  geometry is made and the partition stays exact.
- **The loop:** while some group is over 1.5 × the target, find its best cut, split it in
  two, and put both pieces back in the queue.
- **The best cut** divides the group into two connected pieces, each at least 0.4 × the
  target. Among those, it has the lowest `cut length / sqrt(smaller piece's area)`. A neck
  is short compared with what it joins, so it scores well. A cut across a uniform strip only
  wins when the strip has no neck and is too big. If no cut is legal, the group stays whole.
- **Deterministic:** it uses no rng, so it disturbs no other random draw. Every terrain
  result is unchanged apart from the splits.
- **Names:** pieces are numbered with the existing per-kind counters (`flat:0`, `flat:1`, …).

## Left to the builder

- **How candidate cuts are found.** My call: a spectral sweep. Take the Fiedler vector of
  the group's edge-length-weighted Laplacian (groups are a few dozen cells, so a small dense
  eigensolver is fine), sort the cells by it, and score every prefix whose two sides are
  both connected. A sweep over graph distance from a few extreme cells is an acceptable
  fallback if the spectral order misses an obvious neck in testing.
- **Exact limits:** the 1.5 and 0.4 factors and the range of the setting. Tune them against
  screenshots.

## Known effect

A flat elevation override still matches its group by anchor before the split, so it sets
the level for every piece. After the split, the override shows on the piece under its
anchor, and editing it moves all of that flat's pieces together. That is consistent with
"neighbouring flats stay flush".

## Testing

- **Unit tests on synthetic graphs:**
  - Two blobs joined by a neck are cut at the neck.
  - A uniform strip under 1.5 × the target is not cut.
  - Pieces are connected and respect the minimum size.
  - Groups under the threshold are untouched.
- **Stage tests:**
  - No land region exceeds a bound tied to the target.
  - The partition still holds.
  - Split flat pieces that touch have the same elevation.
- **Visual check:** screenshots at the defaults on two or three seeds.

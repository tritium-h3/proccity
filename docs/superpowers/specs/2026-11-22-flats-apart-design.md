# Flats at different levels never touch

## Problem

Where two flats at different levels meet, a shared corner takes the lower level, so there's
never a cliff between them. But a cell's ground is only its corners and its centre, so the
whole drop tilts the higher flat across its full width. The worst case found was a 45 m
shelf beside a 12.5 m river flat, ramped across all 15,600 m². The pyramid "fin" was the
extreme case. Of the flats touching no water, 16 % of the area was steeper than 5°.

## Goals

- Flats at very different levels never touch. The drop happens on a slope cell between
  them instead of tilting a flat.

## Non-goals

- Flats beside water: perched ponds lifting a flat's rim, and river banks lifting corners
  near a steep river. These have separate causes. The perched pond is parked.
- Variation inside one flat region, such as a river flat following its river. Applying the
  rule inside regions shattered flats (194 became 470) and barely helped.

## Design

`steppedFlats` in `rules.ts` returns the flat cells to convert. A cell converts when it
touches, even at a corner, a flat cell of another region whose level is more than
`FLAT_STEP` (2 m) lower. Coastal flats step 1 m per hop, so 2 m leaves them alone.

The stage repeats this until it's stable, for at most six passes. Each pass converts those
cells to slope, merges regions again, and recomputes levels, because a shelf's level is its
cells' average. The rng values that levels use are drawn once and replayed on every pass,
so passes are deterministic and the first pass is unchanged.

A flat with a raised elevation override can now lose its border cells to slope. The
override stays anchored by its point.

## Rejected

- Keeping flats level with a ring of points inside each flat, which turns big drops into
  cliffs.
- Capping each level to within a step of its neighbours, which pulls high shelves down.
  The owner preferred this classification rule.

## Result

Flats touching no water went from 16 % to 0.5 % of their area steeper than 5°. Generation
takes about 30 % longer, from the extra passes.

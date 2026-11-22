# Pond clusters (terrain v2 tweak)

**Date:** 2026-11-22 · **Status:** Approved

**Why:** single-cell ponds were too small and scattered. Adjacent pond cells should be one pond.

- **Settings:** `ponds` = how many ponds. New `pondSize` (1–10 cells, default 4) = roughly how
  many cells each grows to.
- **Growth:** each pond seeds at an eligible cell: a flat or slope, not touching the sea or
  river, not next to an existing pond. It then grows into random eligible neighbours (flats
  or slopes not touching water, not next to a *different* pond) until it reaches a target
  size, drawn per pond between 0.5× and 1.5× `pondSize`. If it runs out of room, it stops
  smaller.
- **Merging:** adjacent pond cells merge into one region (the `mergeRegions` special case
  that kept ponds single goes away).
- **Elevation:** one surface per pond, 0.5 m below the lowest land cell around the whole
  pond. Corners touching land are bank (surface + 0.5 m). Corners shared only by pond cells,
  and cell centres, are bed (surface − 2 m).
- **Unchanged:** ponds never touch the sea, a river or another pond. `stats.pondsPlaced`
  counts ponds placed.

Approaches considered for sizing: a size target (chosen; predictable) vs a per-neighbour
growth chance (more varied, harder to control).

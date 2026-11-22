# Irregular cells (terrain v2 tweak)

**Date:** 2026-11-22 · **Status:** Approved

**Why:** jittered-grid seeds plus Lloyd relaxation made near-regular cells, and the map looked
grid-like. The owner wants far more varied cells, including sharp and triangular ones.

**Approaches:**
- A. Unrelaxed random Voronoi with variable density: simple, but few triangles.
- B. Delaunay triangles as cells: all sharp, but crystalline.
- C. Voronoi plus random straight cuts (chosen): wedges, triangles and slivers among larger
  polygons, and literally the grammar's split.

The owner had pictured B and chose C.

- **Seeds:** random, with density modulated by low-frequency noise (some areas get many small
  cells, others a few large ones). No relaxation. `cellSize` = typical spacing.
- **Cuts:** before clipping to land, a share of cells (≈ 0.6 × `irregularity`) is split by a
  random straight line through the cell, and each piece is cut again with probability
  ≈ 0.4 × `irregularity`. Cut points are inserted into the neighbouring cell's outline too, and
  Clipper preserves in-line points, so there are no T-junctions. Cuts leaving a piece under
  1 m² are skipped. New setting `irregularity` (0–1, default 0.5); 0 means uncut random
  Voronoi.
- **Hops unchanged** (owner's call): rules and levels still use cell hops.
- **Counts that were sizes become areas:** `pondSize` is now hectares (0.5–10, default 4),
  and a pond grows until it reaches its target area (0.5–1.5× `pondSize`). Smoothing weights
  neighbours by shared edge length.
- **Strict pond rule:** a pond may not touch the sea, a river, or another pond, even at a
  corner (any contact within 1 m).

## Changed during implementation
- **Snapping** is boundary-aware (site-edge corners only snap along their edge, site corners
  are fixed) and memoised per original corner. The old snap could pull the site edge in, and
  was order-dependent.
- **Cuts** are skipped if a cut point lands within 3 m of any existing corner.
- **Ponds** also may not touch the site edge.
- **Elevations for free land** come from a smooth Gaussian field over position, blended up
  from the nearest pinned edge (flat, pond or bank) over about a cell's distance. The river
  floor applies by `riverHop` to all cells and also lifts coastal flats and pond surfaces.
  Per-cell averages produced 60–90 near-vertical facets per city with irregular cells.
- **Thin cells' centres** (within 3 m of their own edge) aren't used as surface points.

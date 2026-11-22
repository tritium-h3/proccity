# Rounded pond outlines

## Problem

A pond is a union of whole terrain cells, so from above its shoreline is the cells'
straight edges and hard corners. The shoreline is exactly the pond polygon: the water
surface is drawn over it, and the land at its edge is pinned 0.5 m above the water.
Render-time smoothing can't round it.

## Goals

- Pond outlines curve at every corner, convex and concave.
- The change is real geometry. The saved pond footprint is the rounded shape, so later
  stages (districts, lots) see the real shoreline, and picking matches what's drawn.
- Cells still partition the land exactly, with shared vertices on both sides of every
  edge (no T-junctions, no slivers).
- Polygon budget: a few points per corner.

## Non-goals

- Rivers and the coast, which are already built from smooth curves.
- Rounding flats, slopes or hills.
- The perched ("levitating") pond. It's a separate issue, parked for later.

## Design

`stages/terrain/ponds.ts`, `roundPonds(cells, isPond, radius)`, runs after classification
and before elevations, so elevations and ground meshes are built on the rounded cells.

For each vertex V on a pond outline:

- **Which side gets the curve:** the two *boundary rays* from V separate pond cells from
  land cells. The *inner* side is the one whose angle is under 180°: the pond at a convex
  corner, the land at a concave one. Corners within 10° of straight are left alone.
- **The curve:** a fillet of radius `radius`, a quarter of `cellSize`. Its tangent
  distance is clamped to 0.4 of the shortest edge at V. The curve is a quadratic Bézier
  with V as the control point, so it stays inside the corner triangle, and seen from V its
  direction sweeps steadily from one ray to the other.
- **Inner cells:** every cell on the inner side replaces V in its ring with the part of the
  curve inside its own sector. Any other ray from V on that side (a seam between two pond
  cells, or between two land cells) crosses the curve exactly once. That crossing point
  goes into both cells sharing the ray.
- **Outer cells:** the two outer cells along the boundary rays take the cut-off wedge,
  split at the curve's midpoint M. Each keeps V and gains the segment V–M. If a single
  outer cell spans both rays, it takes the whole wedge and drops V. Outer cells in between
  are untouched.

Each change is local to a disc around V that's smaller than any edge at V. Ponds never
touch water, the site edge or another pond, so a rounded pond can't come into contact with
any of them either. Neighbour graphs are left as they were: the only new contacts are
between cells that already met at V.

## Rejected

- **Faking it in the renderer.** Rounding only the water mesh shows the pond bed at
  convex corners and is hidden under the bank at concave ones. Fixing that means bending
  the land in the shader away from the saved geometry, so picking near the shore goes wrong.
- **Clipper offsets in and out with round joins.** This rounds corners robustly, but
  straight edges come back about 1 mm off the originals, which leaves long slivers against
  the neighbouring cells.

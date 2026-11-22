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

`stages/terrain/ponds.ts`, `roundPonds(cells, isPond, sigma)`, runs after classification and
before elevations, with `sigma` set to 0.25 × `cellSize`. It takes four steps:

1. **Find the shoreline.** A shoreline edge is a→b in a pond cell's ring whose reverse,
   b→a, is in a land cell's ring.
2. **Subdivide** every shoreline edge into pieces no longer than σ/2. Each new point is
   inserted into both rings that share the edge.
3. **Walk the shoreline** into closed loops. A vertex where a pond touches itself (two ways
   on) stays where it is, and splits its loop into open chains whose ends are held.
4. **Smooth.** Each vertex moves to a Gaussian average (σ) of its path's vertices. The
   average is taken by arc length and weighted by the length each vertex stands for, so
   uneven spacing doesn't bias it. A vertex moves in **every** ring that holds it, which
   keeps the partition exact by construction. A move is refused, retried at half and then a
   quarter of the distance, or skipped, if it would fold a cell or cross an edge. A fold is
   when the cells around the vertex no longer fan exactly once around it.

Moves are local, so the neighbour graph is left as it was. Ponds never touch water, the site
edge or another pond. Their shorelines only move into cells that already touch them, so a
pond can't come to touch any of those either.

Rounded ponds have narrow fingers that the 25 m grid of bed points misses. The pond's
ground therefore gets an extra ring of bed points 4 m inside the shore, every 8 m.
Otherwise a triangle joining only bank points could leave land standing above the water.

## Rejected

- **Faking it in the renderer.** Rounding only the water mesh shows the pond bed at
  convex corners and is hidden under the bank at concave ones. Fixing that means bending
  the land in the shader away from the saved geometry, so picking near the shore goes wrong.
- **Clipper offsets in and out with round joins.** This rounds corners robustly, but
  straight edges come back about 1 mm off the originals, which leaves long slivers against
  the neighbouring cells.
- **Filleting each corner by ring surgery.** This was implemented and tested first. Corner
  snapping leaves Voronoi corners with edges about a metre long, which capped the fillets
  at a metre, so those corners still looked sharp from any distance.

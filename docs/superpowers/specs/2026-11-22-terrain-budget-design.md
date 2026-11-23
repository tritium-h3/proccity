# Terrain polygon budget and orbit cost

**Status:** approved (owner: "all of those ideas seem very reasonable")

## Why

Orbiting felt slow on the owner's laptop. The terrain also drew about 23,000 triangles
(about 21,000 of ground after the smoothing pass split every triangle into four, plus
water), and the owner expects much more to render later. Terrain shouldn't be where the
polygons go.

## Goals

- Terrain draws about 6,000 triangles or fewer at default settings, ground plus water.
- Orbiting does less work per frame, without a visible change in the look.

## Non-goals

- Level of detail or streaming, which isn't needed at this scale.
- Measuring frame rate here. Headless Chrome renders in software, so the owner judges it on
  the laptop.

## Design

**Stored geometry:**
- The river polygon is built from a copy of its course simplified to within 0.5 m. The full
  course stays as data for the water surface. The river bed takes course points about
  every 25 m.
- Pond beds are just a ring of points 4 m inside the shore, every 16 m. With that ring, no
  triangle can join bank points across the pond, so the 25 m grid isn't needed.
- Pond cell centres, and centres of flat cells whose corners are all at the flat's level,
  are skipped.
- `decimate.ts` simplifies every region's finished surface, within 0.25 m on land and
  0.5 m on beds:
  - it removes interior vertices only, refilling each hole by ear clipping that keeps
    in-line points (`earcut` drops them, which would break shared edges);
  - it checks the tolerance at every point removed so far, and between vertices (the
    centres and internal edge midpoints of the new triangles), which caught a bank-to-bank
    bridge over the river bed;
  - boundary vertices are kept.

**Drawing:**
- **Adaptive smoothing:** an edge is split only where curving would move it by at least
  0.3 m, and never at water. Triangles are cut to match their split edges.
- **Water surfaces** are triangulated from their outlines alone.
- **Shadows:** `sun.shadow.autoUpdate = false`, redrawn for a second after a view change.
- **Pixel ratio** is capped at 1.5.
- **Noise:** per-pixel noise for colour comes from a baked 256² seamless RGBA tile, made
  from 4D simplex noise on a torus. **The bump stays procedural:** reading it from the tile
  made a regular cross-hatch, because bilinear slopes come out faceted. That's one noise
  evaluation per pixel, down from eleven.

## Result (defaults, average of 4 cities)

| | Before | After |
|---|---|---|
| Stored triangles | about 5,250 | about 3,350 |
| Drawn triangles (ground + water) | about 23,000 | about 5,660 |
| Generation | about 240 ms | about 170 ms |

Most of the remaining stored triangles are forced by region outlines: n boundary points
need at least n − 2 triangles. Simplifying shared boundaries consistently across both
regions would be the next step, if ever needed.

## Rejected

- **A general edge-collapse decimation:** vertex removal with exact refills is simpler,
  and is enough with boundaries locked.
- **Dropping the smoothing pass entirely** (about 4,600 drawn): the adaptive pass keeps
  the curves where they show, for about 1,000 more triangles.

# Arterial Loops Implementation Plan

**Goal:** every arterial loop spans at least 3 districts; no twin roads from one gateway.

**Spec:** `docs/superpowers/specs/2026-11-24-arterial-loops-design.md`

**Files:** `src/stages/arterials/loops.ts` (new, pure: loops and the districts each spans, road
pieces), `loops.test.ts`, `stage.ts`, `stage.test.ts`, `CLAUDE.md`.

### Task 1: `loops.ts`

- `localLoops(roads: Point2[][], districts: MultiPolygon[], o: { roadWidth: number; usableWidth: number; min: number }): { ring: Point2[]; districts: number[] }[]`:
  holes in the union of round-ended bands spanning fewer than `min` districts (a district
  counts when the hole ∩ footprint, offset inward by usableWidth/2, isn't empty).
- `piecesAlong(road: Point2[], others: Point2[][], tol: number): number[]`: arc-length positions of
  junctions along a road (crossings with other roads or itself, other roads' ends within `tol`).
- `cutPiece(road: Point2[], from: number, to: number): Point2[][]`: the road without that
  stretch (0–2 parts).
- Tests: a square of four roads around one district is a local loop, and one around a 2×2 grid's
  centre corner spans 4 districts; a strip strayed into isn't counted; junctions of a crossing
  and a tee; cutting a middle piece gives two parts.

### Task 2: the stage

- Self-crossing routes rejected beside `loops`.
- Coincident gateways in a district: the second pair's other gateway becomes a tee.
- After joins: open local loops (order and refusals per the spec); `localLoops` stat.
- Tests: the owner's city and seeds 1–5 at 30 km through the pipeline: loops under 3
  districts equal the `localLoops` stat, which stays at most 1 per city; no dead ends; no two
  roads leave one gateway into one district. The full suite stays green.
- CLAUDE.md arterials bullet; commit; merge; restart.

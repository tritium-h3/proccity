# Long Streets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Streets that continue across earlier cuts and sub-districts, with junction spacing by
road category.

**Architecture:** The blocks stage's division becomes one site-wide queue (`divideAll`), each
piece carrying its own `DivideCtx`. Candidate evaluation is split from committing a cut so a
continuation can evaluate fixed candidates in the next piece. A junction registry keyed by
`RoadLine` object prices near-miss junctions.

**Tech Stack:** TypeScript 7, Vitest, clipper2-ts via `grammar/clipper.ts`.

**Spec:** `docs/superpowers/specs/2026-11-27-long-streets-design.md`

## Global Constraints

- Spacing: arterial 0.75 × collector spacing, collector 0.75 × block length, local 0.5 × block
  depth, all from `targets(ctx)` of the piece being cut. Crossing tolerance: host half-width + 1 m.
  `JUNCTION_COST` = 2 (metres of score per metre short). `ARTERIAL_COST` removed.
- Continuation: across C and L roads; across A only for collectors. Near end within half the
  road width + 1 m of the expected crossing point; turn < 30°. Collector continues as C where the
  piece allows, else L; L stays L.
- `Street` gains `route: string`; `StreetData` and `data.streets` gain optional `route`.
- Children ids per sub-district unchanged in form. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A continuation into a piece that is already a finished block: must stop (no cut). Task 3 test.
- A local continuation reaching an arterial: must stop. Task 3 test.
- A continuation crossing into another sub-district: the segment is that sub-district's child and
  the partition holds per sub-district. Task 3 (stage test, existing partition tests).
- Oversized blocks must not grow (share of land in blocks over 20 ha). Task 4 probe.
- Route ids reference a recorded street. Task 3 test.

---

### Task 1: Junction registry and spacing (`junctions.ts`)

**Files:** Create `src/stages/blocks/junctions.ts`, `junctions.test.ts`.

**Produces:**
```ts
class Junctions { add(road: RoadLine, p: Point2): void; nearest(road: RoadLine, p: Point2): number /* Infinity if none */ }
minSpacing(category: Category, t: { depth: number; length: number; collectors: number }): number
junctionCost(roads: RoadIndex, js: Junctions, p: Point2, t): number
```
- [ ] Tests: `minSpacing('A', {depth:70,length:160,collectors:400}) === 300`, `'C' → 120`, `'L' → 35`;
  cost 0 when no road at p; 0 when the nearest junction is within half-width + 1 m (crossing);
  `(min − d) × 2` for a near miss on a local; 0 when d ≥ min. Fail first, implement, pass, commit.

### Task 2: One queue for the site (`divideAll`)

**Files:** Modify `src/stages/blocks/divide.ts`, `stage.ts`; tests `divide.test.ts`.

**Produces:**
```ts
interface Item { owner: string; piece: MultiPolygon; ctx: DivideCtx }
divideAll(items: Item[]): { byOwner: Map<string, { streets: Street[]; strips: MultiPolygon[]; blocks: MultiPolygon[] }>; stats: Record<string, number> }
```
`divideSuperblock(pieces, ctx)` stays as a wrapper (owner `''`). `DivideCtx` gains
`junctions: Junctions` (shared by every ctx, like `roads`). `tryAs` splits into
`best(piece, box, category, cands, ctx)` and `commit(...)`. Junction cost replaces
`ARTERIAL_COST`; committed ends register as junctions. The stage builds every developed
sub-district's items, calls `divideAll` once, and groups output by owner.

- [ ] Test first: `divideAll` with two owners (two rects side by side, an arterial ring round
  both and a collector between) returns output for both owners, each partitioning its piece;
  junction ends registered (no two local ends on the same road closer than its spacing in a
  1000 × 600 dense rect — or the stat `junctionsClose` is 0 there). Fail, implement, full blocks
  tests pass, commit.

### Task 3: Continuation and routes

**Files:** Modify `divide.ts`, `stage.ts` (record `route`), `src/doc/types.ts` + `validate.ts`
(optional `route` string on streets); tests `divide.test.ts`, `stage.test.ts`.

After `commit`, for each end on a C/L road (A too for collectors): step across, find the queued
piece Q containing the point, try candidates (traced from there with the arriving heading, then
the straight chord), accepted by `best` under Q's ctx with the alignment check; Q must still have
a plan. On success remove Q from the queue, commit with the same route, recurse on the far end.

- [ ] Tests first:
  - two rects separated by a 12 m local road band, a cut in the left one continues into the right
    one in line (a street segment in each with the same `route`, ends within 7 m across the road);
  - same layout but the road is an arterial and the cut is local: no continuation;
  - the right piece too small for a plan: no continuation;
  - stage (seed 1): median route length > 1.3 × today's 220 m; some route has segments in two
    sub-districts; every `route` names a recorded street id; `blockStats.continued > 0`.
- [ ] Implement; blocks + sub-districts tests pass; commit.

### Task 4: Measure, look, docs

- [ ] Probe seeds 1–3 (`scratchpad/probe/bricks.ts`): routes, median/p90 length, crossing vs
  staggered local ends, blocks, share of developed land in blocks > 20 ha, stage ms.
- [ ] Screenshot the blocks stage (CDP), compare with before.
- [ ] CLAUDE.md blocks section (queue, continuation, junction spacing principle), spec "As built"
  with numbers. Commit.

# Region Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut oversized flat/slope/hills regions at their necks into pieces of about `regionSize` hectares.

**Architecture:** A pure module `stages/terrain/split.ts` bisects a group's cell graph (edges weighted by shared edge length) using a spectral sweep, repeatedly, until no piece is over 1.5 × target. `stage.ts` applies it after the flat separation loop, so levels and overrides stay per unsplit group and the pieces inherit them.

**Tech Stack:** TypeScript 7, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-23-region-split-design.md`

## Global Constraints

- Split only kinds `flat`, `slope`, `hills`. Never water and never ponds. No cell changes kind.
- A group is split while its area is > 1.5 × target. Each piece must be ≥ 0.4 × target and connected.
- Score is `cut length / sqrt(smaller piece area)`, lowest wins. A group with no legal cut is final.
- No rng: the result is deterministic and disturbs no other draw.
- New setting: `regionSize`, label "Region size", number, min 5, max 100, step 5, default 20, unit `ha`, help "Big areas are cut into regions of about this size".
- Pieces of one flat share its level. `minLevel` is inherited from the parent group.

## Review Focus

- **A group whose cells form a ring around a pond.** The Fiedler order may not give connected prefixes. The sweep must check both sides' connectivity and fall back to "final" rather than emit a disconnected piece. Covered in Task 1 (ring test).
- **A huge regionSize (100 ha) on a small site.** Nothing is split and output is unchanged. Covered in Task 2 (extremes test).
- **A small regionSize (5 ha) at cellSize 250 (about 6 ha per cell).** No piece can reach 0.4 × target while splitting, but single cells still need handling. The loop must end; a one-cell group is never split. Covered in Task 1 (single-cell and tiny-target tests) and Task 2 (extremes).
- **Touching flat pieces with different elevation attrs**, from averaging rounding. Pieces must report the parent's level exactly. Covered in Task 2.
- **Wedge cells with zero-length or missing shared edges** (neighbours under 1 m are excluded). The graph may be disconnected inside a group. Splitting must treat the connected components it's given, never crash. Covered in Task 1 (disconnected test).

---

### Task 1: `split.ts`, the neck cutter

**Files:**
- Create: `src/stages/terrain/split.ts`
- Test: `src/stages/terrain/split.test.ts`

**Interfaces:**
- Produces: `export type GraphCell = { area: number; neighbours: number[]; edge: number[] }` (a structural subset of `Cell`).
- Produces: `export function splitGroup(members: number[], cells: GraphCell[], target: number): number[][]`. `target` is in m². It returns pieces as sorted cell-id arrays, in a deterministic order (by smallest id). A group not over 1.5 × target comes back as `[members sorted]`.

- [ ] **Step 1: Write the failing tests** in `split.test.ts`, building graphs with a helper `gridGraph(w, h, cellArea=1e4, edgeLen=100, removed?: Set<number>)` (4-neighbour grid, ids `y*w+x`):
  - `cuts two blobs at the neck`: two 5×5 blocks joined by a 1-cell-wide, 2-long corridor, with the corridor's shared edges at 20 m. With target equal to 25 cells' area, expect 2 pieces, each containing one whole block. A corridor cell may go either side.
  - `leaves a group under 1.5 × target alone`: a 3×10 strip of 30 cells, target 25 cells → 1 piece.
  - `splits a big uniform block into pieces near the target`: a 10×10 block, target 25 cells → every piece is between 10 and 37.5 cells, the pieces partition the members, and each is connected (BFS within the piece).
  - `never makes a piece under 0.4 × target`: a 6×6 block, target 25 → every piece ≥ 10 cells.
  - `a ring stays connected`: an 8×8 block with the middle 4×4 removed (48 cells), target 16 cells → all pieces connected and ≥ 6.4 cells.
  - `single cell and tiny target terminate`: a 1-cell group with target 1 m² → `[[id]]`; a 4×4 block with target 1 m² → 16 single-cell pieces or fewer, all connected, and the call returns.
  - `deterministic`: calling twice gives deep-equal output.
  - `disconnected input`: members are two separate 2×2 blocks, target 1 m² → no throw, pieces connected.

- [ ] **Step 2: Run** `npx vitest run src/stages/terrain/split.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement `splitGroup`.** Keep a queue of pieces. A piece leaves the queue as final when its area ≤ 1.5 × target or when `bestCut` returns null. Otherwise push both halves. Split disconnected input into components first. `bestCut(piece)`:
  - Weighted Laplacian over the piece's internal edges (weight = shared edge length). Get the Fiedler vector by power iteration on `cI − L`, with `c = 2 × max weighted degree + 1`, deflating the constant vector. Use a deterministic start (e.g. `v_i = i − mean`) and about 300 iterations, or until the change is under 1e-9. Groups are tens of cells.
  - Sort the cells by Fiedler value, ties by id. For each prefix k in 1..n−1, keep a running prefix area and a cut length, updated incrementally: adding cell u adds its edges to cells outside the prefix and subtracts its edges to cells inside. Each prefix is a candidate when both sides are ≥ 0.4 × target and both are connected (BFS, only for candidates that beat the current best score).
  - Return the best candidate's two sides, or null.

- [ ] **Step 4: Run** the same command. Expected: PASS. Then run `npm run typecheck && npx oxlint src`; both should be clean.

- [ ] **Step 5: Commit** `feat(terrain): splitGroup cuts a cell graph at its necks`.

### Task 2: Wire into the terrain stage

**Files:**
- Modify: `src/stages/terrain/stage.ts`, adding the setting at about line 127, the `s` type at line 143, and the split after the separation loop at about line 222. The region loop at line 284 is unchanged apart from reading `minLevel` per piece.
- Test: `src/stages/terrain/stage.test.ts`
- Modify: `CLAUDE.md`, adding a `split.ts` bullet in the terrain list.

**Interfaces:**
- Consumes: `splitGroup(members, cells, target)` from Task 1. `Cell` satisfies `GraphCell`.

- [ ] **Step 1: Write the failing stage tests:**
  - `no land region is far over the region size`: with defaults (regionSize 20), every `flat`/`slope`/`hills` child's footprint area ≤ 1.5 × 20 ha × 1.5 (45 ha; cell granularity slack). Seeds 1–4.
  - `region size 100 leaves big regions whole`: the largest land region with `regionSize: 100` is larger than the largest with defaults (seed 1).
  - `touching flat pieces share an elevation`: for every pair of `flat` children that are `touching` (the existing helper), have the same `coastal`/`riverFlat` flags, and came from one group, `elevation` is equal. In practice: touching flats with equal flags must have `|Δelevation| ≤ FLAT_STEP` (existing invariant), and with defaults at least one touching same-type pair exists with Δ = 0. Seeds 1–4.
  - Add `{ regionSize: 5, cellSize: 250 }` and `{ regionSize: 100 }` to the existing extremes test's list.

- [ ] **Step 2: Run** `npx vitest run src/stages/terrain/stage.test.ts`. Expected: the first test FAILS (today's regions reach 80 ha).

- [ ] **Step 3: Implement.**
  - Add the setting and the `regionSize: number` field.
  - After the separation loop, replace `groups` with the split groups, carrying `minLevel` across:

    ```ts
    const target = s.regionSize * 1e4;
    const split: RegionGroup[] = [], splitMin: number[] = [];
    groups.forEach((g, gi) => {
      const pieces = g.kind === 'flat' || g.kind === 'slope' || g.kind === 'hills' ? splitGroup(g.cells, cells, target) : [g.cells];
      for (const p of pieces) { split.push({ ...g, cells: p }); splitMin.push(minLevel[gi]); }
    });
    ```

    Then use `split` and `splitMin` in the region loop. `levels` is per cell, so it needs no change.
  - Flat elevation: keep the average of `levels.flatLevel`. Cells of one group share a level, so the pieces agree. Confirm this with the test.

- [ ] **Step 4: Run** `npm run typecheck && npx oxlint src && npm test`. Expected: all pass.

- [ ] **Step 5: Visual check.** Run `npm run build`, wait for the service rebuild, then take a headless screenshot of the default city (the CLAUDE.md command). Region outlines should show the big areas divided at narrow points. Also log the per-kind region areas for seeds 1–4 and compare with the spec's "before" numbers.

- [ ] **Step 6: Docs.** Add a `split.ts` bullet to the terrain list in CLAUDE.md: big flat/slope/hills regions are cut at necks (spectral sweep, cut length / sqrt(smaller area)) while over 1.5 × `regionSize`, with pieces ≥ 0.4 ×; it runs after levels, so pieces of a flat share its level. Also update the stage.ts line ("merging … into regions") so it mentions the split.

- [ ] **Step 7: Commit** `feat(terrain): big regions are split at their necks`, then fast-forward merge to main and delete the branch.

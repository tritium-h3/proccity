# Arterials by Gateways Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hubs-and-mesh planning with a district graph: tree, no leaves, loops; gateways on
the chosen borders; through roads and border roads inside each district. No dead ends.

**Architecture:** Three new pure modules, each tested on synthetic input:
- `links.ts` chooses links over an abstract graph;
- `gateways.ts` places a point on a border polyline;
- `inside.ts` pairs a district's gateways.

`stage.ts` builds the graph from the tree, routes with the existing grid and `route`, then cuts
as today.

**Tech Stack:** TypeScript, Vitest, clipper2-ts via `grammar/clipper.ts`.

**Spec:** `docs/superpowers/specs/2026-11-23-arterial-gateways-design.md`

## Global Constraints

- No dead ends. Every developed district has at least two links, or is a counted leaf.
- Undeveloped districts have zero links, or two or more, never one.
- The spacing is the minimum distance between gateways on one district's perimeter.
- A border holds a gateway only if it's at least 2 × usableWidth + roadWidth long.
- Gateways sit at least usableWidth from a border's ends.
- New setting `borderRoads`, 0–1, step 0.05, default 0.3. The `spacing` key stays; its label
  becomes "Gateway spacing", range 500–5000.
- Arterials run in under 3 s at the 30 km defaults.
- Road ids come from a counter.

## Review Focus

- **A district with a concave footprint:** its centroid is outside it. Every "centre" must be a
  usable cell inside the district.
- **A shared border made of several pieces** (two districts touching in two places): the
  gateway goes on the longest piece.
- **A river link where the river has no reach between the two districts that a bridge can
  cross:** drop the link. It isn't required.
- **Exits on a site with sea on three sides:** fewer edges qualify. Place fewer exits rather
  than throw.
- **The 2 km `SMALL_SCALE` tests:** districts are about 250 m across, smaller than 2 × usable
  width. Thresholds derive from the settings, so the small-scale settings must still produce
  links.

---

### Task 1: `links.ts`, choosing links

**Interfaces:**
- Produces:
  ```ts
  chooseLinks(n: number, developed: boolean[], cands: { a: number; b: number; cost: number; kind: 'border' | 'river' | 'exit' }[], opts: { exits: number; redundancy: number; exitOrder?: number[] }): { chosen: number[]; tree: Set<number>; leaves: number[] }
  ```
  - `chosen` holds candidate indices.
  - Exits are candidates whose `b` is the outside node `n`.
  - `exitOrder` gives the order in which exit candidates are preferred (spread along the edge).

- [ ] **Tests (`links.test.ts`):**
  - a tree over a line graph is chosen;
  - a developed leaf gets its cheapest second link;
  - an Undeveloped node never ends with exactly one link;
  - Undeveloped leaves of the tree are dropped;
  - a higher redundancy chooses more links;
  - exactly `opts.exits` exits are chosen (or all there are);
  - the result is deterministic.
- [ ] Implement:
  - Kruskal over the border and river candidates;
  - prune Undeveloped degree-1 nodes repeatedly;
  - add exits in `exitOrder`;
  - no-leaves loop;
  - redundancy (`round(redundancy × remaining developed–developed candidates)`, cheapest first, through a `allowLoop(i)` callback in opts, used by the stage for spacing);
  - final Undeveloped fix-up.
- [ ] Commit.

### Task 2: `gateways.ts`, placing a gateway on a border

**Interfaces:**
- Produces:
  ```ts
  sharedBorder(a: MultiPolygon, b: MultiPolygon, tol: number): Point2[][]
  ```
  The polylines of boundary the two footprints share.
- Produces:
  ```ts
  placeOnBorder(line: Point2[], opts: { margin: number; score(p: Point2, normal: Point2): number; avoid: Point2[]; minGap: number }): { at: Point2; normal: Point2; crowded: boolean } | null
  ```
  - Samples along the line, keeping at least `margin` from both ends.
  - Prefers positions at least `minGap` from every `avoid` point, then the lowest score.
  - The normal is perpendicular to the local segment.

- [ ] **Tests:**
  - the shared border of two adjacent squares is their common edge;
  - placement keeps the margin from the ends;
  - placement avoids a nearby gateway;
  - with no room, `crowded` is true;
  - placement returns null on a line shorter than 2 × margin.
- [ ] Implement:
  - `sharedBorder` walks segments of `a` whose midpoints lie within `tol` of `b`'s boundary,
    chained into polylines;
  - `placeOnBorder` samples every `margin/4`.
- [ ] Commit.

### Task 3: `inside.ts`, pairing a district's gateways

**Interfaces:**
- Produces:
  ```ts
  pairGateways(gs: { at: Point2; perim: number }[], centre: Point2, perimeter: number, opts: { borderShare: number; eligible(i: number, j: number): boolean; rng(): number; star: boolean }): { through: [number, number][]; border: [number, number][]; tees: number[]; star: number[] }
  ```
  - `perim` is the gateway's position along the perimeter.
  - `tees` are gateways joining the nearest road.
  - `star` lists the gateways that meet at the centre (town centres, or a lone gateway).

- [ ] **Tests:**
  - 2 gateways give one pair;
  - 4 gateways at the compass points give two crossing pairs (N–S, E–W);
  - 3 gateways give one pair and one tee;
  - with `borderShare` 1 and all pairs eligible, neighbouring pairs become border roads;
  - with `star`, all gateways go to `star`;
  - 1 gateway goes to `star`.
- [ ] Implement:
  - first take border roads among eligible neighbouring pairs, by seeded share;
  - greedily pair the rest by how close the angle between them (seen from the centre) is to
    180°;
  - any leftover is a tee.
- [ ] Commit.

### Task 4: Stage rewrite

**Files:** `stage.ts` (rewrite of the planning steps), `stage.test.ts`, `hubs.ts` (keep
`placeExits` spreading if reused; delete `poissonHubs`), `mesh.ts` (delete) and their tests.

- [ ] **Settings:** the label and range for `spacing`; add `borderRoads`; keep the rest.
- [ ] **Graph:**
  - border candidates from touching district pairs whose `sharedBorder` longest piece is at
    least 2 × usableWidth + roadWidth;
  - river candidates from district pairs facing across the river (the closest bank points under
    3 river widths apart);
  - exit candidates for districts with land on the site edge;
  - cost = grid estimate (the existing `estimate`) between interior anchor cells through the
    candidate's gateway position.
- [ ] **Links and gateways:**
  - `chooseLinks`, with gateway placement as the spacing check (placing in the spec's order);
  - bridge gateways: the narrowest crossing between the two districts' banks;
  - exits: the existing exit placement, restricted to the chosen district's edge.
- [ ] **Inside each district:**
  - `pairGateways`;
  - route through roads gateway to gateway with a square stub at both ends (`straightStart`,
    then the reverse stub);
  - border roads are the border polyline between the two gateways;
  - tees are routed to `onRoad`;
  - star: routes to a central clear cell.
- [ ] **Chaining** at gateways where two roads meet head-on, then smoothing. Bridges: the bank
  gateways joined straight across.
- [ ] **Keep:** sliver loop removal (only if no leaf results), connectors, the cut, bridges,
  stats per the spec.
- [ ] **Tests:**
  - replace the dead-end, spur and hub tests with the spec's list (no dead ends, link degrees,
    gateway spacing, square crossings, no hairpins, Border roads 0 and 1, redundancy);
  - keep the rest green;
  - update `SMALL_SCALE.arterials` if needed so 2 km cities get links.
- [ ] Commit.

### Task 5: Docs and the look

- [ ] CLAUDE.md arterials bullet rewritten. Mark the old arterials spec's §3–4 as superseded by
  this spec.
- [ ] Screenshots: seeds 1–3 at Border roads 0, 0.3 and 1 (SVG), plus the app.
- [ ] Commit.

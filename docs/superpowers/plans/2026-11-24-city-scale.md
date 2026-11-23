# City Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 30 km default sites with the same structure as today. Layout sizes grow ×15. Every internal layout distance is derived from a setting. Arterials are drawn as geometry.

**Architecture:** Settings defaults and ranges change. Each stage derives its internal distances from its settings (terrain from `cellSize`, `riverWidth` and site size; districts from `districtSize`; arterials from `spacing`, the grid cell, `usableWidth` and `curveRadius`). The renderer scales cosmetic noise with the site and drapes arterial ribbons over a sampled height raster.

**Spec:** `docs/superpowers/specs/2026-11-24-city-scale-design.md`

## Global Constraints

- Site default 30,000 m; the Site size slider runs 5,000–60,000 m in steps of 1,000.
- **Terrain:**

  | Setting | Default | Range |
  |---|---|---|
  | `cellSize` | 1,800 | 900–3,750, step 150 |
  | `regionSize` | 4,500 ha | 1,000–22,500, step 500 |
  | `pondSize` | 900 ha | 100–2,250, step 50 |
  | `relief` | 600 m | 100–1,600, step 50 |
  | `riverWidth` | 150 m | 40–450, step 10 |

- **Districts:** `districtSize` 1,800 ha, 450–6,750, step 150.
- **Arterials:**

  | Setting | Default | Range |
  |---|---|---|
  | `spacing` | 2,000 | 1,000–5,000, step 100 |
  | `usableWidth` | 300 | 100–800, step 50 |
  | `curveRadius` | 150 | 50–500, step 10 |

  `roadWidth`, `maxGrade`, `junctionAngle`, `exits` and `redundancy` are unchanged.
- **Physical, unscaled:** road width, max grade, vertical tolerances (`FLAT_STEP`, decimation, cosmetic budget, depths), the 50 m wide-patch inset, and `TOUCH`.
- **Arterial routing grid cell** = spacing / 20.

## Review Focus

- **Old 2 km saves:** load and render unchanged, without regenerating. Settings live in the doc, so the defaults don't apply to them.
- **A small site (5 km) at the new defaults:** cell size 1,800 m gives few cells. Terrain must still work, with fewer, bigger regions, and not throw.
- **Rendering at 30 km:** the camera frames the site, fog and shadows cover it, and there's no z-fighting of ribbons with the ground.

---

### Task 1: Site and terrain at scale

**Files:**
- `src/doc/create.ts`, `src/editor/StagePanel.tsx`
- `src/stages/terrain/stage.ts`, `water.ts`, `elevation.ts`
- Terrain tests: `stage.test.ts`, `rules.test.ts` and `elevation.test.ts` if they use site sizes

- [ ] **Update the defaults and ranges.** Express these internal constants relative to a setting:

  | Constant | Becomes |
  |---|---|
  | river cap reach `riverWidth/2 + 55` | `riverWidth/2 + 0.45·cellSize` |
  | course thinning and river bed points, 25 | `cellSize/5` |
  | coast shelf offset, 10 | `cellSize/12` |
  | sea bed points, 90 | `0.75·cellSize` |
  | pond inset bed (4, 16) | (`cellSize/30`, `cellSize/7.5`) |
  | elevation sigma floor, 30 | `cellSize/4` |
  | water: coast step 20, extents 50/100 | `size/100`, `size/40`, `size/20` |
  | water: river simplify, 0.5 | `size/4000` |

- [ ] **Tests:** helpers default to 30,000; explicit sizes ×15 (500 → 7,500, 5,000 → 75,000; if the 75 km run is too slow, use 60,000, the slider maximum). Add `keeps the same structure at 30 km as the old 2 km defaults`. With all-old settings at 2,000 versus new defaults at 30,000, the stats counts (cells, regions per kind, stored triangles) agree within ±25%.
- [ ] Run `npm test` on terrain; pass. Commit `feat(scale): 30 km sites; terrain distances from its settings`.

### Task 2: Districts at scale

**Files:** `src/stages/districts/stage.ts`, `fill.ts`; tests.

- [ ] `districtSize` default and range.
- [ ] `unit = sqrt(districtSize·1e4) / 283` (1 at 8 ha).
  - `NEAR` = 300·unit, `EDGE` = 200·unit.
  - `FillInput` gains `unit`. `stepFor` = (200 + 500g)·unit, `MINOR_SPACING` = 600·unit, `RURAL_REACH` = 500·unit.
- [ ] Tests at 30 km. The fill unit tests pass `unit: 1`.
- [ ] Commit `feat(scale): districts' distances from district size`.

### Task 3: Arterials at scale

**Files:** `src/stages/arterials/*.ts`; tests.

- [ ] Settings defaults and ranges.
- [ ] Grid cell = spacing/20. The Grid stores `band` (= 2 cells), `edgeScale` (= half the district width, from the mean district area) and `bankBand` (= roadWidth/2 + cell/2). `markRoad(g, line, reach)` takes reach = 1.1 × usableWidth. The river normal reach = 4 cells.
- [ ] Derived constants:

  | Constant | Becomes |
  |---|---|
  | `NUDGE` | 3 cells |
  | smooth simplify | 0.6 cell (passed in) |
  | `ARC_STEP` | radius/6 |
  | `EXIT_GAP` | spacing/5 |
  | `EXIT_SLIDE` | 3 cells |
  | hub edge margin | spacing/5 |

- [ ] Fix the edge test (stage test "keeps off the site edge"): spur goal cells exclude cells on the site edge.
- [ ] Tests at 30 km. Unit tests keep their synthetic grids, passing explicit parameters.
- [ ] Timing: stage `ms` at the 30 km defaults is under 3,000. If not, profile.
- [ ] Commit `feat(scale): arterials at 2 km spacing`.

### Task 4: Rendering at scale

**Files:** `src/scene/cityScene.ts`, `renderers/terrain.ts`, `renderers/arterials.ts`, a new `scene/heightSampler.ts` (pure) with a test.

- [ ] **Camera:** `controls.maxDistance = 4.5·size`, `minDistance = size/1000`. Check the shadow camera bounds and resolution against the site size.
- [ ] **Terrain shader:** the colour-jitter, misc and bump noise frequencies are divided by `size/2000`. So is the water bump.
- [ ] **`heightSampler(surfaces, bounds, cell)`:** a bilinear sampler over the terrain surfaces, rasterised. Test: on a plane it matches to within 1e-6.
- [ ] **Arterial ribbons from `data.roads`:**
  - resample every 20 m, offset ±roadWidth/2 along the normal;
  - y = sampled height + 1.5, a polygon offset, asphalt colour;
  - remove roads from the tint texture (superblocks only, px 1024).
  - Count the triangles: about 2 per 20 m of road. Log them in dev builds.
- [ ] Build, then take screenshots: districts and arterials at 30 km in the app.
- [ ] Docs: CLAUDE.md (scale facts, settings, the polygon budget line), the README if it mentions sizes.
- [ ] Commit `feat(scale): rendering at 30 km; arterials as draped ribbons`.

Then the final review, the owner's spurs and loops question looked at again at the new scale, and the merge.

# City scale: 30 km sites

## Why

Seeing 25 m arterials on the default city showed the owner that the geography is far smaller
than they'd pictured. A 2 km site is a small town, and its 250 m districts are a couple of city
blocks. The owner: "We HAVE to scale stuff up." The structure, though (how many cells,
regions, districts, and triangles there are, and how it looks), "looks perfect for a city
area", so only the **measurements** grow, not the generation.

## Decisions (the owner's)

- **Layout sizes ×15.**
  - The site goes from 2 km to **30 km**.
  - Terrain cells go from 120 m to 1.8 km.
  - The default region size goes from 20 ha to 4,500 ha.
  - The default district size goes from 8 ha to 1,800 ha.
  - Pond size goes from 4 ha to 900 ha.
- **Relief is about 600 m**, not ×15. That's hilly, not alpine.
- **Physical widths:**
  - Road width stays 25 m.
  - River width becomes about 150 m.
- **Arterials are about 2 km apart.** Anything coarser is a highway, and highways are out of
  scope.

## Goals

- At the new defaults, the counts match today's: terrain cells, regions, districts and
  terrain triangles. Generation time stays similar for terrain and districts. Arterials get
  denser, since 2 km spacing across 30 km gives about 15×15 hubs where today has about 3×3.
- Every distance a stage uses is either a setting with a scaled default, or derived from one
  (cell size, district size, spacing). Nothing layout-related stays hard-coded in metres.
- Physical quantities don't scale: road width, max grade, the junction angle, and vertical
  tolerances (the 2 m flat step, the decimation tolerances). The cosmetic curve was meant to
  stay too, but at 1.8 km triangles a 1.25 m curve looked faceted, so it scales with
  √(site/2 km), about 4.8 m at 30 km. The owner approved the look, and outlines drape on the
  drawn ground to match.

## Non-goals

- Highways and regional routes.
- Any change to how stages generate, beyond the units of their constants.
- Converting saved cities. A saved city keeps its own site size and settings, and old 2 km
  cities still load.

## Design

- **Site:** `DEFAULT_SITE_SIZE` becomes 30,000. The Site size slider runs from 5 to 60 km in
  steps of 1 km.
- **Terrain settings** (default and range scaled together):

  | Setting | Default | Range |
  |---|---|---|
  | `cellSize` | 1,800 m | 900–3,750 |
  | `regionSize` | 4,500 ha | 1,000–22,500 |
  | `pondSize` | 900 ha | 100–2,250 |
  | `relief` | 600 m | 100–1,600 |
  | `riverWidth` | 150 m | 40–450 |

  `flatWidth` is counted in cells, so it's unchanged.
- **Terrain internals:** constants in metres either become relative to the cell size or the
  river width, or are confirmed vertical, case by case. For example, the river cap's
  `riverWidth/2 + 55` and "course points about every 25 m".
- **District settings:** `districtSize` defaults to 1,800 ha, range 450–6,750. The internal
  distances (main-centre neighbourhood and edge margin, minor-centre spacing, Rural reach,
  the fill's density step) become multiples of the district size or spacing. The "wide patch"
  test (over about 100 m across) stays physical: it's a park width.
- **Arterial settings:**

  | Setting | Default | Range |
  |---|---|---|
  | `spacing` | 2,000 m | 1,000–5,000 |
  | `usableWidth` | 300 m | 100–800 |
  | `curveRadius` | 150 m | 50–500 |

  The curve radius is physical, but real arterials curve wider than 60 m. Road width, Max
  grade, Junction angle, Exits and Redundancy are unchanged.
- **Arterial internals:**
  - The routing grid cell is about spacing ÷ 35 (about 60 m at the default), so routing cost
    stays similar.
  - The border band, district-edge scale, road reach, river reach, exit gap and slide, nudge
    and simplification derive from the grid cell, spacing or district size.
- **Rendering:**
  - At 30 km a 25 m road is under 2 pixels in a baked texture, so **arterials become
    geometry**: draped ribbons following the ground, with bridge decks as now. It's a few
    thousand triangles; check them against the budget.
  - District colours stay baked; districts are kilometres across.
  - The camera's near and far planes, fog, controls' distance limits and shadow camera all
    follow the site size. Shader noise frequencies are reviewed so close-up detail still
    reads.
- **Tests:** helpers move to 30 km sites with the new defaults. The counts test compares
  cells, regions, districts and triangles against today's figures.

## Folded in from the arterials review (same branch)

These were already partly done before the scale change:
- the site-edge corridor fix, done through `skipSegment`;
- banks repel parallel roads, and only real crossings become bridges;
- rasterised kinds and surfaces, and reused routing buffers;
- exits leave square-on;
- Undeveloped districts need no spur;
- hubs keep away from the site edge.

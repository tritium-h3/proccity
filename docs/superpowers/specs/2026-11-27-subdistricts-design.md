# Sub-districts — design

Stage 4 of the shape grammar, between **arterials** and **blocks** (blocks becomes stage 5).
Agreed with the owner on 2026-11-27, after the blocks stage made the city look like a
city-centre density everywhere.

## Why

Every district is typed whole and built out evenly, so a 600 ha Low urban district has the
same 0.9 ha blocks edge to edge, and the dense types (40–55% of developed land) all look like a
downtown. The owner wants **gradients**: density that spreads out across an area rather than
staying level and dropping off sharply at a district edge. A step at an edge is fine, even
good ("a nice, human look"), as long as it isn't all the way. As density falls, **open land
appears**: big lots, then across the street nothing, and from above, larger and larger patches
of undeveloped land as the city thins.

## Goals

- Each developed superblock is cut into **sub-districts**, each with a **density level** within
  its district's type, or **Undeveloped**.
- Levels come from an **implied density field** read off the finished district map, so a
  district next to a denser one is denser on that side, and one next to wild land thins
  towards it.
- Level counts per type: **Financial 2** (so there's a deep downtown), **Urban 3, Low urban 3,
  Suburban 3, Town core 2, Town business 2, Rural 1**. Levels of neighbouring types
  **overlap**, so a district border is a partial step.
- Undeveloped sub-districts: more likely where the field is low, and **more in sparser types**.
- A level sets **spacing**: block size and collector spacing now. **Lot size** (future lots
  stage) will combine the zone and the density; the specifics are for that stage. **Building
  height, size and use stay with the zone.** A denser sub-district has the same kinds of
  buildings, closer together.
- Sub-districts have **codes and names**: the type's letter plus the density step (**F9**),
  and the type plus a level word (**Financial High**). See *Codes and names*.
- A **collector runs along every border between developed sub-districts** (as along district
  borders today). Where a developed sub-district meets an **Undeveloped sub-district**: a
  collector in the dense types (Town core, Town business, Low urban, Urban, Financial), a rough
  edge in Suburban and Rural.
- **Levels are pinnable** (Undeveloped included), and a pin doesn't reroll the rest.
- Its own stage, so editing a district type re-runs it and the city readjusts, as now.

## Non-goals

- **No core-to-edge gradient and no rings.** The owner specifically doesn't want a city that
  falls off from one centre. Density comes from the neighbouring districts only.
- Districts and their behaviour are unchanged: Undeveloped *districts* still meet blocks with
  a rough edge in every type.
- Arterials are unchanged and don't look at density. The owner doesn't want high traffic run
  straight into the densest places.
- Zone choice doesn't depend on level (the zone tables are unchanged).
- The lots stage isn't built here; only the level it will read.
- Parks: an Undeveloped sub-district is simply empty land, not a designed park.

## Anti-goals (a failure even if it works)

- Districts that still look uniform inside.
- Jumps from the densest to the sparsest across one street everywhere.
- Undeveloped land that leaves developed blocks without a road, or roads dead-ending into it.
- Pinning one sub-district's level reshuffling the others.

## Approaches considered

1. **Sub-district regions after arterials (chosen).** Arterials already divide districts into
   superblocks; sub-districts divide superblocks, and blocks divide sub-districts. Arterials
   stay untouched.
2. **Sub-district regions before arterials.** Rejected: arterials plan over district leaves
   (gateways on district borders), so they'd have to look past their leaves. Real rework, no
   gain, since arterials ignore density anyway.
3. **No regions: blocks read a smooth density field directly.** Truly gradual, but nothing to
   see or pin, and the owner asked for categories.
4. **A centre-out gradient** (density falls with distance from the main centre, Undeveloped
   pushed to a fringe). Rejected by the owner.

At a seam between sub-districts inside a superblock: **a collector along the border (chosen)**,
or the density change running through blocks with no street marking it. The owner could go
either way and took the collector, since that's how neighbourhoods tend to change.

## Design

### The density ladder

One shared scale of **density steps, 1 (sparsest) to 9 (densest)**. Each type covers a
contiguous range, and **level 1 is the densest step of its range** (the owner's "Low-Urban-1"
is the dense one):

| Type | Steps | Levels |
|---|---|---|
| Rural | 1 | 1 |
| Suburban | 2–4 | 3 |
| Town core | 4–5 | 2 |
| Town business | 5–6 | 2 |
| Low urban | 5–7 | 3 |
| Urban | 6–8 | 3 |
| Financial | 8–9 | 2 |

### Codes and names

- **Code:** the type's letter plus the step: R Rural, S Suburban, T Town core, B Town business,
  L Low urban, U Urban, F Financial. The number means the same in every type (U7 and L7 are
  equally dense), but only the type's own steps are valid. **0 is Undeveloped**: U0 is an
  Undeveloped sub-district in an Urban district. Letter-then-digit can't be mistaken for a zone
  code (LR, UCO).
- **Name:** the type plus a level word. Three levels: High, Mid, Low (Urban High = U8). Two:
  High, Low (Financial High = F9, Financial Low = F8). One level: the type alone (Rural = R1).
  Undeveloped sub-districts are named "Undeveloped".
- Letters and words were proposed by Claude; the owner set the pattern (Financial High, F9).

Types next in rank overlap or touch, so crossing such a border costs one step or none. (Not
every pair the districts' neighbour table allows: Rural may border Town core or Town business,
3–4 steps apart. The owner's table, so left as is.) The table lives in the stage's `rules.ts` as the source of truth;
the step numbers are a starting point for the owner's eyes.

### The implied density field

- A raster over the site (cell = site/200). Each land cell takes its district's **nominal
  density**, the middle of its type's range (Rural 1, Suburban 3, Town core 4.5, …). Undeveloped
  districts count as **0**.
- Blurred with a Gaussian of σ = 0.5 × √(district size) (about 1.2 km at the 600 ha default),
  **normalised over land**: water and off-site cells carry no weight, so a waterfront or the site
  edge doesn't thin the city. (A builder's call, flagged for the owner: water counting as 0
  would make shores sparse.)
- Plus smooth noise: wavelength √(district size), amplitude the **Variation** setting
  (default ±1 step), so same-type surroundings don't all come out the same level.
- A sub-district's value is the field's mean over its footprint, rounded to a step and clamped
  into its type's range. That gives its level.

### Cutting superblocks

- A developed superblock larger than 1.5 × **Sub-district size** (default **150 ha**; measured
  superblocks run 0–875 ha, median ~100) is cut into round(area / size) pieces with the
  districts stage's seeded, Lloyd-relaxed Voronoi (`districts/cut.ts`, reused, not copied).
  Smaller superblocks are one sub-district. Undeveloped superblocks get none.
- Node kind `subdistrict`, ids `…/superblock:k/sub:n`. Attrs: `code` (`'F9'`, `'U0'`) and
  `step` (0–9; 0 is Undeveloped). Type stays inherited from the district.

### Undeveloped sub-districts

- Each sub-district draws once from its own stream, in id order (so a pin never shifts other
  draws). It's Undeveloped with probability
  `open[type] × (1 − f / 9) × Open land`, where f is its field value and **Open land** is a
  setting (0–2, default 1).
- `open[type]` (starting values): Rural 0.5, Suburban 0.35, Town core 0.15, Town business 0.1,
  Low urban 0.1, Urban 0.08, Financial 0. (Financial never: holes in the downtown read as
  vacant lots. A builder's call, flagged for the owner.)
- **Connectivity:** every developed sub-district must reach an arterial through developed
  sub-districts (each border between them carries a collector). Undeveloped picks are taken in
  draw order and **refused** when they would cut a developed sub-district off. Counted
  (`openRefused`).
- A superblock may end up all Undeveloped; a district may not (at least one developed
  sub-district per developed district: refuse the last pick).

### Pins

`overridable.subdistrict.step`, a choice of 0–9, shown as the code and name for the region's
type. `validateOverride` refuses a step outside the type's range (0 is always valid, Financial
included: the owner's pin beats the generator's rule). A pin holds even when it disconnects a neighbour; the
cut-off sub-district stays developed, its blocks counted as `roadless` by the blocks stage.
Overrides re-attach by anchor point as for every stage.

### What blocks changes

- Leaves are now **developed sub-districts** (`step > 0`), not superblocks.
- **Edges** (`edges.ts`, `stage.ts` phase 1), by what lies beyond:
  - arterial: `A` (unchanged);
  - another developed sub-district (same district or not): `border`, half a collector each side,
    recorded once (generalises today's district-border rule);
  - an Undeveloped sub-district: in the dense family, a collector **wholly on this side**
    (`edge`; there's no block stage on the other side to take half); in the sparse family, `open`;
  - an Undeveloped district, water, the site edge: `open` (unchanged).
- **Spacing by step:** block depth, block length and collector spacing are interpolated
  geometrically between a **densest** (step 9) and **sparsest** (step 1) setting. These
  replace the dense/sparse depth, length and collector settings:
  - densest: depth 70 m, length 160 m, collectors 400 m (today's dense values);
  - sparsest: depth 150 m, length 500 m, collectors 900 m.

  The family (dense or sparse) still decides how cuts follow the terrain (plan direction vs
  contours), as now.
- **Minimum block size by step (interim):** the smallest lot of the type scales by a factor per
  step, 1 at step 9 rising to 2 at step 1 (each side). The lots stage will define lot size from
  zone and density properly and may replace this.

### Rendering

`scene/renderers/subdistricts.ts`: like arterials, superblocks tinted with their district's
colour, lighter as the level falls, Undeveloped sub-districts in the Undeveloped colour, plus the
arterial ribbons. No triangles (tinted, `renderers/tint.ts`). The blocks renderer draws
Undeveloped sub-districts as Undeveloped land.

### Stats

Site data `subdistrictStats` (its own key, as `blockStats`): sub-districts, undeveloped (count
and ha), ha per code, `openRefused`. The Inspector shows a sub-district's code and name.

### Saved cities

Inserting a stage shifts stage indices, and `generatedThrough` is an index. A saved city that
was generated through blocks (old index 3) must still load and show its stored tree, and any
regeneration at or after arterials must run sub-districts before blocks (blocks can't divide
superblocks any more). Mechanism left to the builder (e.g. `normalize.ts` maps an old index by
stage id; a tree with blocks but no sub-districts regenerates from sub-districts).

## Left to the builder

- Exact noise function and blur implementation (separable Gaussian on the raster is fine).
- Interpolation details of the spacing settings; settings' slider ranges.
- Whether the sub-district cut snaps borders to anything (straight Voronoi borders are fine).
- Test layout, following the blocks stage's (pure modules: ladder, field, cut, assignment).

## Open, for the owner's eyes once rendered

- The ladder steps, `open[type]` and the sparsest spacing numbers.
- Whether water should count as low density.

## As built (2026-11-27)

- **Steps are centred on each district.** A piece's step is
  `nominal(type) + 1.5 × (its field − its district's mean field)`, rounded into the type's range.
  On the raw field the densest type never reached its top level (its neighbours are always
  sparser, so its pieces all rounded down: no F9 anywhere, Town core always T4). Centring keeps
  the side towards a denser neighbour denser and lets every level appear. The chance of open land
  still uses the raw field. Gain 1.5 measured: every level shows, middle levels stay common.
- The blur's scale comes from the districts' mean area (another stage's settings aren't visible
  to a stage); equal to the District size setting at the defaults.
- Saved cities from before the stage load **stepped back to arterials** (their blocks divided
  superblocks); Next builds sub-districts, then blocks. `editor/normalize.ts`.
- Shared border streets now keep the road id they were first recorded under on both sides.

Numbers at 10 km, seeds 1–3:

| | seed 1 | seed 2 | seed 3 |
|---|---|---|---|
| sub-districts | 55 | 51 | 54 |
| Undeveloped (count, ha) | 10, 940 | 7, 1,088 | 7, 437 |
| open picks refused | 0 | 0 | 0 |
| blocks (before: ~2,500–3,900) | 1,857 | 1,465 | 2,193 |
| edge collectors | 5 | 3 | 1 |
| roadless | 0 | 0 | 0 |

The stage takes about 120 ms; blocks 1.5–2.2 s.

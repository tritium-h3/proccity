# Lots — design

Stage 6 of the shape grammar, after **blocks**. Agreed with the owner on 2026-11-27. Lot
sectioning (house, yard, driveway, …) and buildings come later.

## Why

Blocks are zoned but empty. Lots are the unit buildings will stand on: their size gives a zone
its grain (a row of narrow townhouse lots against one strip-mall lot), and the roads along their
sides will shape each building's faces.

## Goals

- Every zoned block is divided into **lots**; the lots and any open ground partition the block.
- **Lot size comes from zone and density step together**: within a zone, a denser step gives
  narrower frontage **and** shallower depth.
- Lots come from **subdivision at a coarseness set by lot size**, and the cuts know where the
  street is: the first cut runs along the block's spine (separating back-to-back rows) where the
  block is deep enough for two rows; then cuts run square to the frontage road, spaced by the
  target frontage.
- **Big-lot zones are often one lot per block** (UO towers, MC strip malls): their target is about
  a block, so most such blocks aren't cut and an unusually big one splits in two or three.
- **A lot faces one or more roads, of any categories** (a tower facing four collectors; a house
  backing onto an arterial). Each lot records every side's road category (or open land). At least
  one face must be on a road its zone allows (the owner's facing table); others may be anything.
- **Lots stretch to the block's middle**; where that would make them more than **twice their
  target depth**, the middle is left as **open ground** (a region of its own).
- Tinted into the ground like blocks: lots read individually; no triangles.

## Non-goals

- Flag lots (rear lots with an access strip): common (the owner has them on their own street), but they'd
  complicate lot sectioning and buildings. Open ground takes their place.
- Buildings, lot sectioning, fences: later stages read the lots' faces.
- Pins on lots (sizes come from settings; a block's zone pin already exists).
- What the open ground is (yard, parking, common): later.

## Anti-goals

- A lot with no allowed road frontage.
- Slivers and wedges: lots meet the same squareness and minimum-size standards as blocks.
- Lots cut diagonally to their street.

## Approaches considered

- **A. Plain recursive splitting** (longest side until lot size, keeping cuts that leave both
  halves on a road). Simplest, but lot lines ignore the street: diagonals and corner wedges.
- **B. Strips along each street, cut across.** The most regular, but corners need a straight
  skeleton (who owns the corner), which we don't have, and odd blocks get messy.
- **C. Street-aware recursive splitting (chosen).** A spine cut where deep enough, then cuts
  square to the frontage road at the target frontage, each leaving every piece on an allowed road.
  Corners become corner lots facing two roads. Reuses the blocks stage's geometry (square ends,
  minimum sizes, squareness).
- For the middle of deep blocks: (a) stretch lots, (b) flag lots, (c) open ground. The owner chose
  (a), then (c) where (a) is problematic.

## Design

### Lot sizes

A target **frontage × depth** per zone at density step 9, scaled on both sides by the existing
`lotFactor(step)` (1 at step 9, 2 at step 1; `subdistricts/rules.ts`). Starting values (Claude's
call, for the owner's eyes):

| zones | at step 9 | Suburban High (4) | Suburban Low (2) | note |
|---|---|---|---|---|
| LR | 12 × 24 m | 18 × 37 | 22 × 44 | single-family |
| LC, LO | 20 × 30 m | 31 × 46 | 37 × 55 | ample parking |
| HR, HC, HO, HCR, HCO | 7 × 20 m | (Town, steps 4–6: 9–11 × 26–31) | | townhouses, shopfronts |
| MR, MCR | 25 × 30 m | (Low urban, 5–7: 29–35 × 35–42) | | apartment blocks |
| UR, UCR | 30 × 30 m | (Urban, 6–8: 33–39) | | residential towers |
| MC, MO, UO, UCO, UCOR | **a block** | | | big-lot: the step's block depth × length |

The table lives in `stages/lots/rules.ts` and replaces the blocks stage's provisional `MIN_LOT`:
`smallestLot` (a block holds at least one lot) reads the same table, so the two stages agree.
A setting **Lot size** (×0.5–2, default 1) scales every target.

### Cutting (approach C)

Per block, with T = its zone's target (frontage f, depth d):

1. **Open ground.** If the block's depth (rectangle width from area and outline, as blocks'
   `rectWidth`) exceeds 2 × 2d, the inset of the block by 2d becomes **open ground**
   (`kind: 'open'`); lots are cut from the ring left. A sliver of open ground (under one target
   lot) joins the lots instead.
2. **Spine cut.** If the piece is deeper than 2 × 1.4 × d (room for two rows), cut along its long
   axis through the middle, so each side keeps its frontage.
3. **Frontage cuts.** While a piece's frontage (its run along allowed roads) exceeds 1.4 × f, cut
   square to that road at a multiple of f from one end (positions like blocks' `plans`: whole
   numbers of targets).
4. **Accept a cut** only if both pieces keep a face on an allowed road, meet the minimum lot
   (0.5 × target area, depth ≥ 0.5 d), and pass blocks' squareness test (a final lot fills 70% of
   its box, or no worse than its parent). Corner pieces face two roads: their frontage is the
   longer allowed run.
5. Largest piece first; a piece with no acceptable cut is a lot.

Big-lot zones: target = block size, so step 3 rarely fires.

Lot lines are straight (no field tracing): lots are small, and square to the street matters more
than following contours.

### Faces

Each lot records its sides: attr `faces` (the set of categories it touches, as blocks have) and
`edges`, one character per outline edge in ring order: `A`, `C`, `L` (a road), `o` (open land:
water, Undeveloped, site edge, open ground), `-` (another lot). Front: attr `front`, the allowed
category of its longest allowed run. Road lookup reuses the blocks stage's `RoadIndex`, built from
`data.roads` and `data.streets`.

### Tree

Children of each zoned block: `lot:n` (kind `lot`) and at most one `open:0` (kind `open`). Unzoned
blocks get none. Zone and district are inherited (`resolveAttr`). Site data `lotStats`: lots,
per-zone counts, open ground ha, refused cuts.

### Rendering

`scene/renderers/lots.ts`: the blocks view's tint, with each lot's zone colour jittered in
lightness (±6%, stable per lot id) so lots read individually, open ground a muted green, plus
streets and arterial ribbons as blocks. Texture 4096 px (2.4 m a pixel at 10 km: a 9 m lot is 4
pixels). No triangles.

## Open: document size (the owner's call)

About **55,000 lots** in a 10 km city (estimated from block areas; most are High-density zones'
narrow lots). At ~300 bytes a lot in the stored tree, a saved city grows from ~2 MB to roughly
**15–20 MB**; a 30 km city (~9×) to **150 MB+**, which IndexedDB autosave and the worker hand-off
won't carry comfortably. Options:

1. **Store lots as resolved geometry, like every stage** (the foundation's rule: a saved city never
   needs the generator). Fine at 10 km; at 30 km the lots stage may be too heavy to use.
2. **Store lots compactly**: coordinates rounded to 0.1 m and short ids, maybe half the size.
   Still resolved; same scaling problem, later.
3. **Store per block only how it was cut** (cut lines), and resolve lots on load: small, but breaks
   the resolved-geometry rule.

**Decided (owner, 2026-11-27): 1 for now.** "Save size is very big! I feel like we could do more
for less, but maybe that's a question for future us." Parked, not solved.

## Left to the builder

- Exact frontage-run computation and how corner lots pick their front.
- Test layout, following blocks (pure modules: rules, cutting, faces).

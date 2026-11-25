# Arterial loops: only through several districts

Status: agreed with the owner 2026-11-24 (in conversation); small change to the arterials stage
(`2026-11-23-arterial-gateways-design.md`).

## Why

After the small-ring fix the owner still saw loops closed by one or two districts' own roads,
and two arterials running side by side from one gateway. Their rules:

- "I'm not thrilled when we get two arterials running parallel, even if they don't make a short
  circuit."
- "I would prefer it if we only have loops that go through several districts, rather than size":
  **at least 3 districts**. "I don't want rings around a single district border."

## Goals

- Every enclosed loop of the arterial network spans **at least 3 districts**, judged by the
  districts it encloses, not by its size.
- No two arterials leave the same gateway into the same district.
- No dead ends, still (that rule wins: a loop that can't be opened without one stays, counted).

## Non-goals

- No limit on loop size. A 300 m loop through three districts is fine.
- Redundancy, exits, the tree and gateway placement are unchanged.
- Parallel roads that never meet (no loop and no shared gateway) aren't searched for here.

## What "spans a district" means

A loop is a hole in the union of the road bands (as the ring probes measured). It spans a
district when, inside the loop, part of that district still remains after an inward offset of
half the Usable width. In other words, the loop takes in a usable piece of the district, not just
the strip a road strays into (roads may run a Usable width outside their district).

## Changes

1. **Fork, not twin.** A district's gateways can coincide (two links meeting at one border
   point). A gateway already used by a road in that district isn't used again: the other
   gateway of that pair is routed as a tee to the nearest road (as tees are), so the road forks
   from the first instead of running beside it.
2. **No self-crossing routes.** A route that crosses itself is rejected like a looping one
   (more than 270°), and the next, freer try is taken. Two rings in the probes were one road
   crossing itself.
3. **Open the local loops.** After joins and before connectors, each loop spanning fewer
   than 3 districts is opened by removing one **piece** of road: the stretch of a road between
   two junctions, along the loop's edge. This merges the loop with the area beside it. That's
   repeated until no such loop has a removable piece.
   - **Order:** a join first, then a tee, connector, star spoke, border road, direct, and a
     through road last. Shorter pieces go first within a kind.
   - **Never removed:** a piece of a bridge, or a piece touching the site edge (an exit).
   - **Refused** if it leaves a dead end or splits the network.
   - A road with a piece removed becomes two roads, each ending at the junction.
   - Loops left over are counted in the stats (`localLoops`).

## Approaches considered

- **A minimum loop size (rejected by the owner):** size isn't the point; a large loop around
  one border is just as unwanted.
- **Prevent each loop at its source only:** fixes like the tee and join rules catch
  particular patterns, but the probes found loops from many combinations (border road +
  through road, a neighbour's road straying in, tees). A general check after laying catches
  them all; the source fixes (1, 2) stay because they give better shapes than removal.
- **Remove whole roads instead of pieces:** a through road often borders a loop for only a
  short stretch. Removing all of it left gateways unserved.
- **At least 2 districts:** Claude's first suggestion; the owner chose 3, so loops around a
  single district border go too.

## Left to the builder

The junction tolerance (a road width, as `meets`), the ordering ties, and the piece search.

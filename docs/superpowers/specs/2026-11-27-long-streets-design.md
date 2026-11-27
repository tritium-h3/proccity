# Long streets — design

A change to the blocks stage, agreed with the owner on 2026-11-27.

## Why

Each cut divides one piece and stops at the first road it meets, and the two halves of a piece
are then cut independently, so their cross streets rarely line up. Streets are short (median
220–260 m at 10 km) and end in T-junctions offset by half a block from the street opposite: a
brick pattern (about as many staggered pairs of local road ends as aligned ones).

The owner wants **streets to continue as long as they can**, across earlier cuts and across
sub-districts: "Maple Street" a rural route at the outskirts and a boulevard downtown (Boston's
Washington Street is the reference).

**The principle, made explicit:** a road carries on as far as it can, and **the bigger the road,
the wider the spacing of the junctions along it**. Arterials are met rarely, collectors about
once a block length, local roads may branch freely. The two go together: one street crossing a
road square is one junction where two staggered ones are two.

## Goals

- A cut that meets a collector or local road **continues across it** into the piece beyond,
  and on through further pieces while each accepts it, including pieces of **other
  sub-districts** (the border collectors are crossed like any other).
- Pieces at different stages of division and in different sub-districts accept a continuation
  under **their own rules** (their step's sizes, family, field, lot size, squareness, grade).
- **Junction spacing by category**, along every road the blocks stage can join: a new junction
  within the minimum spacing of an existing one on the same road is penalised; landing **on** an
  existing junction (a crossing) adds none and costs nothing.
- A continued street is one **route**: its segments share a route id (the seam for street names
  and for character changing along a street later).
- Fewer staggered T pairs and longer routes, measured (baseline above).

## Non-goals

- Street names (the owner's "Maple Street" is an example; naming is a later idea, parked).
- A street's width or look changing along it (boulevard downtown): the route id is the seam; the
  renderer still draws by category.
- Arterials: unchanged, and still never cut by the blocks stage.
- Laying a street network first (rejected, below).

## Anti-goals

- Long streets bought with big blocks: continuation must not leave more land in oversized
  blocks than today (0–4% of developed land in blocks over 20 ha).
- Local roads crossing arterials.
- A long straight street ignoring the terrain: a continuation follows each piece's own field
  (contours in sparse pieces).

## Approaches considered

- **A. Lines that carry on (chosen).** When a cut is made, each end that meets a collector or
  local road tries to continue into the piece beyond; the recursive division is otherwise
  unchanged. Long streets from the method we have.
- **B. Aim for existing ends.** Score a cut better when its end meets the road opposite an
  existing street end. Cheaper, but streets only pair up: crossroads, not long streets. The
  owner leaned this way first, then chose A. (Its effect survives inside A: landing on an
  existing junction costs nothing, and near misses are penalised.)
- **C. Street network first.** Long lines across each sub-district, blocks derived after. The
  cleanest long streets, but a rewrite of a stage the owner says looks almost as envisioned.

## Design

### One queue for the whole site

Today each sub-district is divided alone. Continuation crosses sub-districts, so the division
runs as **one queue of pieces for the whole site**, largest first, each piece carrying its own
context (sub-district id, step, family, field, smallest lot, open land). Output is grouped back
by sub-district (children ids unchanged: `collector:n`, `local:n`, `block:n` per sub-district).
A street segment that lies in a piece of sub-district S is S's child.

### Continuation

After a cut is accepted in piece P, for each end on a road of category C or L laid by the blocks
stage (border collectors included; not an arterial, not open land):

1. Step across the road along the cut's end direction (road width + 1 m) to a point e′. The
   piece still in the queue that contains e′ is Q (none, or a finished block: stop).
2. Candidates in Q, best first: traced along Q's field from e′ with the arriving heading, then
   the straight chord from e′ in that direction. Each runs from e′ to where it leaves Q.
3. Accepted by **Q's rules**, as any cut of Q (ends, angles with square stubs, kinks, grade, lot
   size, solidity, squareness, collector side widths), except that Q needn't be due for a cut by
   its own plan, as long as it isn't small enough to be a block already (it has a plan).
4. The near end must line up with the cut it continues: within half a road width of e′ after
   any square stub, and the turn across the road under 30°.
5. If accepted, Q is cut, and the far end continues likewise. Repeat until refused.

**Category:** a collector continues as a collector where Q allows one (long side over its
collector spacing, sides wide enough), else as a local road; a local road continues as a local
road. Never upgraded. **Crossing an arterial:** collectors only (into the next superblock's
piece), subject to the arterial's junction spacing; local roads stop at arterials.

Each accepted segment is its own street record (`streets[]`), with a `route` id shared by the
chain (the first segment's id).

### Junction spacing

A junction registry, per road (arterial id or street id): the points where streets meet it. A
candidate end at point p on road R, with the nearest existing junction on R at distance d:

- d ≤ half R's width + 1 m: a **crossing** of that junction: no new junction, no cost.
- otherwise, if d < minSpacing(R): cost `(minSpacing − d) × JUNCTION_COST` added to the
  candidate's score (metres, like the edge-run cost; `JUNCTION_COST` 2 to start, so a near miss
  is worse than an open end).

minSpacing by R's category, at the step where p lies:

| R | minimum junction spacing |
|---|---|
| arterial | 0.75 × collector spacing (300 m at step 9, 675 m at step 1) |
| collector | 0.75 × block length (120 m at step 9, 375 m at step 1) |
| local | 0.5 × block depth (35 m at step 9, 75 m at step 1) |

It replaces `ARTERIAL_COST` (a local road's end on an arterial): the arterial's spacing does that
job now, for every category. A penalty, not a rule, so a piece with no alternative is still cut
(a big leftover block is worse than a close junction); the stats count violations.

### Stats

`blockStats` gains `continued` (segments added by continuation), `routes`, `junctionsClose`
(accepted ends within the minimum spacing), `crossings`.

## Left to the builder

- Registry representation (the `RoadIndex` can return the road; junction points per road id in a
  map are enough).
- How the queue keeps "largest first" cheap with continuation cutting pieces out of order.
- Whether a refused continuation is retried when Q comes up in the queue (not required).

## Open, for the owner's eyes once rendered

- The spacing table and `JUNCTION_COST`.
- Whether continuation should also be tried at a cut's open ends' opposite side (water): no, for
  now.
